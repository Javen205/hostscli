import { readFile, unlink } from 'node:fs/promises';
import { backupFile } from '../backup';
import { HostsCliError, PermissionError, VerificationError } from '../errors';
import type { HostEntry } from '../hosts/models';
import { atomicWriteFile } from '../system/atomic-write';
import { flushDns } from '../system/dns-flush';
import type { Profile } from '../profiles/store';
import { writeProfile } from '../profiles/store';
import { saveState } from '../storage/state';
import { canWriteDirectly, permissionHint } from '../system/privilege';
import type { Workspace } from './context';
import { shouldFlushDns } from './context';
import type { RenderPlan } from './plan';
import { sha256Buffer } from './plan';
import type { MutationResult } from './types';
import { appendAudit } from './audit';
import { verifyManagedEntries } from './verify';

export interface CommitOptions {
  profiles?: Profile[];
  persistState?: boolean;
  affected?: HostEntry[];
  warnings?: string[];
  /** 显式覆盖本次是否刷新 DNS。 */
  dnsFlush?: boolean;
}

async function readHostsOrNull(hostsPath: string): Promise<Buffer | null> {
  try {
    return await readFile(hostsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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
  let backupPath: string | null = null;
  let dnsFlushResult: MutationResult['dnsFlush'];

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
      await appendAudit(workspace.paths.auditPath, {
        at: workspace.now.toISOString(),
        action: 'write-rollback',
        ok: false,
        hostsPath: workspace.hostsPath,
        planHash: plan.planHash,
        detail: rolledBack
          ? '写入后回读内容与预期不一致，已回滚。'
          : '写入后回读内容与预期不一致，且文件已被其他进程修改，已跳过回滚。',
      }).catch(() => undefined);
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
      await appendAudit(workspace.paths.auditPath, {
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
      }).catch(() => undefined);
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
    await appendAudit(workspace.paths.auditPath, {
      at: workspace.now.toISOString(),
      action: 'verify-ok',
      ok: true,
      hostsPath: workspace.hostsPath,
      planHash: plan.planHash,
      checked: verification.checked,
    }).catch(() => undefined);
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
    if (plan.changed) {
      const rolledBack = await rollbackHosts(workspace, plan.loaded.raw, plan.next);
      await appendAudit(workspace.paths.auditPath, {
        at: workspace.now.toISOString(),
        action: 'write-rollback',
        ok: false,
        hostsPath: workspace.hostsPath,
        planHash: plan.planHash,
        detail: rolledBack
          ? '持久化方案/状态失败，已回滚 hosts。'
          : '持久化方案/状态失败，但 hosts 已被其他进程修改，已跳过回滚。',
      }).catch(() => undefined);
      warnings.push(
        rolledBack
          ? '持久化方案/状态失败，已尝试回滚 hosts 文件。'
          : '持久化方案/状态失败；检测到 hosts 已被其他进程修改，未自动回滚。',
      );
    }
    throw error;
  }

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
