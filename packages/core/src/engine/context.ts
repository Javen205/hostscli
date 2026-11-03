import { readFile } from 'node:fs/promises';
import type { HostsDocument } from '../hosts/models';
import { parseHosts } from '../hosts/parser';
import { loadConfig } from '../storage/config';
import type { HostsCliConfig } from '../storage/config';
import { defaultState, loadState } from '../storage/state';
import type { HostsCliState } from '../storage/state';
import { resolveDataPaths } from '../storage/paths';
import type { DataPaths } from '../storage/paths';
import { currentPlatformId, defaultEolFor, resolveHostsPath } from '../system/platform';
import type { PlatformId } from '../system/platform';
import { lockPathFor, lockPathForDataDir, withFileLock } from '../system/lock';
import { HostsFormatError, PermissionError } from '../errors';

export interface WorkspaceOptions {
  /** 覆盖 hosts 文件路径（优先级最高）。 */
  filePath?: string;
  /** 覆盖 `~/.hostscli` 数据目录（测试与多机隔离）。 */
  dataDir?: string;
  /** 覆盖备份目录。 */
  backupDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试注入固定时间。 */
  now?: Date;
  dryRun?: boolean;
  /** 覆盖配置中的 DNS 刷新开关。 */
  dnsFlush?: boolean;
  /** 写入后用 getaddrinfo 复核托管域名；失败自动回滚并写 audit。 */
  verify?: boolean;
  /** 测试注入解析函数（verify 用）；生产环境不要设置。 */
  verifyLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface Workspace {
  options: WorkspaceOptions;
  env: NodeJS.ProcessEnv;
  now: Date;
  dryRun: boolean;
  verify: boolean;
  dataDir: string;
  paths: DataPaths;
  config: HostsCliConfig;
  state: HostsCliState;
  /**
   * 本次事务开始（任何调用方改动之前）的 state 深拷贝。
   * undo 历史需要用它与写入后的 state 计算条目级变更摘要。
   */
  initialState: HostsCliState;
  hostsPath: string;
  platformId: PlatformId;
}

export interface LoadedHosts {
  raw: Buffer | null;
  document: HostsDocument;
}

export async function openWorkspace(options: WorkspaceOptions = {}): Promise<Workspace> {
  const env = options.env ?? process.env;
  const initialPaths = resolveDataPaths({ dataDir: options.dataDir, env });
  const config = await loadConfig(initialPaths.configPath, env);
  const paths = resolveDataPaths({
    dataDir: options.dataDir,
    env,
    profilesDir: config.profilesDir,
    backupDir: options.backupDir,
  });
  const platformId = currentPlatformId();
  const hostsPath = options.filePath ?? config.hostsPath ?? resolveHostsPath(process.platform, env);

  return {
    options,
    env,
    now: options.now ?? new Date(),
    dryRun: options.dryRun ?? false,
    verify: options.verify ?? config.defaults.verifyAfterApply,
    dataDir: paths.dataDir,
    paths,
    config,
    // 真实状态在拿到锁之后再读取，避免两个实例读到同一份旧状态。
    state: defaultState(),
    initialState: defaultState(),
    hostsPath,
    platformId,
  };
}

/** 在跨进程锁内执行完整事务。 */
export async function withWorkspace<T>(
  options: WorkspaceOptions,
  action: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  const workspace = await openWorkspace(options);
  // 两把锁：hosts 文件 + 数据目录。按路径排序获取，避免两个实例交换顺序造成死锁。
  const locks = [
    lockPathFor(workspace.hostsPath, workspace.dataDir),
    lockPathForDataDir(workspace.dataDir),
  ].sort();
  return withFileLock(locks[0] as string, async () =>
    withFileLock(locks[1] as string, async () => {
      workspace.state = await loadState(workspace.paths.statePath);
      workspace.initialState = structuredClone(workspace.state);
      return action(workspace);
    }),
  );
}

export async function loadHostsDocument(
  workspace: Workspace,
  allowMissing: boolean,
): Promise<LoadedHosts> {
  let raw: Buffer | null = null;
  try {
    raw = await readFile(workspace.hostsPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new PermissionError(
        workspace.hostsPath,
        `没有读取 hosts 文件的权限：${workspace.hostsPath}`,
      );
    }
    if (code !== 'ENOENT' || !allowMissing) {
      throw new HostsFormatError(
        `无法读取 hosts 文件 ${workspace.hostsPath}（${code ?? '未知错误'}）。`,
      );
    }
  }

  const document = parseHosts(raw ?? Buffer.alloc(0), {
    platformDefaultEol: defaultEolFor(workspace.platformId),
  });
  return { raw, document };
}

export function shouldFlushDns(workspace: Workspace): boolean {
  return workspace.options.dnsFlush ?? workspace.config.defaults.dnsFlush;
}
