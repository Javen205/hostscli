import { readFile } from 'node:fs/promises';
import { InvalidInputError } from '../errors';
import type { Profile, ProfileEntry } from '../profiles/store';
import {
  createProfile,
  deleteProfile,
  listProfileIds,
  profilePath,
  readProfile,
  writeProfile,
} from '../profiles/store';
import { buildRenderPlan } from './plan';
import { commitPlan } from './commit';
import { loadHostsDocument, withWorkspace } from './context';
import type { Workspace, WorkspaceOptions } from './context';
import { entryIdFor, resolveActiveLayers } from './layers';
import { prepare } from './crud';
import { currentOperator, recordAuditFailure } from './audit';
import { auditAuxWrite, logRuntime } from './aux-write';
import { hashBytes, readStateRaw, recordOperation, restoreFile } from './history';
import type {
  ProfileCreateOptions,
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
