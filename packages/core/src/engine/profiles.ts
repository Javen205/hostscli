import { readFile, unlink } from 'node:fs/promises';
import { DuplicateEntryError, EntryNotFoundError, InvalidInputError } from '../errors';
import { normalizeHostname } from '../hosts/models';
import type { Profile, ProfileEntry } from '../profiles/store';
import {
  createProfile,
  deleteProfile,
  listProfileIds,
  profilePath,
  readProfile,
  validateProfile,
  writeProfile,
} from '../profiles/store';
import { saveState } from '../storage/state';
import { atomicWriteFile } from '../system/atomic-write';
import { buildRenderPlan } from './plan';
import { commitPlan } from './commit';
import { loadHostsDocument, withWorkspace } from './context';
import type { Workspace, WorkspaceOptions } from './context';
import { entryIdFor, resolveActiveLayers } from './layers';
import { prepare } from './crud';
import { appendAudit, currentOperator, recordAuditFailure } from './audit';
import { auditAuxWrite, logRuntime } from './aux-write';
import { hashBytes, readStateRaw, recordOperation, restoreFile } from './history';
import type {
  ProfileCreateOptions,
  ProfileMoveOptions,
  ProfileMoveResult,
  ProfileSaveOptions,
  ProfileUseOptions,
  ProfileView,
  UseProfileResult,
} from './types';

// 子路径入口面向 CLI：把展示所需的轻量工具与类型一并再导出。
export { profileEntriesToHostEntries } from '../profiles/store';
export type {
  CreateProfileOptions,
  Profile,
  ProfileEntry,
  ProfileSource,
  WriteProfileOptions,
} from '../profiles/store';

export async function listProfiles(
  options: WorkspaceOptions = {},
): Promise<{ activeLayers: string[]; profiles: ProfileView[] }> {
  return withWorkspace(options, async (workspace) => {
    const ids = await listProfileIds(workspace.paths.profilesDir);
    const profiles = await Promise.all(
      ids.map((id) => readProfile(workspace.paths.profilesDir, id)),
    );
    return {
      activeLayers: workspace.state.activeLayers,
      profiles: profiles.map((profile) => ({
        profile,
        active: workspace.state.activeLayers.includes(profile.id),
        entryCount: profile.entries.length,
      })),
    };
  });
}

export async function showProfile(id: string, options: WorkspaceOptions = {}): Promise<Profile> {
  return withWorkspace(options, (workspace) => readProfile(workspace.paths.profilesDir, id));
}

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * profile create/remove 不经过 commitPlan，但同样需要 undo 历史。
 * 快照必须同时包含 hosts、state 与目标方案文件：只还原 hosts 会留下
 * "方案已恢复、启用状态未恢复"或反向的半套状态。
 */
async function recordProfileHistory(input: {
  workspace: Workspace;
  id: string;
  before: Buffer | null;
  after: Buffer | null;
  command: string;
  args: string[];
}): Promise<void> {
  const { workspace } = input;
  const hostsRaw = await readFileOrNull(workspace.hostsPath);
  const stateRaw = await readStateRaw(workspace.paths.statePath);
  try {
    await recordOperation({
      dataDir: workspace.dataDir,
      hostsPath: workspace.hostsPath,
      command: input.command,
      args: input.args,
      planHash: null,
      keep: workspace.config.defaults.historyKeep,
      beforeHosts: hostsRaw,
      afterHosts: hostsRaw,
      beforeStateRaw: stateRaw,
      afterStateRaw: stateRaw,
      beforeProfiles: new Map([[input.id, input.before]]),
      afterProfiles: new Map([[input.id, input.after]]),
      // hosts 没有变化，摘要只需要方案侧的 enabled 翻转；这里不解析 hosts。
      hostsBefore: [],
      hostsAfter: [],
      stateBefore: workspace.state,
      stateAfter: workspace.state,
      operator: currentOperator(),
      now: workspace.now,
    });
  } catch (error) {
    await recordAuditFailure(workspace.dataDir, {
      at: workspace.now.toISOString(),
      command: input.command,
      detail: `history: ${String(error)}`,
    });
    await logRuntime(workspace, {
      level: 'warn',
      command: input.command,
      event: 'history-failure',
      detail: String(error),
    });
  }
}

