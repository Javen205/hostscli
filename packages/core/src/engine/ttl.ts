import {
  CancelledError,
  EntryNotFoundError,
  ExternalEntryError,
  InvalidInputError,
} from '../errors';
import { normalizeHostname } from '../hosts/models';
import type { Profile, ProfileEntry } from '../profiles/store';
import { collectTtlKeys, entryIdFor } from './layers';
import { resolveActiveLayers } from './layers';
import { buildRenderPlan, sha256Buffer } from './plan';
import { commitPlan } from './commit';
import type { Workspace, WorkspaceOptions } from './context';
import { loadHostsDocument, withWorkspace } from './context';
import type { TtlRecord } from '../storage/state';
import { saveState } from '../storage/state';
import type {
  DisableForOptions,
  MutationResult,
  ReconcileResult,
  TtlExtendOptions,
  TtlListResult,
  TtlOptions,
  TtlView,
} from './types';
import { formatRemaining, parseDuration } from '../ttl/duration';

function findEntry(profiles: Profile[], layerId: string, entryId: string): ProfileEntry | null {
  const profile = profiles.find((candidate) => candidate.id === layerId);
  if (!profile) return null;
  return profile.entries.find((entry) => entryIdFor(profile.id, entry) === entryId) ?? null;
}

interface Target {
  record: TtlRecord;
  profile: Profile;
  entry: ProfileEntry;
}

async function resolveTargets(
  workspace: Workspace,
  hostname: string,
  layerId: string | undefined,
): Promise<{ targets: Target[]; active: Profile[]; externalOnly: boolean }> {
  const loaded = await loadHostsDocument(workspace, false);
  const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: false });
  const key = normalizeHostname(hostname);
  const targets: Target[] = [];

  for (const profile of profiles) {
    if (layerId && profile.id !== layerId) continue;
    for (const entry of profile.entries) {
      if (!entry.hostnames.some((name) => normalizeHostname(name) === key)) continue;
      const entryId = entryIdFor(profile.id, entry);
      const record = workspace.state.ttl.find(
        (candidate) => candidate.layerId === profile.id && candidate.entryId === entryId,
      );
      if (record) targets.push({ record, profile, entry });
    }
  }

  const externalOnly =
    targets.length === 0 &&
    loaded.document.entries.some(
      (entry) =>
        entry.source === 'external' &&
        entry.hostnames.some((name) => normalizeHostname(name) === key),
    );

  return { targets, active: profiles, externalOnly };
}

