import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HostsCliError, InvalidInputError } from '../errors';
import { loadConfig } from '../storage/config';
import { resolveDataPaths } from '../storage/paths';
import { loadState } from '../storage/state';
import { commitPlan } from './commit';
import type { WorkspaceOptions } from './context';
import { withWorkspace } from './context';
import { prepare } from './crud';
import { resolveActiveLayers } from './layers';
import { buildRenderPlan } from './plan';
import type { MutationResult } from './types';

const execFileAsync = promisify(execFile);

const MARKER_NAME = 'HOSTSCLI_GIT_MARKER';
const MARKER_CONTENT = 'hostscli data-dir repository v1\n';
const MAX_COMMIT_MESSAGE = 200;

/**
 * 数据目录内的独立 git 目录。必须用标准的 `.git`：git 2.52 在 work-tree 内
 * 放一个“子仓库”目录时会把该目录当成子模块处理，导致索引损坏（实测），
 * 因此不能使用 `.hostscli-git` 之类的自造目录名。
 */
const GIT_DIR_NAME = '.git';

export function gitDirFor(dataDir: string): string {
  return join(dataDir, GIT_DIR_NAME);
}

function markerPathFor(dataDir: string): string {
  return join(gitDirFor(dataDir), MARKER_NAME);
}

/** 只允许提交哈希（4–40 位十六进制）作为版本参数，避免参数注入与歧义。 */
const REV_PATTERN = /^[0-9a-fA-F]{4,40}$/;

export function assertGitRev(rev: string): string {
  const value = rev.trim();
  if (!REV_PATTERN.test(value)) {
    throw new InvalidInputError(
      `版本必须是 git 提交哈希（4–40 位十六进制），例如 0123abcd；收到：${rev}`,
    );
  }
  return value.toLowerCase();
}

export type GitRunner = (args: string[]) => Promise<string>;

interface GitOptions {
  dataDir: string;
  runner?: GitRunner;
}

function defaultRunner(dataDir: string): GitRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: dataDir,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return stdout;
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HostsCliError(
          'UNSUPPORTED_PLATFORM',
          '未找到 git 可执行文件；请先安装 git 后再使用快照命令。',
        );
      }
      // git 失败属于本地仓库/环境冲突，不是网络错误（退出码 6）。
      throw new HostsCliError('CONFLICT', `git 执行失败（git ${args.join(' ')}）：${detail}`);
    }
  };
}

function baseArgs(dataDir: string): string[] {
  return [`--git-dir=${gitDirFor(dataDir)}`, `--work-tree=${dataDir}`];
}

