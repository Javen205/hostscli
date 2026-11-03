import { readFile, unlink } from 'node:fs/promises';
import { backupFile } from '../backup';
import { HostsCliError, PermissionError, VerificationError } from '../errors';
import type { HostEntry } from '../hosts/models';
import { atomicWriteFile } from '../system/atomic-write';
import { flushDns } from '../system/dns-flush';
import type { Profile } from '../profiles/store';
import { profilePath, writeProfile } from '../profiles/store';
import { saveState } from '../storage/state';
import { canWriteDirectly, permissionHint } from '../system/privilege';
import type { Workspace } from './context';
import { shouldFlushDns } from './context';
import type { RenderPlan } from './plan';
import { sha256Buffer } from './plan';
import type { MutationResult } from './types';
import { appendAudit, currentOperator, recordAuditFailure } from './audit';
import { hashBytes, readStateRaw, recordOperation, summarizeChange } from './history';
import { verifyManagedEntries } from './verify';

export interface CommitOptions {
  profiles?: Profile[];
  persistState?: boolean;
  affected?: HostEntry[];
  warnings?: string[];
  /** 显式覆盖本次是否刷新 DNS。 */
  dnsFlush?: boolean;
  /** 审计/历史记录中的命令名与关键参数。 */
  command?: string;
  args?: string[];
  /**
   * 提交成功后会被删除的方案文件。历史记录需要把它们的"写入后"指纹记为不存在，
   * 否则 undo 会以为文件被他人篡改而拒绝。
   */
  deleteProfiles?: string[];
}

