import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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

export function resolveDataPaths(options: DataPathOptions = {}): DataPaths {
  const dataDir = resolveDataDir(options.dataDir, options.env ?? process.env);
  const profilesDir = options.profilesDir
    ? join(dataDir, options.profilesDir)
    : join(dataDir, 'profiles');

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
 * 锁目录固定放在系统临时目录下（POSIX 用 /tmp）：系统 hosts 文件可能不可写，
 * 锁不应依赖提权。固定路径便于在获取锁时校验目录属主与权限，防止被他人预建。
 */
export function lockDirectory(): string {
  if (process.platform === 'win32') return join(tmpdir(), 'hostscli-locks');
  return '/tmp/hostscli-locks';
}