/** 惰性结算：任意命令启动时恢复已到期的 TTL。 */
export async function reconcileTtls(
  workspace: Workspace,
  options: { write?: boolean; throwOnFailure?: boolean } = {},
): Promise<ReconcileResult> {
  const warnings: string[] = [];
  const restored: ReconcileResult['restored'] = [];
  if (workspace.state.ttl.length === 0) {
    return { changed: false, restored, warnings };
  }

  const loaded = await loadHostsDocument(workspace, true);
  const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: false });
  const currentHash = loaded.raw ? sha256Buffer(loaded.raw) : null;
  const activeIds = new Set(profiles.map((profile) => profile.id));
  const now = workspace.now.getTime();
  const due: TtlRecord[] = [];
  const removable: TtlRecord[] = [];
  let stateChanged = false;

  for (const record of workspace.state.ttl) {
    const entry = findEntry(profiles, record.layerId, record.entryId);
    const layerActive = activeIds.has(record.layerId);

    // 层未启用：记录不影响渲染；到期后直接清理。
    if (!layerActive) {
      if (Date.parse(record.expiresAt) <= now && !record.paused) removable.push(record);
      continue;
    }

    if (!entry) {
      removable.push(record);
      warnings.push(`TTL 记录对应条目已不存在（${record.hostname}），已清理该记录。`);
      continue;
    }

    if (record.paused) continue;
    if (Date.parse(record.expiresAt) > now) continue;

    // 托管区被外部修改时，按方案要求转为 pending，等待人工 ttl resolve。
    if (record.planHash && currentHash && record.planHash !== currentHash) {
      if (record.status !== 'pending' || record.pendingReason !== 'external-modified') {
        record.status = 'pending';
        record.pendingReason = 'external-modified';
        stateChanged = true;
      }
      warnings.push(
        `TTL 到期但托管区已被外部修改（${record.hostname}），暂不覆盖；执行 hostscli ttl resolve ${record.hostname} 可强制恢复。`,
      );
      continue;
    }

    due.push(record);
  }

  if (removable.length > 0) {
    workspace.state.ttl = workspace.state.ttl.filter((record) => !removable.includes(record));
    stateChanged = true;
  }

  if (due.length === 0) {
    if (stateChanged && !workspace.dryRun) {
      await commitStateOnly(workspace, 'ttl reconcile');
    }
    return { changed: stateChanged, restored, warnings };
  }

  if (workspace.dryRun || options.write === false) {
    warnings.push(`有 ${due.length} 条 TTL 已到期，将在下一次实际命令中恢复。`);
    return { changed: stateChanged, restored, warnings };
  }

  const previousTtl = workspace.state.ttl;
  const dueKeys = new Set(due.map((record) => `${record.layerId}\u0000${record.entryId}`));
  workspace.state.ttl = previousTtl.filter(
    (record) => !dueKeys.has(`${record.layerId}\u0000${record.entryId}`),
  );

  const plan = buildRenderPlan(workspace, loaded, profiles, {
    appendIfMissing: loaded.document.managedRange !== null,
  });

  try {
    const result = await commitPlan(workspace, plan, {
      persistState: true,
      command: 'ttl tick',
    });
    for (const record of due) {
      restored.push({ hostname: record.hostname, layerId: record.layerId });
    }
    warnings.push(...result.warnings);
    return { changed: result.changed || stateChanged, restored, warnings };
  } catch (error) {
    workspace.state.ttl = previousTtl;
    for (const record of due) {
      record.status = 'pending';
      record.pendingReason = 'write-failed';
    }
    if (!workspace.dryRun) {
      await saveState(workspace.paths.statePath, workspace.state).catch(() => undefined);
    }
    warnings.push(
      `TTL 到期但写回失败（${(error as Error).message}），记录保留为 pending，下次命令会重试。`,
    );
    if (options.throwOnFailure) throw error;
    return { changed: stateChanged, restored, warnings };
  }
}

function toView(record: TtlRecord, profiles: Profile[], now: Date): TtlView {
  const profile = profiles.find((candidate) => candidate.id === record.layerId);
  const entry = profile
    ? profile.entries.find((candidate) => entryIdFor(profile.id, candidate) === record.entryId)
    : undefined;
  const remainingMs = record.paused
    ? (record.remainingMs ?? Math.max(0, Date.parse(record.expiresAt) - now.getTime()))
    : Math.max(0, Date.parse(record.expiresAt) - now.getTime());

  return {
    record,
    hostnames: entry?.hostnames ?? [record.hostname],
    ip: entry?.ip ?? null,
    remainingMs,
    profileFound: Boolean(entry),
  };
}

async function listTtlInWorkspace(
  workspace: Workspace,
  options: { withinMs?: number } = {},
): Promise<TtlListResult> {
  await reconcileTtls(workspace);
  const loaded = await loadHostsDocument(workspace, true);
  const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: false });
  const now = workspace.now;
  let records = workspace.state.ttl.map((record) => toView(record, profiles, now));

  if (options.withinMs !== undefined) {
    const limit = options.withinMs;
    records = records.filter(
      (view) => view.record.status === 'pending' || view.remainingMs <= limit,
    );
  }

  records.sort((a, b) => Date.parse(a.record.expiresAt) - Date.parse(b.record.expiresAt));
  return { now: now.toISOString(), records };
}

