import { readFile, unlink } from 'node:fs/promises';
import { backupFile } from '../backup';
import { createUnifiedDiff } from '../diff';
import {
  EntryNotFoundError,
  HostsCliError,
  InvalidInputError,
  PermissionError,
  VerificationError,
} from '../errors';
import { parseHosts } from '../hosts/parser';
import type { ChangeEntry, HistoryRecord, HistorySnapshot } from './history';
import {
  availableHistory,
  hashBytes,
  parseStateBytes,
  readAllProfiles,
  readHistory,
  readSnapshot,
  readStateRaw,
  recordOperation,
  restoreFile,
} from './history';
import { profilePath } from '../profiles/store';
import { atomicWriteFile } from '../system/atomic-write';
import { flushDns } from '../system/dns-flush';
import { canWriteDirectly, permissionHint } from '../system/privilege';
import { defaultEolFor } from '../system/platform';
import type { Workspace, WorkspaceOptions } from './context';
import { shouldFlushDns, withWorkspace } from './context';
import { appendAudit, currentOperator, recordAuditFailure } from './audit';
import { logRuntime } from './aux-write';
import { verifyManagedEntries } from './verify';

export interface UndoOptions extends WorkspaceOptions {
  /** 撤销最近 N 次成功写入，默认 1。 */
  steps?: number;
}

export interface UndoRecordView {
  id: string;
  at: string;
  command: string;
  summary: HistoryRecord['summary'];
}

export interface UndoResult {
  changed: boolean;
  dryRun: boolean;
  steps: number;
  records: UndoRecordView[];
  diff: string;
  warnings: string[];
}

