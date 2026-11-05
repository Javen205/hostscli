import { statSync } from 'node:fs';
import { chown, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export interface DataOwner {
  uid: number;
  gid: number;
}

export interface SudoOwnerInput {
  dataDir: string;
  /** 默认 `process.getuid()`；测试可注入。 */
  euid?: number;
  env?: NodeJS.ProcessEnv;
  /** 默认 `os.homedir()`。 */
  homeDir?: string;
  /** 默认家目录的真实属主；测试可注入。 */
  homeOwnerUid?: number;
}

function currentEuid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

function homeOwner(homeDir: string): number | undefined {
  try {
    return statSync(homeDir).uid;
  } catch {
    return undefined;
  }
}

/**
 * 判断当前进程是否应当把数据目录的写入结果"归还"给发起 sudo 的用户。
 *
 * macOS 的 `sudo` 会保留 `HOME`（指向调用者家目录），所以 README 里推荐的
 * `sudo hostscli add` 会以 root 身份往 `~/.hostscli` 写 0600 文件；之后普通
 * 用户读这些文件就是 EACCES，数据目录被永久"毒化"。这里只在能明确判定
 * "数据目录属于 sudo 调用者的家目录"时才返回目标属主：
 * - 必须是 root（euid=0），且存在有效的 `SUDO_UID` / `SUDO_GID`；
 * - 数据目录必须位于 `HOME` 之内；
 * - `HOME` 的属主必须等于 `SUDO_UID`（Linux 的 sudo 把 HOME 改成 /root，
 *   属主是 0，因此不会误改 root 自己的数据目录）。
 *
 * 其余情况返回 null，表示不改动任何属主。
 */
export function sudoDataOwner(input: SudoOwnerInput): DataOwner | null {
  const euid = input.euid ?? currentEuid();
  const env = input.env ?? process.env;
  if (euid !== 0) return null;

  const uid = Number(env.SUDO_UID);
  const gid = Number(env.SUDO_GID);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  if (!Number.isInteger(gid) || gid < 0) return null;

  const home = resolve(input.homeDir ?? homedir());
  const dataDir = resolve(input.dataDir);
  if (dataDir !== home && !dataDir.startsWith(`${home}${sep}`)) return null;

  const owner = input.homeOwnerUid ?? homeOwner(home);
  if (owner !== uid) return null;

  return { uid, gid };
}

export interface AdoptOwnershipDeps {
  /** 读取属主，默认 `lstat`。测试可注入。 */
  ownerOf?: (path: string) => Promise<{ uid: number; gid: number }>;
  /** 修改属主，默认 `chown`。测试可注入。 */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
}

async function defaultOwnerOf(path: string): Promise<{ uid: number; gid: number }> {
  const info = await lstat(path);
  return { uid: info.uid, gid: info.gid };
}

/**
 * 把数据目录内不属于 `owner` 的文件/目录归还给 `owner`，返回实际改动条数。
 *
 * 由 CLI 在命令结束时调用：sudo 写入期间文件只能是 root 属主（创建者决定
 * 属主），命令结束再统一归还，普通用户随后即可正常读。符号链接跳过，避免
 * 顺着链接改到数据目录之外。这里尽力而为：单条失败不阻断命令退出。
 */
export async function adoptDataDirOwnership(
  dataDir: string,
  owner: DataOwner | null,
  deps: AdoptOwnershipDeps = {},
): Promise<number> {
  if (owner === null) return 0;
  const ownerOf = deps.ownerOf ?? defaultOwnerOf;
  const change = deps.chown ?? chown;

  let changed = 0;

  async function adopt(path: string): Promise<void> {
    try {
      const current = await ownerOf(path);
      if (current.uid === owner!.uid && current.gid === owner!.gid) return;
      await change(path, owner!.uid, owner!.gid);
      changed += 1;
    } catch {
      // 尽力而为：文件可能已消失或属主不允许修改，不影响命令结果。
    }
  }

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // 目录在递归末尾统一归还，避免在父层重复调用 chown。
        await walk(path);
        continue;
      }
      await adopt(path);
    }
    await adopt(directory);
  }

  await walk(resolve(dataDir));
  return changed;
}
