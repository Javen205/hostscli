import { readFile, unlink } from 'node:fs/promises';
import { backupFile, latestBackupFile, listBackupFiles } from '../backup';
import { EntryNotFoundError, PermissionError, VerificationError } from '../errors';
import { parseHosts } from '../hosts/parser';
import { atomicWriteFile } from '../system/atomic-write';
import { canWriteDirectly, permissionHint } from '../system/privilege';
import { defaultEolFor } from '../system/platform';
import { flushDns } from '../system/dns-flush';
import { saveState } from '../storage/state';
import { loadHostsDocument, shouldFlushDns, withWorkspace } from './context';
import { sha256Buffer } from './plan';
import type { WorkspaceOptions } from './context';
import type { MutationResult } from './types';
import { auditAuxWrite } from './aux-write';
import { hashBytes } from './history';

export interface BackupOptions extends WorkspaceOptions {
  keep?: number;
}

export interface RestoreOptions extends BackupOptions {
  backupFile?: string;
}

export interface RestoreResult extends MutationResult {
  restoredFrom: string;
}

export async function createHostsBackup(options: BackupOptions = {}): Promise<string> {
  return withWorkspace(options, async (workspace) => {
    const { raw } = await loadHostsDocument(workspace, false);
    if (raw === null) throw new EntryNotFoundError(`hosts 文件不存在：${workspace.hostsPath}`);
    const backupPath = await backupFile(workspace.hostsPath, raw, {
      backupDir: workspace.paths.backupsDir,
      keep: options.keep ?? workspace.config.defaults.backupKeep,
    });
    // 备份不改变 hosts 内容，但确实新增了一个数据文件，仍需留痕。
    await auditAuxWrite(workspace, {
      command: 'backup create',
      beforeSha256: hashBytes(raw),
      afterSha256: hashBytes(raw),
      detail: `创建 hosts 备份：${backupPath}。`,
    });
    return backupPath;
  });
}

export async function listHostsBackups(
  options: BackupOptions = {},
): Promise<{ backupDir: string; files: string[] }> {
  return withWorkspace(options, async (workspace) => ({
    backupDir: workspace.paths.backupsDir,
    files: await listBackupFiles(workspace.paths.backupsDir),
  }));
}

export async function restoreHostsBackup(options: RestoreOptions = {}): Promise<RestoreResult> {
  return withWorkspace(options, async (workspace) => {
    const source =
      options.backupFile ?? (await latestBackupFile(workspace.paths.backupsDir)) ?? null;
    if (!source) throw new EntryNotFoundError(`没有可用的备份：${workspace.paths.backupsDir}`);

    const restored = await readFile(source);
    // 恢复前先完整解析：截断/未闭合围栏的备份必须在这里被拒绝，
    // 绝不能让半截内容进入 hosts（哪怕后面还有回读校验）。
    const restoredDocument = parseHosts(restored, {
      platformDefaultEol: defaultEolFor(workspace.platformId),
    });

    const { raw } = await loadHostsDocument(workspace, true);
    const unchanged = raw !== null && raw.equals(restored);

    if (unchanged && raw !== null) {
      return {
        changed: false,
        backupPath: null,
        affected: restoredDocument.entries.filter((entry) => entry.source === 'managed'),
        diff: '',
        planHash: sha256Buffer(raw),
        warnings: ['当前 hosts 内容已与所选备份一致，无需恢复。'],
        restoredFrom: source,
      };
    }

    if (!(await canWriteDirectly(workspace.hostsPath))) {
      throw new PermissionError(
        workspace.hostsPath,
        permissionHint(workspace.hostsPath, workspace.platformId),
      );
    }

    const keep = options.keep ?? workspace.config.defaults.backupKeep;
    const previousBackup = raw
      ? await backupFile(workspace.hostsPath, raw, {
          backupDir: workspace.paths.backupsDir,
          keep,
        })
      : null;

    const restoredHash = sha256Buffer(restored);
    let written: Buffer;
    try {
      await atomicWriteFile(workspace.hostsPath, restored);
      written = await readFile(workspace.hostsPath);
      if (!written.equals(restored)) {
        throw new VerificationError('恢复后回读校验失败：文件内容与备份不一致。');
      }

      // restore 后文件可能不再与当前规则集一致：清空 lastRender，提醒后续 apply。
      workspace.state.lastRender = undefined;
      // 与 commitPlan 一致：成功写回后刷新所有 TTL 记录的整文件哈希，
      // 否则下一次到期结算会把这次恢复误判成“外部修改”。
      for (const record of workspace.state.ttl) {
        record.planHash = restoredHash;
      }
      await saveState(workspace.paths.statePath, workspace.state);
    } catch (error) {
      const rolledBack = await rollbackRestoredHosts(workspace, raw);
      if (error instanceof VerificationError) {
        throw new VerificationError(
          rolledBack
            ? '恢复后回读校验失败，已回滚到恢复前内容。'
            : '恢复后回读校验失败，且回滚到恢复前内容失败。',
        );
      }
      throw error;
    }

    await auditAuxWrite(workspace, {
      command: 'restore',
      args: [source],
      beforeSha256: hashBytes(raw),
      afterSha256: restoredHash,
      detail: `从备份恢复 hosts：${source}（恢复前内容已另存为 ${previousBackup ?? '临时缺失'}）。`,
    });

    const warnings = [
      '已从备份恢复 hosts；托管区块可能与当前规则集不一致，建议执行 hostscli apply 或 hostscli list 检查。',
    ];

    let dnsFlushResult: RestoreResult['dnsFlush'];
    if (shouldFlushDns(workspace)) {
      dnsFlushResult = await flushDns(workspace.platformId);
      if (!dnsFlushResult.ok) warnings.push(dnsFlushResult.detail ?? 'DNS 缓存刷新失败。');
    }

    const document = restoredDocument;

    return {
      changed: true,
      backupPath: previousBackup,
      affected: document.entries.filter((entry) => entry.source === 'managed'),
      diff: '',
      planHash: restoredHash,
      dnsFlush: dnsFlushResult,
      warnings,
      restoredFrom: source,
    };
  });
}

/** 恢复失败时把 hosts 写回恢复前内容；返回是否成功。 */
async function rollbackRestoredHosts(
  workspace: { hostsPath: string },
  previous: Buffer | null,
): Promise<boolean> {
  try {
    if (previous === null) {
      await unlink(workspace.hostsPath);
    } else {
      await atomicWriteFile(workspace.hostsPath, previous);
    }
    return true;
  } catch {
    return false;
  }
}