export async function createProfileFromCurrent(options: ProfileCreateOptions): Promise<Profile> {
  return withWorkspace(options, async (workspace) => {
    const loaded = await loadHostsDocument(workspace, true);
    const entries: ProfileEntry[] = options.fromCurrent
      ? loaded.document.entries
          .filter((entry) => entry.source === 'managed')
          .map((entry) => ({
            ip: entry.ip,
            hostnames: entry.hostnames,
            enabled: entry.enabled,
            ...(entry.comment ? { comment: entry.comment } : {}),
          }))
      : [];

    const profile = await createProfile(workspace.paths.profilesDir, {
      id: options.id,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      entries,
    });

    const after = await readFileOrNull(profilePath(workspace.paths.profilesDir, profile.id));
    await recordProfileHistory({
      workspace,
      id: profile.id,
      before: null,
      after,
      command: 'profile create',
      args: [profile.id, ...(options.fromCurrent ? ['--from-current'] : [])],
    });
    await auditAuxWrite(workspace, {
      command: 'profile create',
      args: [profile.id, ...(options.fromCurrent ? ['--from-current'] : [])],
      beforeSha256: null,
      afterSha256: hashBytes(after),
      detail: `创建方案 ${profile.id}（${profile.entries.length} 条）。`,
    });
    return profile;
  });
}

/** 切换方案：activeLayers 只保留目标方案，并立即重建托管区块（阶段 2 语义）。 */
export async function useProfile(options: ProfileUseOptions): Promise<UseProfileResult> {
  return withWorkspace(options, async (workspace) => {
    await readProfile(workspace.paths.profilesDir, options.id);
    const { loaded, warnings } = await prepare(workspace);

    const switched = !(
      workspace.state.activeLayers.length === 1 && workspace.state.activeLayers[0] === options.id
    );
    workspace.state.activeLayers = [options.id];
    workspace.state.initialized = true;
    const profiles = [await readProfile(workspace.paths.profilesDir, options.id)];
    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: true,
      onConflict: options.onConflict,
    });

    const result = await commitPlan(workspace, plan, { persistState: true, warnings });
    return { ...result, switched };
  });
}

export async function removeProfile(id: string, options: WorkspaceOptions = {}): Promise<void> {
  await withWorkspace(options, async (workspace) => {
    if (workspace.state.activeLayers.includes(id)) {
      throw new InvalidInputError(
        `方案 ${id} 正在生效，不能删除。请先切换到其他方案，例如 hostscli profile use default。`,
      );
    }
    const before = await readFileOrNull(profilePath(workspace.paths.profilesDir, id));
    await deleteProfile(workspace.paths.profilesDir, id);
    await recordProfileHistory({
      workspace,
      id,
      before,
      after: null,
      command: 'profile remove',
      args: [id],
    });
    await auditAuxWrite(workspace, {
      command: 'profile remove',
      args: [id],
      beforeSha256: hashBytes(before),
      afterSha256: null,
      detail: `删除方案 ${id}。`,
    });
  });
}

/** 把当前托管区块保存为方案内容（更新操作）。 */
export async function saveProfileFromCurrent(options: ProfileSaveOptions): Promise<Profile> {
  return withWorkspace(options, async (workspace) => {
    const profile = await readProfile(workspace.paths.profilesDir, options.id);
    const { loaded, warnings } = await prepare(workspace);
    const managedEntries: ProfileEntry[] = loaded.document.entries
      .filter((entry) => entry.source === 'managed')
      .map((entry) => ({
        ip: entry.ip,
        hostnames: entry.hostnames,
        enabled: entry.enabled,
        ...(entry.comment ? { comment: entry.comment } : {}),
      }));

    // 托管区只包含“当前可见”的条目；已禁用、被 TTL 临时隐藏的条目不在其中。
    // 默认保留这些条目，避免 profile save 静默丢数据；--prune 才显式删除。
    const visibleIds = new Set(managedEntries.map((entry) => entryIdFor(options.id, entry)));
    const preserved: ProfileEntry[] = [];
    if (!options.prune) {
      const ttlHidden = new Set(
        workspace.state.ttl
          .filter((record) => record.layerId === options.id)
          .map((record) => record.entryId),
      );
      for (const entry of profile.entries) {
        const entryId = entryIdFor(options.id, entry);
        if (visibleIds.has(entryId)) continue;
        if (!entry.enabled || ttlHidden.has(entryId)) preserved.push(entry);
      }
    }
    profile.entries = [...managedEntries, ...preserved];

    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
    if (profiles.length !== 1 || profiles[0]?.id !== options.id) {
      const active = profiles.map((candidate) => candidate.id).join(', ') || '无';
      throw new InvalidInputError(
        `profile save 只能在“仅启用一个层且目标就是该层”时使用；` +
          `当前启用层：${active}，目标：${options.id}。`,
      );
    }
    const target = profiles[0] as Profile;
    target.entries = profile.entries;

    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: loaded.document.managedRange !== null,
    });
    await commitPlan(workspace, plan, {
      profiles: [target],
      persistState: true,
      warnings,
    });
    return target;
  });
}