/** 已存在但不是 hostscli 创建的 git 目录：拒绝操作，避免误改用户仓库。 */
async function assertMarker(dataDir: string): Promise<void> {
  try {
    const content = await readFile(markerPathFor(dataDir), 'utf8');
    if (content === MARKER_CONTENT) return;
  } catch {
    // 找不到标记，按未初始化处理。
  }
  throw new InvalidInputError(
    `数据目录内存在 ${GIT_DIR_NAME}，但不是 hostscli 创建的（缺少标记文件）。` +
      ' 为避免误操作，已拒绝；请手动检查或移除该目录后重试。',
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(options: GitOptions): Promise<void> {
  const gitDir = gitDirFor(options.dataDir);
  const runner = options.runner ?? defaultRunner(options.dataDir);

  if (await exists(join(gitDir, MARKER_NAME))) {
    await assertMarker(options.dataDir);
    return;
  }
  if (await exists(join(gitDir, 'HEAD'))) {
    await assertMarker(options.dataDir);
  }
  const gitDirInfo = await stat(gitDir).catch(() => null);
  if (gitDirInfo && !gitDirInfo.isDirectory()) {
    throw new InvalidInputError(
      `${gitDirFor(options.dataDir)} 已存在且不是目录（可能是 git worktree 的 .git 文件）；` +
        ' 请换一个数据目录，或手动处理后重试。',
    );
  }

  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(gitDir, { recursive: true, mode: 0o700 });
  await runner([...baseArgs(options.dataDir), '-c', 'init.defaultBranch=main', 'init', '--quiet']);

  // 提交身份与关键行为只写入本地配置，不依赖、也不修改用户的全局 git 配置。
  await runner([...baseArgs(options.dataDir), 'config', 'user.name', 'hostscli']);
  await runner([...baseArgs(options.dataDir), 'config', 'user.email', 'hostscli@localhost']);
  await runner([...baseArgs(options.dataDir), 'config', 'commit.gpgsign', 'false']);
  await runner([...baseArgs(options.dataDir), 'config', 'core.autocrlf', 'false']);
  // 避免用户全局 core.hooksPath 在快照时执行任意钩子。
  await runner([...baseArgs(options.dataDir), 'config', 'core.hooksPath', join(gitDir, 'hooks')]);

  await writeFile(markerPathFor(options.dataDir), MARKER_CONTENT, { mode: 0o600 });
  // audit / cache / backups 体积大或含运行态，不进入快照。
  await writeFile(
    join(gitDir, 'info', 'exclude'),
    [
      'audit.log',
      'audit.log.chain.json',
      'audit-unaudited.jsonl',
      'cache/',
      'backups/',
      'history/',
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
}

function normalizeMessage(message: string | undefined): string {
  const value = (message ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return `snapshot ${new Date().toISOString()}`;
  return value.slice(0, MAX_COMMIT_MESSAGE);
}

/** 把当前工作区提交为快照；没有变更时返回 null。调用方必须已持有工作区锁。 */
async function commitWorkTree(dataDir: string, message: string): Promise<string | null> {
  const runner = defaultRunner(dataDir);
  const status = await runner([...baseArgs(dataDir), 'status', '--porcelain']);
  if (status.trim() === '') return null;

  await runner([...baseArgs(dataDir), 'add', '-A', '--', '.']);
  await runner([...baseArgs(dataDir), 'commit', '--quiet', '-m', message]);
  return (await runner([...baseArgs(dataDir), 'rev-parse', 'HEAD'])).trim();
}

/**
 * git 只记录可执行位，`read-tree -u` 恢复出的 config/state/profiles 会变成 0644。
 * 这些文件含订阅 URL / TTL 理由等用户数据，恢复后显式收紧到 0600。
 */
async function enforcePrivateModes(dataDir: string, profilesDir: string): Promise<void> {
  const targets = [join(dataDir, 'config.json'), join(dataDir, 'state.json')];
  try {
    const names = await readdir(profilesDir);
    for (const name of names) {
      if (name.endsWith('.json')) targets.push(join(profilesDir, name));
    }
  } catch {
    // profiles 目录不存在或不可读时跳过。
  }
  await Promise.all(targets.map((path) => chmod(path, 0o600).catch(() => undefined)));
}

export interface GitStatusResult {
  initialized: boolean;
  gitDir: string;
  head: string | null;
  dirty: boolean;
}

export interface GitSnapshotOptions extends WorkspaceOptions {
  message?: string;
}

export interface GitSnapshotResult {
  created: boolean;
  commit: string | null;
  message: string;
}

export interface GitLogEntry {
  hash: string;
  date: string;
  subject: string;
}

export interface GitDiffOptions extends WorkspaceOptions {
  /** 与某个提交比较；默认 HEAD。 */
  rev?: string;
}

export interface GitRollbackOptions extends WorkspaceOptions {
  rev: string;
  /** 恢复数据后是否立即重建 hosts（默认 true）。 */
  rebuild?: boolean;
}

export interface GitRollbackResult {
  restored: string;
  commit: string;
  /** 回滚前为未快照变更自动创建的保护快照；没有未快照变更时为 null。 */
  safetyCommit: string | null;
  mutation: MutationResult | null;
  warnings: string[];
}

async function gitStatus(options: GitOptions): Promise<GitStatusResult> {
  const runner = options.runner ?? defaultRunner(options.dataDir);
  const gitDir = gitDirFor(options.dataDir);
  if (!(await exists(join(gitDir, MARKER_NAME)))) {
    return { initialized: false, gitDir, head: null, dirty: false };
  }
  await assertMarker(options.dataDir);

  let head: string | null;
  try {
    head = (await runner([...baseArgs(options.dataDir), 'rev-parse', '--short', 'HEAD'])).trim();
  } catch {
    head = null;
  }
  const status = await runner([...baseArgs(options.dataDir), 'status', '--porcelain']);
  return { initialized: true, gitDir, head, dirty: status.trim() !== '' };
}

export async function gitStatusOf(options: WorkspaceOptions = {}): Promise<GitStatusResult> {
  return withWorkspace(options, async (workspace) => gitStatus({ dataDir: workspace.dataDir }));
}

/** 在数据目录初始化独立 git 仓库（幂等）；已存在非 hostscli 仓库时拒绝。 */
export async function gitInit(options: WorkspaceOptions = {}): Promise<GitStatusResult> {
  return withWorkspace(options, async (workspace) => {
    await ensureRepo({ dataDir: workspace.dataDir });
    return gitStatus({ dataDir: workspace.dataDir });
  });
}

export async function gitSnapshot(options: GitSnapshotOptions = {}): Promise<GitSnapshotResult> {
  return withWorkspace(options, async (workspace) => {
    const message = normalizeMessage(options.message);
    await ensureRepo({ dataDir: workspace.dataDir });

    const commit = await commitWorkTree(workspace.dataDir, message);
    if (commit === null) {
      return { created: false, commit: null, message: '数据目录没有变更，未创建快照。' };
    }
    return { created: true, commit, message };
  });
}

export async function gitLog(
  options: WorkspaceOptions & { limit?: number } = {},
): Promise<{ entries: GitLogEntry[] }> {
  return withWorkspace(options, async (workspace) => {
    const runner = defaultRunner(workspace.dataDir);
    if (!(await exists(join(gitDirFor(workspace.dataDir), MARKER_NAME)))) {
      return { entries: [] };
    }
    await assertMarker(workspace.dataDir);

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    try {
      await runner([...baseArgs(workspace.dataDir), 'rev-parse', '--verify', 'HEAD']);
    } catch {
      // 还没有任何提交（unborn HEAD）。
      return { entries: [] };
    }
    const output = await runner([
      ...baseArgs(workspace.dataDir),
      'log',
      `--max-count=${limit}`,
      '--format=%H%x00%cI%x00%s',
    ]);
    const entries = output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line): GitLogEntry => {
        const [hash = '', date = '', subject = ''] = line.split('\u0000');
        return { hash, date, subject };
      });
    return { entries };
  });
}

export async function gitDiff(
  options: GitDiffOptions = {},
): Promise<{ rev: string; diff: string }> {
  return withWorkspace(options, async (workspace) => {
    const runner = defaultRunner(workspace.dataDir);
    const rev = options.rev ? assertGitRev(options.rev) : 'HEAD';
    if (!(await exists(join(gitDirFor(workspace.dataDir), MARKER_NAME)))) {
      throw new InvalidInputError('数据目录尚未初始化 git 快照；先运行 hostscli git init。');
    }
    await assertMarker(workspace.dataDir);

    // 先确认目标提交存在：unborn HEAD 或错误哈希直接给出可操作的提示，
    // 而不是把 git 的 "ambiguous argument" 当成网络错误（退出码 6）。
    try {
      await runner([
        ...baseArgs(workspace.dataDir),
        'rev-parse',
        '--verify',
        rev === 'HEAD' ? 'HEAD' : `${rev}^{commit}`,
      ]);
    } catch {
      throw new InvalidInputError(
        rev === 'HEAD'
          ? '数据目录还没有任何快照；先运行 hostscli git snapshot。'
          : `找不到提交 ${rev}；可用 hostscli git log 查看。`,
      );
    }

    const diff = await runner([...baseArgs(workspace.dataDir), 'diff', rev, '--', '.']);
    return { rev, diff };
  });
}

/**
 * 回滚数据目录到指定快照：
 * 1) 恢复被跟踪文件（config / state / profiles）；
 * 2) 以新提交记录这次恢复，保留历史；
 * 3) 重新解析启用的层并重建 hosts（默认开启）。
 * 快照之后新增的未跟踪文件不会被删除，只在 warnings 中列出。
 */
export async function gitRollback(options: GitRollbackOptions): Promise<GitRollbackResult> {
  return withWorkspace(options, async (workspace) => {
    const runner = defaultRunner(workspace.dataDir);
    const rev = assertGitRev(options.rev);
    if (!(await exists(join(gitDirFor(workspace.dataDir), MARKER_NAME)))) {
      throw new InvalidInputError('数据目录尚未初始化 git 快照；先运行 hostscli git init。');
    }
    await assertMarker(workspace.dataDir);

    let commitHash: string;
    try {
      commitHash = (
        await runner([...baseArgs(workspace.dataDir), 'rev-parse', '--verify', `${rev}^{commit}`])
      ).trim();
    } catch {
      throw new InvalidInputError(`找不到提交 ${rev}；可用 hostscli git log 查看。`);
    }

    const warnings: string[] = [];
    // 回滚会覆盖工作区；先把未快照变更提交为保护快照，避免这些内容在历史里无法找回。
    const safetyCommit = await commitWorkTree(
      workspace.dataDir,
      `auto snapshot before rollback to ${commitHash.slice(0, 7)}`,
    );
    if (safetyCommit) {
      warnings.push(
        `检测到未快照变更，已先创建保护快照 ${safetyCommit.slice(0, 7)}（可用 hostscli git log 查看）。`,
      );
    }

    await runner([...baseArgs(workspace.dataDir), 'read-tree', '--reset', '-u', commitHash]);
    await runner([
      ...baseArgs(workspace.dataDir),
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      `rollback to ${commitHash.slice(0, 7)}`,
    ]);

    // git 只记录可执行位，恢复后的用户数据需显式收紧权限。
    await enforcePrivateModes(workspace.dataDir, workspace.paths.profilesDir);

    const untracked = (
      await runner([
        ...baseArgs(workspace.dataDir),
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ])
    )
      .split('\n')
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(3).trim());
    if (untracked.length > 0) {
      warnings.push(
        `以下文件在快照之后新增且未被删除（git 回滚只恢复被跟踪文件）：${untracked.join(', ')}`,
      );
    }
    const rollbackCommit = (
      await runner([...baseArgs(workspace.dataDir), 'rev-parse', 'HEAD'])
    ).trim();

    // config / state / profiles 已被覆盖，必须重新从磁盘读取，不能复用内存里的旧状态。
    const previousConfig = workspace.config;
    const config = await loadConfig(workspace.paths.configPath, workspace.env);
    const nextPaths = resolveDataPaths({
      dataDir: workspace.dataDir,
      env: workspace.env,
      profilesDir: config.profilesDir,
      backupDir: workspace.options.backupDir,
    });
    if (config.profilesDir !== previousConfig.profilesDir) {
      warnings.push(
        `config.json 的 profilesDir 已变化（${config.profilesDir}）；后续命令将使用 ${nextPaths.profilesDir}。`,
      );
      await enforcePrivateModes(workspace.dataDir, nextPaths.profilesDir);
    }
    workspace.config = config;
    workspace.paths = nextPaths;

    let mutation: MutationResult | null = null;
    if (options.rebuild !== false) {
      if (config.hostsPath && config.hostsPath !== previousConfig.hostsPath) {
        warnings.push(
          `config.json 的 hostsPath 已变化（${config.hostsPath}），本次仍写入 ${workspace.hostsPath}；请重新运行命令使新路径生效。`,
        );
      }
      workspace.state = await loadState(workspace.paths.statePath);

      const { loaded, warnings: prepareWarnings } = await prepare(workspace);
      warnings.push(...prepareWarnings);
      const { profiles } = await resolveActiveLayers(workspace, loaded.document, {
        persist: true,
      });
      const plan = buildRenderPlan(workspace, loaded, profiles, {
        appendIfMissing: loaded.document.managedRange !== null || profiles.length > 0,
      });
      mutation = await commitPlan(workspace, plan, { persistState: true, warnings });
    }

    return {
      restored: commitHash,
      commit: rollbackCommit,
      safetyCommit,
      mutation,
      warnings,
    };
  });
}
