import { randomBytes } from 'node:crypto';
import { chmod, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HostsCliError, PermissionError } from '../errors';

export interface AtomicWriteOptions {
  /** rename 失败时的最大尝试次数（Windows 上被杀软/索引占用时有用）。 */
  retries?: number;
  /** 目标文件不存在时使用的权限位。 */
  defaultMode?: number;
  /** 强制使用指定权限位（配置/状态文件用 0600，不继承用户误设的权限）。 */
  mode?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把底层 errno 权限类错误统一成 PermissionError，避免 CLI 把裸
 * `EACCES: permission denied, mkdir ...` 当作未知错误输出（退出码会落到 1）。
 * 已有 HostsCliError 原样返回，避免重复包装。
 */
export function asWritePermissionError(targetPath: string, error: unknown): unknown {
  if (error instanceof HostsCliError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new PermissionError(targetPath, `没有写入权限：${targetPath}（${code}）`);
  }
  return error;
}

/**
 * 同目录临时文件 → fsync → rename。
 * 目标文件要么保持旧内容，要么变成新内容，不会出现半截文件。
 */
export async function atomicWriteFile(
  targetPath: string,
  content: Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  try {
    await writeTemporaryAndRename(targetPath, content, options);
  } catch (error) {
    throw asWritePermissionError(targetPath, error);
  }
}

async function writeTemporaryAndRename(
  targetPath: string,
  content: Buffer,
  options: AtomicWriteOptions,
): Promise<void> {
  const directory = dirname(targetPath);
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.hostscli-${randomBytes(6).toString('hex')}.tmp`,
  );

  let mode = options.mode ?? options.defaultMode ?? 0o644;
  if (options.mode === undefined) {
    try {
      const targetStat = await stat(targetPath);
      mode = targetStat.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const attempts = options.retries ?? (process.platform === 'win32' ? 3 : 1);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'w', mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // open(..., mode) 仍受 umask 影响；显式 chmod 临时文件，确保 rename 后权限精确。
    await chmod(temporaryPath, mode);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // write / fsync / chmod / open 任一步失败都要清掉临时文件，避免垃圾文件累积。
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporaryPath, targetPath);
      await syncDirectory(directory);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (attempt < attempts && retryable) {
        await delay(50 * attempt);
        continue;
      }

      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

/** rename 之后 fsync 目录，降低掉电后丢失改名操作的概率；不支持时静默跳过。 */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // 某些文件系统（如部分网络盘 / FUSE）不支持对目录 fsync。
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