/** 更新方案元信息（名称 / 优先级）。纯元数据变更只记审计，不进入 undo 栈。 */
export async function updateProfileMeta(
  id: string,
  changes: { name?: string; priority?: number },
  options: WorkspaceOptions = {},
): Promise<Profile> {
  return withWorkspace(options, async (workspace) => {
    const profile = await readProfile(workspace.paths.profilesDir, id);
    const beforeName = profile.name;
    const beforePriority = profile.priority;
    if (changes.name !== undefined) {
      if (changes.name.trim() === '') {
        throw new InvalidInputError('方案名称不能为空。');
      }
      profile.name = changes.name;
    }
    if (changes.priority !== undefined && !Number.isInteger(changes.priority)) {
      throw new InvalidInputError(`方案优先级必须是整数，收到：${changes.priority}`);
    }
    if (changes.priority !== undefined) profile.priority = changes.priority;

    const path = profilePath(workspace.paths.profilesDir, id);
    const before = await readFileOrNull(path);
    // 元信息更新同样复用 profileSchema，禁止用 trusted 绕过字段校验。
    const updated = await writeProfile(workspace.paths.profilesDir, profile);

    if (workspace.state.activeLayers.includes(id)) {
      const loaded = await loadHostsDocument(workspace, true);
      const { profiles } = await resolveActiveLayers(workspace, loaded.document, {
        persist: false,
      });
      const plan = buildRenderPlan(workspace, loaded, profiles, {
        appendIfMissing: loaded.document.managedRange !== null,
      });
      try {
        await commitPlan(workspace, plan, { persistState: true });
      } catch (error) {
        // hosts 重建失败时把方案文件也恢复原状：否则命令报错、但磁盘上的
        // 元信息已被改写，下一次 apply 会带着未确认的改动生效。
        await restoreFile(path, before).catch(() => undefined);
        throw error;
      }
    }

    const after = await readFileOrNull(path);
    const changed = beforeName !== profile.name || beforePriority !== profile.priority;
    const parts: string[] = [];
    if (beforeName !== profile.name) parts.push(`名称 ${beforeName} → ${profile.name}`);
    if (beforePriority !== profile.priority) {
      parts.push(`优先级 ${beforePriority} → ${profile.priority}`);
    }
    await auditAuxWrite(workspace, {
      command: 'profile update',
      args: [id],
      beforeSha256: hashBytes(before),
      afterSha256: hashBytes(after),
      changed,
      detail:
        parts.length > 0 ? `更新方案 ${id}：${parts.join('；')}。` : `方案 ${id} 元信息无变化。`,
    });
    return updated;
  });
}

/**
 * 只写方案文件与 state、不重建 hosts 的提交路径。
 * 用于"源与目标方案都未生效"的迁移：此时 hosts 不应因迁移而变化，
 * 但仍要留下 undo 快照与审计记录。
 */