async function findRecordOrThrow(
  workspace: Workspace,
  hostname: string,
  layerId: string | undefined,
  action: string,
): Promise<Target> {
  const { targets, externalOnly } = await resolveTargets(workspace, hostname, layerId);

  if (targets.length === 0) {
    if (externalOnly) {
      throw new ExternalEntryError(
        `主机名只出现在非托管行中，hostscli 不会修改非托管内容：${hostname}`,
      );
    }
    throw new EntryNotFoundError(`找不到 ${hostname} 的 TTL 记录（无法${action}）。`);
  }
  if (targets.length > 1) {
    throw new InvalidInputError(
      `主机名 ${hostname} 在多个层中都有 TTL 记录，请用 --layer 指定层。`,
    );
  }
  return targets[0] as Target;
}

/**
 * 只改 state 的 TTL 操作也走统一提交，以便留下审计与 undo 历史；
 * 渲染结果与当前 hosts 一致时不会触碰 hosts 文件。
 */
async function commitStateOnly(workspace: Workspace, command: string): Promise<void> {
  const loaded = await loadHostsDocument(workspace, false);
  const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: false });
  const plan = buildRenderPlan(workspace, loaded, profiles);
  await commitPlan(workspace, plan, { command, persistState: true });
}

async function pauseTtlInWorkspace(
  workspace: Workspace,
  hostname: string,
  layerId?: string,
): Promise<TtlRecord> {
  const target = await findRecordOrThrow(workspace, hostname, layerId, '暂停');
  if (target.record.paused) throw new InvalidInputError(`TTL 已处于暂停状态：${hostname}`);
  target.record.remainingMs = Math.max(
    0,
    Date.parse(target.record.expiresAt) - workspace.now.getTime(),
  );
  target.record.paused = true;
  await commitStateOnly(workspace, 'ttl pause');
  return target.record;
}

async function resumeTtlInWorkspace(
  workspace: Workspace,
  hostname: string,
  layerId?: string,
): Promise<TtlRecord> {
  const target = await findRecordOrThrow(workspace, hostname, layerId, '恢复倒计时');
  if (!target.record.paused) throw new InvalidInputError(`TTL 未处于暂停状态：${hostname}`);
  const remaining = target.record.remainingMs ?? 0;
  target.record.expiresAt = new Date(workspace.now.getTime() + remaining).toISOString();
  target.record.paused = false;
  delete target.record.remainingMs;
  target.record.status = 'active';
  delete target.record.pendingReason;
  await commitStateOnly(workspace, 'ttl resume');
  return target.record;
}

async function extendTtlInWorkspace(
  workspace: Workspace,
  hostname: string,
  duration: string,
  layerId?: string,
): Promise<TtlRecord> {
  const ms = parseDuration(duration);
  const target = await findRecordOrThrow(workspace, hostname, layerId, '续期');
  if (target.record.paused) {
    target.record.remainingMs = ms;
  } else {
    target.record.expiresAt = new Date(workspace.now.getTime() + ms).toISOString();
  }
  target.record.status = 'active';
  delete target.record.pendingReason;
  await commitStateOnly(workspace, 'ttl extend');
  return target.record;
}

async function restoreTtlInWorkspace(
  workspace: Workspace,
  hostname: string,
  layerId?: string,
): Promise<MutationResult> {
  const target = await findRecordOrThrow(workspace, hostname, layerId, '立即恢复');
  return removeTtlAndApply(workspace, target, true);
}

async function cancelTtlInWorkspace(
  workspace: Workspace,
  hostname: string,
  layerId?: string,
): Promise<MutationResult> {
  const target = await findRecordOrThrow(workspace, hostname, layerId, '取消 TTL');
  return removeTtlAndApply(workspace, target, false);
}

