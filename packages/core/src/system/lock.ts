import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LockedError } from '../errors';
import { lockDirectory } from '../storage/paths';

export interface LockOptions {
  /** 获取锁的最长等待时间。 */
  timeoutMs?: number;
  /** 超过该时间未释放视为陈旧锁（进程可能已崩溃）。 */
  staleMs?: number;
  /** 重试间隔。 */
  retryMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 由 hosts 路径生成稳定锁名。
 *
 * 锁必须只按 hosts 文件取键：不同数据目录的两个实例写同一份 hosts 时，
 * 若把 dataDir 掺进哈希就会各拿各的锁，导致后写者覆盖先写者的规则。
 * `dataDir` 参数仅为兼容旧调用保留，不再参与锁名计算。
 */
export function lockPathFor(hostsPath: string, _dataDir?: string): string {
  const digest = createHash('sha256').update(resolve(hostsPath)).digest('hex').slice(0, 16);
  return join(lockDirectory(), `${digest}.lock`);
}

/**
 * 数据目录单独一把锁：不同 `--file` 但同一数据目录的实例也会互相阻塞，
 * 避免 profile/state/config 被并发改写。
 */
export function lockPathForDataDir(dataDir: string): string {
  const digest = createHash('sha256').update(`data\u0000${dataDir}`).digest('hex').slice(0, 16);
  return join(lockDirectory(), `${digest}.lock`);
}

async function tryCreate(lockPath: string, token: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
      );
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function removeStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < staleMs) return false;
    // 读一次 PID：如果进程还活着，不能仅凭时间删锁。
    try {
      const content = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number };
      if (typeof content.pid === 'number') {
        // 同一进程内并发调用时，锁一定仍然有效，不能按时间清理。
        if (content.pid === process.pid) return false;
        try {
          process.kill(content.pid, 0);
          return false;
        } catch {
          // 进程不存在，允许清理。
        }
      }
    } catch {
      // 锁内容损坏，允许清理。
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * 释放锁时只删除"自己创建的那一把"。
 * 若本次操作耗时超过 staleMs，锁可能已被其他进程按陈旧锁清理并重新获取；
 * 此时无条件 unlink 会误删别人的锁。
 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const content = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: string };
    if (content.token !== token) return;
    await unlink(lockPath);
  } catch {
    // 锁文件已被清理或内容无法解析，按已释放处理。
  }
}

/**
 * 锁目录固定路径可能被其他用户预先创建。mkdir 后校验：
 * - 属主必须是当前用户（POSIX）；
 * - 组/其他用户不可写（否则他人可在锁目录里预置锁文件）；
 * - 权限收紧到 0700。
 */
async function assertLockDirectorySafe(directory: string): Promise<void> {
  const info = await stat(directory);
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (info.uid !== process.getuid()) {
      throw new LockedError(
        `锁目录 ${directory} 不属于当前用户（uid ${info.uid}），拒绝使用；请手动删除该目录后重试。`,
      );
    }
    if ((info.mode & 0o777) !== 0o700) {
      await chmod(directory, 0o700);
    }
  }
}

export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 60_000;
  const retryMs = options.retryMs ?? 60;
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(8).toString('hex');

  const directory = lockDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertLockDirectorySafe(directory);

  let acquired = false;
  while (!acquired) {
    acquired = await tryCreate(lockPath, token);
    if (acquired) break;
    if (await removeStale(lockPath, staleMs)) continue;
    if (Date.now() >= deadline) {
      throw new LockedError(
        `另一个 hostscli 实例正在操作（锁文件 ${lockPath}）。请稍后重试；若确认没有实例在运行，可删除该锁文件。`,
      );
    }
    await delay(retryMs);
  }

  try {
    return await action();
  } finally {
    await releaseLock(lockPath, token);
  }
}
