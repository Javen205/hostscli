import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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
 * 路径字符串可能因符号链接别名而不同（macOS 的 /tmp 与 /private/tmp、
 * Linux 的 /var 与 /private/var）。锁键必须先归一化到真实路径，
 * 否则同一份 hosts / 同一个数据目录会拿到两把不同的锁。
 */
function canonicalPath(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    // 文件尚不存在时，归一化父目录即可覆盖目录别名。
  }
  try {
    return join(realpathSync.native(dirname(resolved)), basename(resolved));
  } catch {
    return resolved;
  }
}

/**
 * 由 hosts 路径生成稳定锁名。
 *
 * 锁按 hosts 文件取键，保证任意两个实例对同一份 hosts 的写入是串行的。
 * 但串行不等于合并：两个 dataDir 各自持有独立的 profiles/state，后写者会
 * 按自己的规则整段重建 hosts，先写者的条目因此消失。**不支持多个 dataDir
 * 共用同一份 hosts**；需要多套规则时请在同一个 dataDir 内用 profile/layer。
 * `dataDir` 参数仅为兼容旧调用保留，不参与锁名计算。
 */
export function lockPathFor(hostsPath: string, _dataDir?: string): string {
  const digest = createHash('sha256').update(canonicalPath(hostsPath)).digest('hex').slice(0, 16);
  return join(lockDirectory(), `${digest}.lock`);
}

/**
 * 数据目录单独一把锁：不同 `--file` 但同一数据目录的实例也会互相阻塞，
 * 避免 profile/state/config 被并发改写。
 */
export function lockPathForDataDir(dataDir: string): string {
  const digest = createHash('sha256')
    .update(`data\u0000${canonicalPath(dataDir)}`)
    .digest('hex')
    .slice(0, 16);
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
    // 先读 PID：持有者已退出时，锁立即失效，不应再等 staleMs。
    // 只有无法判断存活（内容损坏 / 无 pid）时才退回时间门槛，
    // 避免把刚创建、内容尚未写完的锁误删。
    let pidKnown = false;
    let pidAlive = true;
    try {
      const content = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number };
      if (typeof content.pid === 'number') {
        pidKnown = true;
        // 同一进程内并发调用时，锁一定仍然有效，不能按时间清理。
        if (content.pid === process.pid) return false;
        try {
          process.kill(content.pid, 0);
          pidAlive = true;
        } catch {
          pidAlive = false;
        }
      }
    } catch {
      // 锁内容损坏，按无法判断存活处理。
    }

    if (pidKnown && !pidAlive) {
      await unlink(lockPath).catch(() => undefined);
      return true;
    }
    if (pidKnown && pidAlive) return false;
    if (Date.now() - info.mtimeMs < staleMs) return false;

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