async function removeTtlAndApply(
  workspace: Workspace,
  target: Target,
  enable: boolean,
): Promise<MutationResult> {
  const loaded = await loadHostsDocument(workspace, false);
  const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
  const profile =
    profiles.find((candidate) => candidate.id === target.profile.id) ?? target.profile;

  workspace.state.ttl = workspace.state.ttl.filter(
    (record) =>
      !(record.layerId === target.record.layerId && record.entryId === target.record.entryId),
  );

  if (!enable) {
    const entry = profile.entries.find(
      (candidate) => entryIdFor(profile.id, candidate) === target.record.entryId,
    );
    if (entry) entry.enabled = false;
  }

  const plan = buildRenderPlan(workspace, loaded, profiles, {
    appendIfMissing: loaded.document.managedRange !== null,
  });

  if (workspace.dryRun) {
    return {
      changed: plan.changed,
      backupPath: null,
      affected: [],
      diff: plan.diff,
      planHash: null,
      warnings: [],
    };
  }

  const affected = enable
    ? profile.entries
        .filter((entry) => entryIdFor(profile.id, entry) === target.record.entryId)
        .map((entry) => ({
          id: target.record.entryId,
          ip: entry.ip,
          hostnames: entry.hostnames,
          enabled: true,
          layerId: profile.id,
          source: 'managed' as const,
          ...(entry.comment ? { comment: entry.comment } : {}),
        }))
    : [];

  return commitPlan(workspace, plan, { profiles, persistState: true, affected });
}

export interface DisableForResult extends MutationResult {
  record: TtlRecord;
}

/**
 * 单条 TTL 定时禁用。按方案 2.3 的数据流：先写 hosts，再落账 state。
 * 这样即使进程在写入前被 kill，只会出现"文件里的条目还没禁用且没有 TTL 记录"，
 * 不会出现"state 说有 TTL、文件里条目仍启用"这种下次渲染会静默删除用户规则的窗口。
 */
async function disableForInWorkspace(
  workspace: Workspace,
  options: {
    hostnames: string[];
    duration: string;
    reason?: string;
    layerId?: string;
    yes?: boolean;
    warnThresholdMs: number;
    confirmLong?: () => Promise<boolean>;
  },
): Promise<DisableForResult> {
  const requestedKeys = new Set(options.hostnames.map(normalizeHostname));
  if (requestedKeys.size !== 1) {
    throw new InvalidInputError(
      'TTL 设置一次只接受一条记录（一个主机名）；请按主机名分次执行，避免部分成功。',
    );
  }
  const ms = parseDuration(options.duration);
  if (ms > options.warnThresholdMs && !options.yes) {
    if (!options.confirmLong) {
      throw new CancelledError(
        `时长 ${options.duration} 超过 ${formatRemaining(options.warnThresholdMs)}，请加 --yes 确认后再执行。`,
      );
    }
    const confirmed = await options.confirmLong();
    if (!confirmed) throw new CancelledError('已取消 TTL 设置。');
  }

  const loaded = await loadHostsDocument(workspace, false);
  const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
  const keySet = new Set(options.hostnames.map(normalizeHostname));
  const matches: Array<{ profile: Profile; entry: ProfileEntry }> = [];

  for (const profile of profiles) {
    if (options.layerId && profile.id !== options.layerId) continue;
    for (const entry of profile.entries) {
      if (entry.hostnames.some((name) => keySet.has(normalizeHostname(name)))) {
        matches.push({ profile, entry });
      }
    }
  }

  if (matches.length === 0) {
    const external = loaded.document.entries.some(
      (entry) =>
        entry.source === 'external' &&
        entry.hostnames.some((name) => keySet.has(normalizeHostname(name))),
    );
    if (external) {
      throw new ExternalEntryError(
        `主机名只出现在非托管行中，hostscli 不会修改非托管内容：${options.hostnames.join(', ')}`,
      );
    }
    throw new EntryNotFoundError(`托管规则中找不到主机名：${options.hostnames.join(', ')}`);
  }

  if (!options.layerId && new Set(matches.map((match) => match.profile.id)).size > 1) {
    throw new InvalidInputError('主机名在多个层中命中，请用 --layer 指定层。');
  }

  const target = matches[0];
  if (!target)
    throw new EntryNotFoundError(`托管规则中找不到主机名：${options.hostnames.join(', ')}`);
  if (!target.entry.enabled) {
    throw new InvalidInputError(`条目已是禁用状态，无需设置 TTL：${options.hostnames.join(', ')}`);
  }

  const entryId = entryIdFor(target.profile.id, target.entry);
  if (
    workspace.state.ttl.some(
      (record) => record.layerId === target.profile.id && record.entryId === entryId,
    )
  ) {
    throw new InvalidInputError(
      `条目已有 TTL，请使用 ttl extend / ttl restore：${options.hostnames.join(', ')}`,
    );
  }

  const record: TtlRecord = {
    entryId,
    layerId: target.profile.id,
    hostname: target.entry.hostnames[0] ?? options.hostnames[0] ?? '',
    disabledAt: workspace.now.toISOString(),
    expiresAt: new Date(workspace.now.getTime() + ms).toISOString(),
    prevEnabled: true,
    paused: false,
    status: 'active',
    planHash: '',
  };
  if (options.reason) record.reason = options.reason;

  workspace.state.ttl.push(record);

  const requested = new Set(options.hostnames.map(normalizeHostname));
  const extra = target.entry.hostnames.filter((name) => !requested.has(normalizeHostname(name)));
  const scopeWarnings =
    extra.length > 0 ? [`操作按整条记录生效，同时影响：${extra.join(', ')}`] : [];

  const plan = buildRenderPlan(workspace, loaded, profiles, {
    appendIfMissing: loaded.document.managedRange !== null,
  });

  if (workspace.dryRun) {
    return {
      changed: plan.changed,
      backupPath: null,
      affected: [],
      diff: plan.diff,
      planHash: null,
      warnings: scopeWarnings,
      record,
    };
  }

  record.planHash = plan.planHash;

  try {
    const result = await commitPlan(workspace, plan, { persistState: true });
    return { ...result, record, warnings: [...result.warnings, ...scopeWarnings] };
  } catch (error) {
    workspace.state.ttl = workspace.state.ttl.filter((candidate) => candidate !== record);
    await saveState(workspace.paths.statePath, workspace.state).catch(() => undefined);
    throw error;
  }
}

