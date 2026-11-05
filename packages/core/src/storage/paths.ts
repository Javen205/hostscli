import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { InvalidInputError } from '../errors';

export { adoptDataDirOwnership, sudoDataOwner } from './ownership';
export type { AdoptOwnershipDeps, DataOwner, SudoOwnerInput } from './ownership';

export interface DataPaths {
  dataDir: string;
  configPath: string;
  statePath: string;
  profilesDir: string;
  backupsDir: string;
  cacheDir: string;
  auditPath: string;
}

export interface DataPathOptions {
  /** 覆盖数据目录；默认 `HOSSCLI_HOME`，再回退到 `~/.hostscli`。 */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 覆盖 profiles 子目录（来自 config.profilesDir）。 */
  profilesDir?: string;
  /** 覆盖备份目录。 */
  backupDir?: string;
}

export function resolveDataDir(dataDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return dataDir ?? env.HOSSCLI_HOME ?? join(homedir(), '.hostscli');
}

/**
 * profilesDir 来自 config.json，属于不可信输入：必须是数据目录内的相对路径。
 * 否则 `../../etc` 之类的值会让 profile 写入逃逸到数据目录之外。
 * 该函数同时用于 `config set` 写入前校验，避免把配置写坏后所有命令都无法启动。
 */
export function assertSafeProfilesDir(profilesDir: string): void {
  const segments = profilesDir.split(/[\\/]+/);
  const driveRelative = /^[A-Za-z]:/.test(profilesDir);
  if (
    profilesDir === '' ||
    posix.isAbsolute(profilesDir) ||
    win32.isAbsolute(profilesDir) ||
    driveRelative ||
    segments.includes('..')
  ) {
    throw new InvalidInputError(
      `配置项 profilesDir 必须是数据目录内的相对路径（当前：${profilesDir}）。`,
    );
  }
}

function resolveProfilesDir(dataDir: string, profilesDir: string | undefined): string {
  if (profilesDir === undefined) return join(dataDir, 'profiles');
  assertSafeProfilesDir(profilesDir);
  return join(dataDir, profilesDir);
}

export function resolveDataPaths(options: DataPathOptions = {}): DataPaths {
  const dataDir = resolveDataDir(options.dataDir, options.env ?? process.env);
  const profilesDir = resolveProfilesDir(dataDir, options.profilesDir);

  return {
    dataDir,
    configPath: join(dataDir, 'config.json'),
    statePath: join(dataDir, 'state.json'),
    profilesDir,
    backupsDir: options.backupDir ?? join(dataDir, 'backups'),
    cacheDir: join(dataDir, 'cache'),
    auditPath: join(dataDir, 'audit.log'),
  };
}

/**
 * 锁目录直接使用系统临时目录本身（POSIX 用 /tmp 的真实路径）：
 * 系统 hosts 可能不可写，锁不应依赖提权；而 /tmp 由 root 拥有并带粘滞位，
 * 既允许任意用户创建自己的锁文件，又只有属主（或 root）能删除。
 *
 * 不再使用 `/tmp/hostscli-locks` 子目录：子目录属主会成为单点阻塞——
 * 普通用户先运行过一次后，目录属主是普通用户，root（sudo 写系统 hosts 的
 * 主场景）就会因属主校验而无法使用。放在 /tmp 本身则不存在“目录属主”问题。
 */
export function lockDirectory(): string {
  if (process.platform === 'win32') return join(tmpdir(), 'hostscli-locks');
  try {
    return realpathSync('/tmp');
  } catch {
    return '/tmp';
  }
}