async function persistMovedProfiles(
  workspace: Workspace,
  profiles: Profile[],
  meta: { args: string[]; detail: string },
): Promise<string[]> {
  const warnings: string[] = [];
  const snapshots = new Map<string, Buffer | null>();
  for (const profile of profiles) {
    const path = profilePath(workspace.paths.profilesDir, profile.id);
    snapshots.set(path, await readFileOrNull(path));
  }
  const beforeHosts = await readFileOrNull(workspace.hostsPath);
  const beforeStateRaw = await readStateRaw(workspace.paths.statePath);

  try {
    for (const profile of profiles) {
      await writeProfile(workspace.paths.profilesDir, profile, { trusted: true });
    }
    await saveState(workspace.paths.statePath, workspace.state);
  } catch (error) {
    // 两个方案文件必须同进同退，否则会留下"源方案已删、目标方案没加"的半套状态。
    for (const [path, previous] of snapshots) {
      if (previous === null) await unlink(path).catch(() => undefined);
      else await atomicWriteFile(path, previous).catch(() => undefined);
    }
    throw error;
  }

  const beforeProfiles = new Map<string, Buffer | null>();
  const afterProfiles = new Map<string, Buffer | null>();
  for (const profile of profiles) {
    const path = profilePath(workspace.paths.profilesDir, profile.id);
    beforeProfiles.set(profile.id, snapshots.get(path) ?? null);
    afterProfiles.set(profile.id, await readFileOrNull(path));
  }

  try {
    await recordOperation({
      dataDir: workspace.dataDir,
      hostsPath: workspace.hostsPath,
      command: 'profile move',
      args: meta.args,
      planHash: null,
      keep: workspace.config.defaults.historyKeep,
      beforeHosts,
      afterHosts: beforeHosts,
      beforeStateRaw,
      afterStateRaw: await readStateRaw(workspace.paths.statePath),
      beforeProfiles,
      afterProfiles,
      // hosts 没有变化，摘要只需要方案侧与 TTL 的变化。
      hostsBefore: [],
      hostsAfter: [],
      stateBefore: workspace.initialState,
      stateAfter: workspace.state,
      operator: currentOperator(),
      now: workspace.now,
    });
  } catch (error) {
    warnings.push(`迁移已完成，但 undo 历史记录失败：${String(error)}`);
    await recordAuditFailure(workspace.dataDir, {
      at: workspace.now.toISOString(),
      command: 'profile move',
      detail: `history: ${String(error)}`,
    });
    await logRuntime(workspace, {
      level: 'warn',
      command: 'profile move',
      event: 'history-failure',
      detail: String(error),
    });
  }

  await auditAuxWrite(
    workspace,
    {
      command: 'profile move',
      args: meta.args,
      beforeSha256: hashBytes(beforeHosts),
      afterSha256: hashBytes(beforeHosts),
      detail: meta.detail,
    },
    warnings,
  );
  return warnings;
}

