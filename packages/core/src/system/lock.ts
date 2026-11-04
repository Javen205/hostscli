import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
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
  /** 测试/嵌入：覆盖锁目录，默认 `lockDirectory()`。 */
  directory?: string;
  /** 测试/嵌入：覆盖 euid，默认 `process.getuid()`。 */
  euid?: number;
  /** 测试/嵌入：判断 pid 是否存活，默认用 signal 0 探测。 */
  isProcessAlive?: (pid: number) => boolean;
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
  return join(lockDirectory(), `.hostscli-${digest}.lock`);
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
  return join(lockDirectory(), `.hostscli-data-${digest}.lock`);
}

/**
 * `kill(pid, 0)` 抛 EPERM 说明进程存在、只是属于别的用户。sudo 与普通用户
 * 交替运行的场景下很常见；此时必须按“存活”处理，否则会误删他人正在用的锁。
 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * 锁文件用 O_CREAT 的独占创建做互斥，权限 0644：其他用户可读 pid、
 * 但不能改写内容；删除受 /tmp 粘滞位保护（只有属主与 root 能删）。
 * 因此锁的“属主”不再是判据，root 与普通用户可交替使用同一把锁。
 */
async function tryCreate(lockPath: string, token: string, uid: number): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx', 0o644);
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, uid, token, startedAt: new Date().toISOString() }),
      );
      // umask 可能收紧权限，显式补齐读位，保证其他 euid 能读到 pid 做陈旧判断。
      await handle.chmod(0o644).catch(() => undefined);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // 他人预建的同名目录：按“已被占用”处理，交给 removeStale 给出明确错误。
    if (code === 'EISDIR') return false;
    throw error;
  }
}

async function unlinkOrKeep(lockPath: string): Promise<boolean> {
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    // 粘滞位目录：非 root 无法删除别人创建的锁文件。不能抢锁，
    // 交给超时路径提示需要 root 手动清理。
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw error;
  }
}

async function removeStale(
  lockPath: string,
  staleMs: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile()) {
      throw new LockedError(
        `锁路径 ${lockPath} 不是普通文件（可能是他人预建的目录或符号链接），拒绝使用；` +
          '确认没有实例在运行后，可由 root 删除。',
      );
    }
    // 先读 PID：持有者已退出时锁立即失效，不必等 staleMs。
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
        pidAlive = isProcessAlive(content.pid);
      }
    } catch {
      // 锁内容损坏，按无法判断存活处理。
    }

    if (pidKnown && !pidAlive) return unlinkOrKeep(lockPath);
    if (pidKnown && pidAlive) return false;
    if (Date.now() - info.mtimeMs < staleMs) return false;

    return unlinkOrKeep(lockPath);
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

function formatMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8)}`;
}

/**
 * 锁目录可信度校验（POSIX）：
 * - 必须是真实目录，拒绝符号链接；
 * - 权限必须正好是 01777（粘滞位 + 全员可创建）。粘滞位保证只有锁文件
 *   属主或 root 能删除文件，避免任意用户抢占别人的锁；
 * - 属主可信的条件：root（任何 euid 都能用）、当前 euid 自己、或当前是 root。
 *
 * 默认锁目录是 /tmp 的真实路径（root 属主 + 1777），因此普通用户与 sudo
 * 都能直接使用，不需要也不允许修改 /tmp 的权限。
 */
async function assertLockDirectorySafe(directory: string, euid: number): Promise<void> {
  if (process.platform === 'win32') return;
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LockedError(`锁目录 ${directory} 不存在，拒绝使用。`);
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LockedError(`锁目录 ${directory} 不是可信目录（符号链接或非目录），拒绝使用。`);
  }

  const owner = info.uid;
  const mode = info.mode & 0o7777;
  // root 始终可信；root 拥有的共享目录对普通用户也可用；自属主目录仅对当前 euid 可用。
  if (!(owner === 0 || owner === euid || euid === 0)) {
    throw new LockedError(
      `锁目录 ${directory} 属主 uid=${owner}，当前 euid=${euid}，两者不一致，拒绝使用；` +
        '请由 root 删除该目录或把属主改为 root 后重试。',
    );
  }
  if (mode !== 0o1777) {
    throw new LockedError(
      `锁目录 ${directory} 权限 ${formatMode(mode)}，应为 01777（粘滞位 + 全员可创建），拒绝使用；` +
        `当前 euid=${euid}，属主 uid=${owner}。`,
    );
  }
}

async function buildLockedMessage(lockPath: string, euid: number): Promise<string> {
  let holder = '';
  try {
    const content = JSON.parse(await readFile(lockPath, 'utf8')) as {
      pid?: number;
      uid?: number;
    };
    if (typeof content.pid === 'number') {
      holder = `，持有者 pid=${content.pid}`;
      if (typeof content.uid === 'number') holder += ` uid=${content.uid}`;
    }
  } catch {
    // 锁内容不可读时只报路径。
  }
  return (
    `另一个 hostscli 实例正在操作（锁文件 ${lockPath}${holder}；当前 euid=${euid}）。` +
    `请稍后重试；若确认没有实例在运行，root 可删除该锁文件（sudo rm -f ${lockPath}），` +
    '普通用户遇到 root 遗留的锁时也需要 sudo 清理。'
  );
}

export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 60_000;
  const retryMs = options.retryMs ?? 60;
  const directory = options.directory ?? lockDirectory();
  const euid = options.euid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(8).toString('hex');

  if (process.platform === 'win32') {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } else {
    try {
      await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(directory, { recursive: true, mode: 0o1777 });
      await chmod(directory, 0o1777);
    }
  }
  await assertLockDirectorySafe(directory, euid);

  let acquired = false;
  while (!acquired) {
    acquired = await tryCreate(lockPath, token, euid);
    if (acquired) break;
    if (await removeStale(lockPath, staleMs, isProcessAlive)) continue;
    if (Date.now() >= deadline) {
      throw new LockedError(await buildLockedMessage(lockPath, euid));
    }
    await delay(retryMs);
  }

  try {
    return await action();
  } finally {
    await releaseLock(lockPath, token);
  }
}
