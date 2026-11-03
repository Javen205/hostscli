import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { atomicWriteFile } from './system/atomic-write';

export const DEFAULT_BACKUP_KEEP = 20;

export interface BackupOptions {
  /** 备份目录，默认 `~/.hostscli/backups`（可用 HOSSCLI_HOME 覆盖）。 */
  backupDir?: string;
  /** 保留最近多少份备份，默认 20。 */
  keep?: number;
  /** 便于测试注入固定时间。 */
  timestamp?: Date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

export function defaultBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOSSCLI_HOME ?? join(homedir(), '.hostscli');
  return join(home, 'backups');
}

async function pruneBackups(directory: string, keep: number): Promise<void> {
  if (keep <= 0) return;
  // 复用 mtime 排序：同一秒内的多份备份也能按真实创建顺序保留。
  const backups = await listBackupFiles(directory);
  await Promise.all(backups.slice(keep).map((filePath) => unlink(filePath)));
}

/**
 * 写前备份。任何写操作前必须先成功备份；备份失败则调用方不得继续写入。
 */
export async function backupFile(
  sourcePath: string,
  content: Buffer,
  options: BackupOptions = {},
): Promise<string> {
  const directory = options.backupDir ?? defaultBackupDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const digest = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const timestamp = formatTimestamp(options.timestamp ?? new Date());
  const targetPath = join(directory, `${basename(sourcePath)}.${timestamp}.${digest}.bak`);

  // 备份也可能是“恢复失败时的最后一份完好内容”，必须原子落盘，避免断电/异常留下半截文件。
  await atomicWriteFile(targetPath, content, { mode: 0o600 });
  await pruneBackups(directory, options.keep ?? DEFAULT_BACKUP_KEEP);

  return targetPath;
}

/**
 * 按创建时间从新到旧列出备份文件绝对路径。
 * 文件名里的时间戳只有秒级精度，同一秒内可能产生多份备份（例如 restore 会先备份再恢复），
 * 因此以 mtime 为主序、文件名次序为 tiebreaker。
 */
export async function listBackupFiles(backupDir: string = defaultBackupDir()): Promise<string[]> {
  const entries = await readdir(backupDir).catch(() => [] as string[]);
  const paths = entries
    .filter((name) => name.endsWith('.bak'))
    .map((name) => join(backupDir, name));

  const withTime = await Promise.all(
    paths.map(async (filePath) => ({
      filePath,
      mtimeMs: await stat(filePath)
        .then((info) => info.mtimeMs)
        .catch(() => 0),
    })),
  );

  return withTime
    .sort((a, b) =>
      a.mtimeMs === b.mtimeMs ? b.filePath.localeCompare(a.filePath) : b.mtimeMs - a.mtimeMs,
    )
    .map((entry) => entry.filePath);
}

/** 最近一份备份；没有则返回 null。 */
export async function latestBackupFile(
  backupDir: string = defaultBackupDir(),
): Promise<string | null> {
  const files = await listBackupFiles(backupDir);
  return files[0] ?? null;
}