async function readHostsOrNull(hostsPath: string): Promise<Buffer | null> {
  try {
    return await readFile(hostsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface ProfileSnapshot {
  path: string;
  previous: Buffer | null;
}

/**
 * 在写 hosts 之前先记录各方案文件的原始内容。
 * hosts 与方案/状态不是同一个文件，持久化中途失败时如果只回滚 hosts，
 * 方案里会留下“命令已报错、但内容已被改”的半成功状态；下一次 apply 会把
 * 这个未确认的改动真正写进 hosts。这里先快照，失败时一起回滚。
 */
async function snapshotProfiles(
  profiles: Profile[],
  profilesDir: string,
): Promise<ProfileSnapshot[]> {
  const snapshots: ProfileSnapshot[] = [];
  for (const profile of profiles) {
    const path = profilePath(profilesDir, profile.id);
    try {
      snapshots.push({ path, previous: await readFile(path) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      snapshots.push({ path, previous: null });
    }
  }
  return snapshots;
}

async function restoreProfiles(snapshots: ProfileSnapshot[]): Promise<boolean> {
  const results = await Promise.allSettled(
    snapshots.map(async ({ path, previous }) => {
      if (previous === null) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        return;
      }
      await atomicWriteFile(path, previous);
    }),
  );
  return results.every((result) => result.status === 'fulfilled');
}

/**
 * 回滚前确认磁盘上的内容仍是我们刚写入的内容。
 * 若已被其他进程改写，回滚就会覆盖他人的规则，因此直接放弃回滚。
 */
async function rollbackHosts(
  workspace: Workspace,
  previous: Buffer | null,
  expected: Buffer,
): Promise<boolean> {
  const current = await readHostsOrNull(workspace.hostsPath);
  if (current === null || !current.equals(expected)) return false;

  try {
    if (previous === null) {
      await unlink(workspace.hostsPath);
      return true;
    }
    await atomicWriteFile(workspace.hostsPath, previous);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 rename 前确认 hosts 仍是本次读取时的基线内容。
 * 乐观写（无锁编辑器/其他工具）可能在这期间改写文件，直接覆盖会丢失对方规则。
 */
async function assertBaseline(workspace: Workspace, baseline: Buffer | null): Promise<void> {
  const current = await readHostsOrNull(workspace.hostsPath);
  const unchanged =
    baseline === null ? current === null : current !== null && current.equals(baseline);
  if (!unchanged) {
    throw new HostsCliError(
      'CONFLICT',
      'hosts 文件在本次操作期间已被其他进程修改，已中止写入以避免覆盖他人改动；请重试。',
    );
  }
}

function resolveCommand(options: CommitOptions): string {
  const explicit = options.command?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.HOSTSCLI_COMMAND?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'write';
}

function resolveCommandArgs(options: CommitOptions): string[] | undefined {
  if (options.args && options.args.length > 0) return options.args;
  const raw = process.env.HOSTSCLI_COMMAND_ARGS;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed as string[];
    }
  } catch {
    // 环境变量损坏时忽略，不影响主操作。
  }
  return undefined;
}

interface ProfileLike {
  id: string;
  entries: Array<{ ip: string; hostnames: string[]; enabled: boolean }>;
}

function parseProfile(raw: Buffer | null): ProfileLike | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw.toString('utf8')) as ProfileLike;
    return typeof value.id === 'string' && Array.isArray(value.entries) ? value : null;
  } catch {
    return null;
  }
}

function summarizeCommit(
  workspace: Workspace,
  plan: RenderPlan,
  profilesRaw: Map<string, Buffer | null>,
): ReturnType<typeof summarizeChange> {
  const beforeProfiles = [...profilesRaw.values()]
    .map(parseProfile)
    .filter((profile): profile is ProfileLike => profile !== null);
  const afterProfiles = (plan.profiles ?? []).map((profile) => ({
    id: profile.id,
    entries: profile.entries.map((entry) => ({
      ip: entry.ip,
      hostnames: entry.hostnames,
      enabled: entry.enabled,
    })),
  }));
  return summarizeChange(
    {
      hosts: plan.loaded.document.entries
        .filter((entry) => entry.source === 'managed')
        .map((entry) => ({ ip: entry.ip, hostnames: entry.hostnames })),
      profiles: beforeProfiles,
      ttl: new Set(
        workspace.initialState.ttl.map((record) => `${record.layerId}\u0000${record.entryId}`),
      ),
    },
    {
      hosts: plan.merged.entries.map((entry) => ({ ip: entry.ip, hostnames: entry.hostnames })),
      profiles: afterProfiles,
      ttl: new Set(workspace.state.ttl.map((record) => `${record.layerId}\u0000${record.entryId}`)),
    },
  );
}

async function appendWriteAudit(
  workspace: Workspace,
  plan: RenderPlan,
  options: CommitOptions,
  profilesRaw: Map<string, Buffer | null>,
  warnings: string[],
): Promise<{
  before: string | null;
  after: string;
  summary: ReturnType<typeof summarizeChange>;
}> {
  const summary = summarizeCommit(workspace, plan, profilesRaw);
  const before = hashBytes(plan.loaded.raw);
  const after = hashBytes(plan.next) as string;
  try {
    await appendAudit(
      workspace.paths.auditPath,
      {
        at: workspace.now.toISOString(),
        action: 'write-ok',
        ok: true,
        hostsPath: workspace.hostsPath,
        planHash: plan.planHash,
        command: resolveCommand(options),
        ...(resolveCommandArgs(options)
          ? { commandArgs: resolveCommandArgs(options) as string[] }
          : {}),
        operator: currentOperator(),
        beforeSha256: before,
        afterSha256: after,
        summary,
        changed: plan.changed,
      },
      { keep: workspace.config.defaults.auditKeep },
    );
  } catch (error) {
    await recordAuditFailure(workspace.dataDir, {
      at: workspace.now.toISOString(),
      command: resolveCommand(options),
      detail: String(error),
    });
    warnings.push('写入成功，但审计记录失败；audit verify 会报告存在未审计操作。');
  }
  return { before, after, summary };
}

async function recordCommitHistory(
  workspace: Workspace,
  plan: RenderPlan,
  options: CommitOptions,
  profileSnapshots: ProfileSnapshot[],
  beforeStateRaw: Buffer | null,
  warnings: string[],
): Promise<void> {
  const profiles = options.profiles ?? [];
  const beforeProfiles = new Map<string, Buffer | null>();
  const afterProfiles = new Map<string, Buffer | null>();
  for (const [index, profile] of profiles.entries()) {
    beforeProfiles.set(profile.id, profileSnapshots[index]?.previous ?? null);
    afterProfiles.set(
      profile.id,
      await readFile(profilePath(workspace.paths.profilesDir, profile.id)).catch(() => null),
    );
  }
  for (const id of options.deleteProfiles ?? []) {
    afterProfiles.set(id, null);
  }
  const afterStateRaw =
    options.persistState === false ? beforeStateRaw : await readStateRaw(workspace.paths.statePath);
  const stateChanged = hashBytes(beforeStateRaw) !== hashBytes(afterStateRaw);
  if (!plan.changed && profiles.length === 0 && !stateChanged) return;

  try {
    await recordOperation({
      dataDir: workspace.dataDir,
      hostsPath: workspace.hostsPath,
      command: resolveCommand(options),
      args: resolveCommandArgs(options),
      planHash: plan.changed ? plan.planHash : null,
      keep: workspace.config.defaults.historyKeep,
      beforeHosts: plan.loaded.raw,
      afterHosts: plan.next,
      beforeStateRaw,
      afterStateRaw,
      beforeProfiles,
      afterProfiles,
      hostsBefore: plan.loaded.document.entries
        .filter((entry) => entry.source === 'managed')
        .map((entry) => ({ ip: entry.ip, hostnames: entry.hostnames })),
      hostsAfter: plan.merged.entries.map((entry) => ({
        ip: entry.ip,
        hostnames: entry.hostnames,
      })),
      stateBefore: workspace.initialState,
      stateAfter: workspace.state,
      operator: currentOperator(),
      now: workspace.now,
    });
  } catch (error) {
    warnings.push(`写入已完成，但 undo 历史记录失败：${String(error)}`);
    await recordAuditFailure(workspace.dataDir, {
      at: workspace.now.toISOString(),
      command: resolveCommand(options),
      detail: `history: ${String(error)}`,
    });
  }
}

/**
 * 统一提交：权限预检 → 备份 → 原子写 → 回读校验 → 持久化方案/状态 → DNS 刷新。
 * 任何持久化失败都会尝试把 hosts 回滚到写入前的内容。
 */
export async function commitPlan(
  workspace: Workspace,
  plan: RenderPlan,
  options: CommitOptions = {},
): Promise<MutationResult> {
  const warnings = [...(options.warnings ?? [])];
  const affected = options.affected ?? [];
  const beforeStateRaw = workspace.dryRun ? null : await readStateRaw(workspace.paths.statePath);
  let backupPath: string | null = null;
  let dnsFlushResult: MutationResult['dnsFlush'];
  // 方案快照：plan.changed 时在写 hosts 前赋值，仅写方案时在持久化前赋值。
  let profileSnapshots: ProfileSnapshot[] | null = null;
  const stateSnapshot = {
    lastRender: workspace.state.lastRender,
    ttlHashes: new Map(
      workspace.state.ttl.map((record) => [
        `${record.layerId}\u0000${record.entryId}`,
        record.planHash,
      ]),
    ),
  };

  if (plan.changed) {
    if (workspace.dryRun) {
      return {
        changed: true,
        backupPath: null,
        affected,
        diff: plan.diff,
        planHash: plan.planHash,
        warnings,
      };
    }

    if (!(await canWriteDirectly(workspace.hostsPath))) {
      throw new PermissionError(
        workspace.hostsPath,
        permissionHint(workspace.hostsPath, workspace.platformId),
      );
    }

    // 快照必须在任何写入（备份、hosts、方案、状态）之前完成，
    // 这样快照读取失败时不会留下任何已落盘的改动。
    profileSnapshots = await snapshotProfiles(options.profiles ?? [], workspace.paths.profilesDir);

    if (plan.loaded.raw !== null) {
      backupPath = await backupFile(workspace.hostsPath, plan.loaded.raw, {
        backupDir: workspace.paths.backupsDir,
        keep: workspace.config.defaults.backupKeep,
      });
    }

    await assertBaseline(workspace, plan.loaded.raw);
    await atomicWriteFile(workspace.hostsPath, plan.next);

    const written = await readFile(workspace.hostsPath);
    if (!written.equals(plan.next)) {
      const rolledBack = await rollbackHosts(workspace, plan.loaded.raw, plan.next);
      await appendAudit(
        workspace.paths.auditPath,
        {
          at: workspace.now.toISOString(),
          action: 'write-rollback',
          ok: false,
          hostsPath: workspace.hostsPath,
          planHash: plan.planHash,
          detail: rolledBack
            ? '写入后回读内容与预期不一致，已回滚。'
            : '写入后回读内容与预期不一致，且文件已被其他进程修改，已跳过回滚。',
        },
        { keep: workspace.config.defaults.auditKeep },
      ).catch(() => undefined);
      if (!rolledBack) {
        warnings.push('检测到 hosts 已被其他进程修改，未执行自动回滚，以免覆盖他人改动。');
      }
      throw new VerificationError(
        rolledBack
          ? '写入后回读校验失败：文件内容与预期不一致，已尝试回滚到写入前的备份。'
          : '写入后回读校验失败：文件内容与预期不一致，且已被其他进程修改，未回滚。',
      );
    }
  }

  if (workspace.dryRun) {
    return {
      changed: plan.changed,
      backupPath: null,
      affected,
      diff: plan.diff,
      planHash: null,
      warnings,
    };
  }

  // 未改 hosts、只写方案（如 profile meta）时，hosts 没有写入风险，
  // 但也需要在持久化前快照，失败时才能把方案文件恢复原状。
  if (profileSnapshots === null) {
    profileSnapshots = await snapshotProfiles(options.profiles ?? [], workspace.paths.profilesDir);
  }

  const profilesRaw = new Map<string, Buffer | null>();
  for (const [index, profile] of (options.profiles ?? []).entries()) {
    profilesRaw.set(profile.id, profileSnapshots[index]?.previous ?? null);
  }

  // DNS 刷新的顺序很关键：verify 用 getaddrinfo，必须先让系统缓存失效，
  // 否则刚写入的规则会被旧缓存误判为“未生效”。
  if (plan.changed && shouldFlushDns(workspace) && options.dnsFlush !== false) {
    dnsFlushResult = await flushDns(workspace.platformId);
    if (!dnsFlushResult.ok) {
      warnings.push(dnsFlushResult.detail ?? 'DNS 缓存刷新失败，hosts 写入已成功。');
    }
  }

  if (plan.changed && workspace.verify) {
    const verification = await verifyManagedEntries(
      plan.merged.entries,
      {
        maxHostnames: workspace.config.defaults.verifyMaxHostnames,
        timeoutMs: workspace.config.defaults.verifyTimeoutMs,
      },
      workspace.options.verifyLookup ? { lookup: workspace.options.verifyLookup } : {},
    );

    if (!verification.ok) {
      const rolledBack = await rollbackHosts(workspace, plan.loaded.raw, plan.next);
      // 回滚后必须再次刷新缓存：之前那次 flush 可能已把新写入的规则缓存进系统，
      // 不刷会让系统继续解析到已经撤回的 IP。
      if (shouldFlushDns(workspace) && options.dnsFlush !== false) {
        await flushDns(workspace.platformId).catch(() => undefined);
      }
      await appendAudit(
        workspace.paths.auditPath,
        {
          at: workspace.now.toISOString(),
          action: 'verify-rollback',
          ok: false,
          hostsPath: workspace.hostsPath,
          planHash: plan.planHash,
          checked: verification.checked,
          failures: verification.failures,
          detail: rolledBack
            ? '写入后解析验证失败，已回滚到写入前内容。'
            : '写入后解析验证失败，但文件已被其他进程修改，已跳过回滚。',
        },
        { keep: workspace.config.defaults.auditKeep },
      ).catch(() => undefined);
      if (!rolledBack) {
        warnings.push('检测到 hosts 已被其他进程修改，未执行自动回滚，以免覆盖他人改动。');
      }
      const sample = verification.failures
        .slice(0, 3)
        .map(
          (failure) =>
            `${failure.hostname} 期望 ${failure.expected}，实际 ${failure.actual.join(', ') || '无结果'}`,
        )
        .join('；');
      throw new VerificationError(
        rolledBack
          ? `写入后解析验证失败（${verification.failures.length}/${verification.checked} 个域名），已回滚：${sample}。`
          : `写入后解析验证失败（${verification.failures.length}/${verification.checked} 个域名），且文件已被其他进程修改，未回滚：${sample}。`,
      );
    }

    if (verification.skipped > 0) {
      warnings.push(
        `解析验证只抽查了 ${verification.checked} 个域名（上限 ${workspace.config.defaults.verifyMaxHostnames}）。`,
      );
    }
    await appendAudit(
      workspace.paths.auditPath,
      {
        at: workspace.now.toISOString(),
        action: 'verify-ok',
        ok: true,
        hostsPath: workspace.hostsPath,
        planHash: plan.planHash,
        checked: verification.checked,
      },
      { keep: workspace.config.defaults.auditKeep },
    ).catch(() => undefined);
  }

  if (plan.changed) {
    workspace.state.lastRender = {
      at: workspace.now.toISOString(),
      planHash: plan.planHash,
      sources: plan.merged.sources,
    };
    // TTL 记录原先记录的是“写入时整文件哈希”。本次成功写回后整文件哈希已变化，
    // 若不刷新，后续任何 CLI 自身写入都会被误判为“外部修改”而跳过到期结算。
    for (const record of workspace.state.ttl) {
      record.planHash = plan.planHash;
    }
    // 不再回读重解析：调用方不会复用 plan.loaded（下一次命令会重新解析），
    // 省掉一次 O(n) 解析；写入正确性已由上面的字节级 equals 校验保证。
  }

  try {
    for (const profile of options.profiles ?? []) {
      // 方案在读取时已校验，改动只来自 validateEntryInput / 元数据编辑。
      await writeProfile(workspace.paths.profilesDir, profile, { trusted: true });
    }
    if (options.persistState !== false) {
      await saveState(workspace.paths.statePath, workspace.state);
    }
  } catch (error) {
    const restoredProfiles = await restoreProfiles(profileSnapshots ?? []);
    // 内存中的 lastRender / TTL planHash 只在写入成功后才应生效；
    // 既然 hosts 即将回滚，这些字段也必须恢复到本次提交前的值。
    workspace.state.lastRender = stateSnapshot.lastRender;
    for (const record of workspace.state.ttl) {
      const previous = stateSnapshot.ttlHashes.get(`${record.layerId}\u0000${record.entryId}`);
      if (previous !== undefined) record.planHash = previous;
    }
    if (!restoredProfiles) {
      warnings.push('回滚方案文件失败，请检查 profiles 目录权限。');
    }
    if (plan.changed) {
      const rolledBack = await rollbackHosts(workspace, plan.loaded.raw, plan.next);
      await appendAudit(
        workspace.paths.auditPath,
        {
          at: workspace.now.toISOString(),
          action: 'write-rollback',
          ok: false,
          hostsPath: workspace.hostsPath,
          planHash: plan.planHash,
          detail: rolledBack
            ? '持久化方案/状态失败，已回滚 hosts。'
            : '持久化方案/状态失败，但 hosts 已被其他进程修改，已跳过回滚。',
        },
        { keep: workspace.config.defaults.auditKeep },
      ).catch(() => undefined);
      warnings.push(
        rolledBack
          ? '持久化方案/状态失败，已尝试回滚 hosts 文件。'
          : '持久化方案/状态失败；检测到 hosts 已被其他进程修改，未自动回滚。',
      );
    }
    throw error;
  }

  // 写入成功记录必须在"写入 + 校验 + 持久化"全部成功之后追加；
  // 提前记录会把已回滚的操作错误地标成 ok，让审计结果与事实不符。
  if (plan.changed) {
    await appendWriteAudit(workspace, plan, options, profilesRaw, warnings);
  }

  if (!plan.changed) {
    const stateChanged =
      hashBytes(beforeStateRaw) !== hashBytes(await readStateRaw(workspace.paths.statePath));
    if ((options.profiles ?? []).length > 0 || stateChanged) {
      await appendWriteAudit(workspace, plan, options, profilesRaw, warnings);
    }
  }

  await recordCommitHistory(workspace, plan, options, profileSnapshots, beforeStateRaw, warnings);

  return {
    changed: plan.changed,
    backupPath,
    affected,
    diff: plan.diff,
    planHash: plan.changed ? plan.planHash : null,
    dnsFlush: dnsFlushResult,
    warnings,
  };
}

export function hashOf(buffer: Buffer): string {
  return sha256Buffer(buffer);
}