async function readMaybe(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function fingerprintMismatch(expected: string | null, actual: Buffer | null): boolean {
  return expected !== hashBytes(actual);
}

async function readProfilesFor(
  ids: string[],
  profilesDir: string,
): Promise<Map<string, Buffer | null>> {
  const map = new Map<string, Buffer | null>();
  for (const id of ids) map.set(id, await readMaybe(profilePath(profilesDir, id)));
  return map;
}

function managedEntries(buffer: Buffer | null, platformId: Workspace['platformId']): ChangeEntry[] {
  if (buffer === null) return [];
  const document = parseHosts(buffer, { platformDefaultEol: defaultEolFor(platformId) });
  return document.entries
    .filter((entry) => entry.source === 'managed')
    .map((entry) => ({ ip: entry.ip, hostnames: entry.hostnames }));
}

function stateDiffers(before: Buffer | null, after: Buffer | null): boolean {
  return hashBytes(before) !== hashBytes(after);
}

/**
 * 校验"当前磁盘内容仍是最后一次写入后的内容"。
 * 任一指纹不符都拒绝撤销：盲目覆盖会丢失其他进程（或手工编辑）的改动。
 */
async function assertUndoBaseline(
  workspace: Workspace,
  latest: HistoryRecord,
  warnings: string[],
): Promise<void> {
  const currentHosts = await readMaybe(workspace.hostsPath);
  const currentState = await readStateRaw(workspace.paths.statePath);
  if (fingerprintMismatch(latest.after.hosts, currentHosts)) {
    throw new HostsCliError(
      'CONFLICT',
      `hosts 已被其他进程或手工修改，无法安全撤销 ${latest.id}（${latest.command}）；` +
        '请先确认当前内容，或改用 git / backup 恢复。',
    );
  }
  if (fingerprintMismatch(latest.after.state, currentState)) {
    throw new HostsCliError(
      'CONFLICT',
      `state 已被其他进程修改，无法安全撤销 ${latest.id}（${latest.command}）；请重试或先排查并发写入。`,
    );
  }
  const profileIds = Object.keys(latest.after.profiles);
  const currentProfiles = await readProfilesFor(profileIds, workspace.paths.profilesDir);
  for (const [id, content] of currentProfiles) {
    if (fingerprintMismatch(latest.after.profiles[id] ?? null, content)) {
      throw new HostsCliError(
        'CONFLICT',
        `方案 ${id} 已被其他进程或手工修改，无法安全撤销 ${latest.id}（${latest.command}）。`,
      );
    }
  }
  if (profileIds.length > 0) {
    warnings.push(`撤销将同时回退 hosts、state 与 ${profileIds.length} 个方案文件。`);
  }
}

function chainMismatch(older: HistoryRecord, newer: HistoryRecord): string | null {
  if (older.after.hosts !== newer.before.hosts) return 'hosts';
  if (older.after.state !== newer.before.state) return 'state';
  for (const [id, hash] of Object.entries(older.after.profiles)) {
    if (id in newer.before.profiles && newer.before.profiles[id] !== hash) return `profile ${id}`;
  }
  return null;
}

export interface ApplyUndoTarget {
  hosts: Buffer | null;
  state: Buffer | null;
  profiles: Map<string, Buffer | null>;
}

/** 回放一个快照；失败时把三处内容恢复为 current。 */
async function applySnapshot(
  workspace: Workspace,
  target: ApplyUndoTarget,
  current: ApplyUndoTarget,
): Promise<boolean> {
  const hostsChanged = hashBytes(current.hosts) !== hashBytes(target.hosts);
  if (hostsChanged && !(await canWriteDirectly(workspace.hostsPath))) {
    throw new PermissionError(
      workspace.hostsPath,
      permissionHint(workspace.hostsPath, workspace.platformId),
    );
  }

  try {
    if (hostsChanged) {
      if (target.hosts === null) {
        // 目标快照里 hosts 文件本就不存在（例如首次 init 之前），撤销应删除它。
        await unlink(workspace.hostsPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        const exists = await readMaybe(workspace.hostsPath);
        if (exists !== null)
          throw new VerificationError('撤销后回读校验失败：hosts 文件未被删除。');
      } else {
        await atomicWriteFile(workspace.hostsPath, target.hosts);
        const written = await readFile(workspace.hostsPath);
        if (fingerprintMismatch(hashBytes(target.hosts), written)) {
          throw new VerificationError('撤销后回读校验失败：hosts 内容与快照不一致。');
        }
      }
    }
    await restoreFile(workspace.paths.statePath, target.state);
    for (const [id, content] of target.profiles) {
      await restoreFile(profilePath(workspace.paths.profilesDir, id), content);
    }
    workspace.state = parseStateBytes(target.state);
    return hostsChanged;
  } catch (error) {
    const rolledBack = await (async () => {
      try {
        await restoreFile(workspace.hostsPath, current.hosts);
        await restoreFile(workspace.paths.statePath, current.state);
        for (const [id, content] of current.profiles) {
          await restoreFile(profilePath(workspace.paths.profilesDir, id), content);
        }
        return true;
      } catch {
        return false;
      }
    })();
    if (rolledBack) {
      throw error;
    }
    throw new HostsCliError(
      'CONFLICT',
      `撤销过程中写入失败，且自动回滚也失败；请用 hostscli backup restore 或 git rollback 恢复。原始错误：${String(error)}`,
    );
  }
}

/**
 * 撤销最近 N 次成功写入：一次性回放最旧那条记录的"写入前"快照，
 * 并把本次 undo 本身记录为一条可再次撤销的操作（即 redo）。
 */
export async function undoHosts(options: UndoOptions = {}): Promise<UndoResult> {
  const steps = options.steps ?? 1;
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) {
    throw new InvalidInputError('--steps 必须是 1–100 的整数。');
  }

  return withWorkspace(options, async (workspace) => {
    const records = await readHistory(workspace.dataDir);
    const available = availableHistory(records);
    if (available.length === 0) {
      throw new EntryNotFoundError(
        '没有可撤销的写入记录；undo 只撤销通过 hostscli 成功写入的操作。',
      );
    }
    if (available.length < steps) {
      throw new InvalidInputError(`只有 ${available.length} 次可撤销写入，无法撤销 ${steps} 次。`);
    }

    const selected = available.slice(available.length - steps);
    const latest = selected.at(-1) as HistoryRecord;
    const targetRecord = selected[0] as HistoryRecord;

    const warnings: string[] = [];
    await assertUndoBaseline(workspace, latest, warnings);
    for (let index = 1; index < selected.length; index += 1) {
      const older = selected[index - 1] as HistoryRecord;
      const newer = selected[index] as HistoryRecord;
      const mismatch = chainMismatch(older, newer);
      if (mismatch !== null) {
        throw new HostsCliError(
          'CONFLICT',
          `历史链在 ${older.id} 与 ${newer.id} 之间不连续（${mismatch} 存在未记录变更），` +
            '拒绝批量撤销；请改用更小的 --steps 或 git rollback。',
        );
      }
    }

    const target = await readSnapshot(workspace.dataDir, targetRecord);
    const currentHosts = await readMaybe(workspace.hostsPath);
    const currentState = await readStateRaw(workspace.paths.statePath);
    const currentProfiles = await readAllProfiles(workspace.paths.profilesDir);

    // 目标快照只覆盖操作触及的 profile；未触及的保持现状。
    const afterProfiles = new Map(currentProfiles);
    for (const [id, content] of target.profiles) afterProfiles.set(id, content);

    const targetHostsText = target.hosts?.toString('utf8') ?? '';
    const currentHostsText = currentHosts?.toString('utf8') ?? '';
    const diff =
      hashBytes(target.hosts) === hashBytes(currentHosts)
        ? ''
        : createUnifiedDiff(currentHostsText, targetHostsText, {
            labelFrom: `a/${workspace.hostsPath}`,
            labelTo: `b/${workspace.hostsPath}`,
          });

    const recordsView: UndoRecordView[] = selected.map((record) => ({
      id: record.id,
      at: record.at,
      command: record.command,
      summary: record.summary,
    }));

    if (workspace.dryRun) {
      return {
        changed: true,
        dryRun: true,
        steps,
        records: recordsView,
        diff,
        warnings: [
          ...warnings,
          `将撤销 ${steps} 次操作（${selected.map((record) => record.id).join(' → ')}）。`,
        ],
      };
    }

    const snapshot: HistorySnapshot = {
      hosts: currentHosts,
      state: currentState,
      profiles: currentProfiles,
    };

    if (currentHosts !== null) {
      await backupFile(workspace.hostsPath, currentHosts, {
        backupDir: workspace.paths.backupsDir,
        keep: workspace.config.defaults.backupKeep,
      });
    }
    const hostsChanged = await applySnapshot(
      workspace,
      { hosts: target.hosts, state: target.state, profiles: target.profiles },
      snapshot,
    );

    if (hostsChanged && shouldFlushDns(workspace)) {
      const result = await flushDns(workspace.platformId);
      if (!result.ok) warnings.push(result.detail ?? 'DNS 缓存刷新失败，撤销已写入。');
    }

    if (hostsChanged && workspace.verify) {
      const entries = managedEntries(target.hosts, workspace.platformId);
      const verification = await verifyManagedEntries(
        entries.map((entry) => ({
          id: '',
          ip: entry.ip,
          hostnames: entry.hostnames,
          enabled: true,
          layerId: 'undo',
          source: 'managed' as const,
        })),
        {
          maxHostnames: workspace.config.defaults.verifyMaxHostnames,
          timeoutMs: workspace.config.defaults.verifyTimeoutMs,
        },
        workspace.options.verifyLookup ? { lookup: workspace.options.verifyLookup } : {},
      );
      if (!verification.ok) {
        await applySnapshot(workspace, snapshot, {
          hosts: target.hosts,
          state: target.state,
          profiles: target.profiles,
        }).catch(() => undefined);
        await logRuntime(workspace, {
          level: 'warn',
          command: 'undo',
          event: 'rollback',
          detail: '撤销后解析验证失败，已回滚到撤销前内容。',
        });
        throw new VerificationError(
          `撤销后解析验证失败（${verification.failures.length} 个域名），已回滚到撤销前内容。`,
        );
      }
    }

    const consumes = selected.map((record) => record.id);
    const changed =
      hostsChanged ||
      stateDiffers(currentState, target.state) ||
      [...target.profiles].some(
        ([id, content]) => hashBytes(content) !== hashBytes(currentProfiles.get(id) ?? null),
      );

    try {
      await recordOperation({
        dataDir: workspace.dataDir,
        hostsPath: workspace.hostsPath,
        command: 'undo',
        args: ['--steps', String(steps)],
        planHash: null,
        kind: 'undo',
        consumes,
        keep: workspace.config.defaults.historyKeep,
        beforeHosts: currentHosts,
        afterHosts: target.hosts,
        beforeStateRaw: currentState,
        afterStateRaw: target.state,
        beforeProfiles: currentProfiles,
        afterProfiles,
        hostsBefore: managedEntries(currentHosts, workspace.platformId),
        hostsAfter: managedEntries(target.hosts, workspace.platformId),
        stateBefore: parseStateBytes(currentState),
        stateAfter: parseStateBytes(target.state),
        operator: currentOperator(),
        now: workspace.now,
      });
    } catch (error) {
      warnings.push(`撤销已完成，但历史记录写入失败，本次撤销无法再次撤销：${String(error)}`);
    }

    try {
      await appendAudit(
        workspace.paths.auditPath,
        {
          at: workspace.now.toISOString(),
          action: 'undo-ok',
          ok: true,
          hostsPath: workspace.hostsPath,
          command: 'undo',
          commandArgs: ['--steps', String(steps)],
          operator: currentOperator(),
          beforeSha256: hashBytes(currentHosts),
          afterSha256: hashBytes(target.hosts),
          detail: `撤销 ${steps} 次写入（${consumes.join(' → ')}）。`,
        },
        { keep: workspace.config.defaults.auditKeep },
      );
    } catch (error) {
      await recordAuditFailure(workspace.dataDir, {
        at: workspace.now.toISOString(),
        command: 'undo',
        detail: String(error),
      });
      warnings.push('撤销已成功，但审计写入失败；audit verify 会报告存在未审计操作。');
    }

    await logRuntime(workspace, {
      command: 'undo',
      args: ['--steps', String(steps)],
      event: 'undo-ok',
      detail: `撤销 ${steps} 次写入（${consumes.join(' → ')}）。`,
    });

    return {
      changed,
      dryRun: false,
      steps,
      records: recordsView,
      diff,
      warnings,
    };
  });
}

/** 只读预览最近 N 次操作（供 `undo --dry-run` 与调试使用）。 */
export async function listUndoHistory(
  options: WorkspaceOptions & { limit?: number } = {},
): Promise<{ records: HistoryRecord[] }> {
  return withWorkspace(options, async (workspace) => {
    const available = availableHistory(await readHistory(workspace.dataDir)).reverse();
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
    return { records: available.slice(0, limit) };
  });
}