// ---- 公共 API：对外只暴露带 WorkspaceOptions 的版本，内部仍复用 workspace。 ----

export async function listTtl(
  options: WorkspaceOptions & { within?: string } = {},
): Promise<TtlListResult> {
  const withinMs = options.within ? parseDuration(options.within) : undefined;
  return withWorkspace(options, (workspace) =>
    listTtlInWorkspace(workspace, {
      ...(withinMs !== undefined ? { withinMs } : {}),
    }),
  );
}

export async function pauseTtl(options: TtlOptions): Promise<TtlRecord> {
  return withWorkspace(options, (workspace) =>
    pauseTtlInWorkspace(workspace, options.hostname, options.layerId),
  );
}

export async function resumeTtl(options: TtlOptions): Promise<TtlRecord> {
  return withWorkspace(options, (workspace) =>
    resumeTtlInWorkspace(workspace, options.hostname, options.layerId),
  );
}

export async function extendTtl(options: TtlExtendOptions): Promise<TtlRecord> {
  return withWorkspace(options, (workspace) =>
    extendTtlInWorkspace(workspace, options.hostname, options.duration, options.layerId),
  );
}

export async function restoreTtl(options: TtlOptions): Promise<MutationResult> {
  return withWorkspace(options, (workspace) =>
    restoreTtlInWorkspace(workspace, options.hostname, options.layerId),
  );
}

export async function cancelTtl(options: TtlOptions): Promise<MutationResult> {
  return withWorkspace(options, (workspace) =>
    cancelTtlInWorkspace(workspace, options.hostname, options.layerId),
  );
}

export async function tickTtl(options: WorkspaceOptions = {}): Promise<ReconcileResult> {
  return withWorkspace(options, (workspace) => reconcileTtls(workspace, { throwOnFailure: true }));
}

export async function disableFor(options: DisableForOptions): Promise<DisableForResult> {
  return withWorkspace(options, (workspace) =>
    disableForInWorkspace(workspace, {
      hostnames: options.hostnames,
      duration: options.for,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.layerId !== undefined ? { layerId: options.layerId } : {}),
      yes: options.yes,
      warnThresholdMs: parseDuration(workspace.config.defaults.ttlWarnThreshold),
    }),
  );
}

export { collectTtlKeys };