async function moveProfileEntryInWorkspace(
  workspace: Workspace,
  options: ProfileMoveOptions,
): Promise<ProfileMoveResult> {
  if (options.from === options.to) {
    throw new InvalidInputError(`源方案与目标方案相同（${options.from}），无需迁移。`);
  }

  const key = normalizeHostname(options.hostname);
  const source = await readProfile(workspace.paths.profilesDir, options.from);
  const target = await readProfile(workspace.paths.profilesDir, options.to);

  const matches = source.entries.filter((entry) =>
    entry.hostnames.some((name) => normalizeHostname(name) === key),
  );
  if (matches.length === 0) {
    throw new EntryNotFoundError(`方案 ${options.from} 中找不到主机名：${options.hostname}`);
  }
  if (matches.length > 1) {
    throw new InvalidInputError(
      `方案 ${options.from} 中有 ${matches.length} 个条目包含 ${options.hostname}，` +
        '无法确定迁移哪一条；请先合并这些条目再迁移。',
    );
  }
  const moved = matches[0] as ProfileEntry;
  const movedKeys = new Set(moved.hostnames.map(normalizeHostname));

  const conflicting = target.entries.filter((entry) =>
    entry.hostnames.some((name) => movedKeys.has(normalizeHostname(name))),
  );
  if (conflicting.length > 0 && !options.force) {
    const names = new Set<string>();
    for (const entry of conflicting) {
      for (const name of entry.hostnames) {
        if (movedKeys.has(normalizeHostname(name))) names.add(name);
      }
    }
    const ips = [...new Set(conflicting.map((entry) => entry.ip))].join(' / ');
    throw new DuplicateEntryError(
      `方案 ${options.to} 已存在主机名 ${[...names].join(', ')}（当前映射到 ${ips}）。` +
        `如需覆盖，请加 --force：会把上述主机名从目标方案中移除并指向 ${moved.ip}` +
        '（目标条目里的其他主机名保留）。',
    );
  }

  const oldEntryId = entryIdFor(source.id, moved);
  const newEntryId = entryIdFor(target.id, moved);
  const replacedHostnames: string[] = [];
  let ttlRecords = 0;

  // 被覆盖的目标条目 ID 会失效，对应 TTL 记录必须清理，否则会变成指向不存在条目的孤儿。
  const dangling = new Set(conflicting.map((entry) => entryIdFor(target.id, entry)));
  if (dangling.size > 0) {
    workspace.state.ttl = workspace.state.ttl.filter(
      (record) => !(record.layerId === target.id && dangling.has(record.entryId)),
    );
  }

  source.entries = source.entries.filter((entry) => entry !== moved);

  if (conflicting.length > 0) {
    const kept: ProfileEntry[] = [];
    for (const entry of target.entries) {
      const hits = entry.hostnames.filter((name) => movedKeys.has(normalizeHostname(name)));
      if (hits.length === 0) {
        kept.push(entry);
        continue;
      }
      replacedHostnames.push(...hits);
      const remaining = entry.hostnames.filter((name) => !movedKeys.has(normalizeHostname(name)));
      // 整条主机名都被覆盖时目标条目不再有意义，直接丢弃。
      if (remaining.length > 0) kept.push({ ...entry, hostnames: remaining });
    }
    target.entries = kept;
  }
  target.entries.push(moved);

  // TTL 记录以 (layerId, entryId) 为键，entryId 含 layerId；
  // 换方案必须同步改写，否则 TTL 到期时找不到条目，会被当成脏记录清掉。
  for (const record of workspace.state.ttl) {
    if (record.layerId !== source.id || record.entryId !== oldEntryId) continue;
    record.layerId = target.id;
    record.entryId = newEntryId;
    ttlRecords += 1;
  }

  // 迁移后仍要过和读取时相同的语义校验（IP/主机名字面量、同层唯一性）：
  // --force 的合并可能制造新的重复，不能因为数据来自已校验文件就跳过。
  validateProfile(source, profilePath(workspace.paths.profilesDir, source.id));
  validateProfile(target, profilePath(workspace.paths.profilesDir, target.id));

  const args = [
    options.hostname,
    '--from',
    options.from,
    '--to',
    options.to,
    ...(options.force ? ['--force'] : []),
  ];
  const base = {
    from: source.id,
    to: target.id,
    hostname: options.hostname,
    movedIp: moved.ip,
    movedHostnames: [...moved.hostnames],
    ttlRecords,
    replacedHostnames,
    toActive: workspace.state.activeLayers.includes(target.id),
  };
  const detail =
    `迁移 ${moved.ip} -> ${moved.hostnames.join(', ')}：方案 ${source.id} → ${target.id}` +
    (ttlRecords > 0 ? `（TTL × ${ttlRecords}）` : '') +
    (replacedHostnames.length > 0 ? `（覆盖：${replacedHostnames.join(', ')}）` : '') +
    '。';

  const activeIds = new Set(workspace.state.activeLayers);
  if (!activeIds.has(source.id) && !activeIds.has(target.id)) {
    if (workspace.dryRun) {
      return {
        ...base,
        changed: false,
        backupPath: null,
        affected: [],
        diff: '',
        planHash: null,
        warnings: [],
      };
    }
    const warnings = await persistMovedProfiles(workspace, [source, target], { args, detail });
    return {
      ...base,
      changed: false,
      backupPath: null,
      affected: [],
      diff: '',
      planHash: null,
      warnings,
    };
  }

  // 至少一侧生效：用生效层重新渲染托管区块，迁移后的条目才能立刻体现到 hosts。
  const loaded = await loadHostsDocument(workspace, true);
  const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
  const activeProfiles = profiles.map((profile) =>
    profile.id === source.id ? source : profile.id === target.id ? target : profile,
  );
  const plan = buildRenderPlan(workspace, loaded, activeProfiles, {
    appendIfMissing: true,
    ...(options.onConflict !== undefined ? { onConflict: options.onConflict } : {}),
  });
  const result = await commitPlan(workspace, plan, {
    profiles: [source, target],
    persistState: true,
    command: 'profile move',
    args,
  });
  return { ...result, ...base };
}

/**
 * 把一个条目从 A 方案迁移到 B 方案（迁移而非"删了再建"）。
 *
 * 保留 ip / hostnames / comment / enabled / disabledReason，以及 state.json 中
 * 属于该条目的 TTL 记录；冲突策略见 ProfileMoveOptions.force。
 * 成功写入走 commitPlan（审计 + undo 历史），失败也会追加 move-failed 审计。
 */
export async function moveProfileEntry(options: ProfileMoveOptions): Promise<ProfileMoveResult> {
  return withWorkspace(options, async (workspace) => {
    try {
      return await moveProfileEntryInWorkspace(workspace, options);
    } catch (error) {
      // 失败也要留痕：dry-run 不写任何东西，因此跳过。
      if (!workspace.dryRun) {
        await appendAudit(
          workspace.paths.auditPath,
          {
            at: workspace.now.toISOString(),
            action: 'move-failed',
            ok: false,
            hostsPath: workspace.hostsPath,
            command: 'profile move',
            commandArgs: [options.hostname, '--from', options.from, '--to', options.to],
            operator: currentOperator(),
            detail: error instanceof Error ? error.message : String(error),
          },
          { keep: workspace.config.defaults.auditKeep },
        ).catch(() => undefined);
      }
      throw error;
    }
  });
}
