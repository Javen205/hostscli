import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { InvalidInputError } from '../errors';
import { validateEntryInput } from '../hosts/validation';
import { profilePath, readProfile } from '../profiles/store';
import type { Profile } from '../profiles/store';
import type { SessionRecord } from '../storage/state';
import { appendAudit, currentOperator, recordAuditFailure } from './audit';
import { commitPlan } from './commit';
import type { Workspace, WorkspaceOptions } from './context';
import { withWorkspace } from './context';
import { prepare } from './crud';
import { resolveActiveLayers } from './layers';
import { buildRenderPlan } from './plan';
import type { MutationResult } from './types';

export interface RunStartOptions extends WorkspaceOptions {
  hostname: string;
  ip: string;
  command: string[];
}

export interface RunStartResult {
  session: SessionRecord;
  hostsPath: string;
  mutation: MutationResult;
}

export interface RunFinishResult {
  changed: boolean;
  removed: boolean;
  mutation: MutationResult | null;
  warnings: string[];
}

export interface RunView extends SessionRecord {
  alive: boolean;
  orphan: boolean;
}

export interface RunListResult {
  sessions: RunView[];
}

export interface RunGcResult {
  changed: boolean;
  dryRun: boolean;
  removed: RunView[];
  warnings: string[];
}

function sessionLayerId(): string {
  return `session-${randomBytes(4).toString('hex')}`;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但属于其他用户。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function toView(session: SessionRecord): RunView {
  const alive = isPidAlive(session.pid);
  return { ...session, alive, orphan: !alive };
}

/**
 * 启动一个 run 会话：在当前活动层之上临时追加一条高优先级规则。
 * 会话层在命令存活期间一直生效；清理与回收都走同一把工作区锁和 commitPlan。
 */
export async function startRun(options: RunStartOptions): Promise<RunStartResult> {
  if (!Array.isArray(options.command) || options.command.length === 0) {
    throw new InvalidInputError('run 需要在 -- 之后指定要执行的命令。');
  }
  const input = validateEntryInput({ ip: options.ip, hostnames: [options.hostname] });

  return withWorkspace(options, async (workspace) => {
    const { loaded, warnings } = await prepare(workspace);
    const active = await resolveActiveLayers(workspace, loaded.document, { persist: true });

    const layerId = sessionLayerId();
    // 始终高于当前所有活动层，保证会话期间同名主机名解析到 run 指定的 IP，
    // 同时避免与用户恰好等于固定值的优先级形成平局。
    const sessionPriority =
      active.profiles.reduce((highest, profile) => Math.max(highest, profile.priority), 0) + 1;
    const profile: Profile = {
      schemaVersion: 1,
      id: layerId,
      name: 'run 临时会话',
      priority: sessionPriority,
      entries: [
        {
          ip: input.ip,
          hostnames: input.hostnames,
          enabled: true,
          comment: 'hostscli run 临时条目',
        },
      ],
      ephemeral: true,
    };

    const startedAt = workspace.now.toISOString();
    const session: SessionRecord = {
      sessionId: layerId,
      layerId,
      pid: process.pid,
      ip: input.ip,
      hostnames: input.hostnames,
      command: [...options.command],
      startedAt,
      heartbeatAt: startedAt,
    };

    workspace.state.activeLayers = [
      ...workspace.state.activeLayers.filter((id) => id !== layerId),
      layerId,
    ];
    workspace.state.sessions = [
      ...workspace.state.sessions.filter((record) => record.sessionId !== layerId),
      session,
    ];

    const plan = buildRenderPlan(workspace, loaded, [...active.profiles, profile], {
      appendIfMissing: true,
      onConflict: 'highest-priority',
    });
    const mutation = await commitPlan(workspace, plan, {
      profiles: [profile],
      persistState: true,
      warnings,
      command: 'run',
      args: [...options.command],
    });

    return { session, hostsPath: workspace.hostsPath, mutation };
  });
}

async function removeSession(
  workspace: Workspace,
  session: SessionRecord,
  command: string,
  args: string[],
): Promise<{ warnings: string[]; mutation: MutationResult | null }> {
  const warnings: string[] = [];
  workspace.state.activeLayers = workspace.state.activeLayers.filter(
    (id) => id !== session.layerId,
  );
  workspace.state.sessions = workspace.state.sessions.filter(
    (record) => record.sessionId !== session.sessionId,
  );

  let sessionProfile: Profile | null = null;
  try {
    sessionProfile = await readProfile(workspace.paths.profilesDir, session.layerId);
  } catch {
    warnings.push(`会话层 ${session.layerId} 的方案文件已不存在，跳过方案清理。`);
  }

  const { loaded, warnings: prepareWarnings } = await prepare(workspace);
  warnings.push(...prepareWarnings);
  const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
  const plan = buildRenderPlan(workspace, loaded, profiles, {
    appendIfMissing: loaded.document.managedRange !== null || profiles.length > 0,
  });
  const mutation = await commitPlan(workspace, plan, {
    // 把会话方案也纳入历史快照（内容不变，但删除后需要能由 undo 恢复）。
    profiles: sessionProfile ? [sessionProfile] : [],
    persistState: true,
    warnings,
    command,
    args,
    deleteProfiles: [session.layerId],
  });

  try {
    await unlink(profilePath(workspace.paths.profilesDir, session.layerId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`删除会话方案 ${session.layerId} 失败：${String(error)}`);
    }
  }
  return { warnings, mutation };
}

/** 结束指定会话：移除临时条目并重建已启用层。重复调用是幂等的。 */
export async function finishRun(
  sessionId: string,
  options: WorkspaceOptions = {},
): Promise<RunFinishResult> {
  return withWorkspace(options, async (workspace) => {
    const session = workspace.state.sessions.find((record) => record.sessionId === sessionId);
    if (session === undefined) {
      return {
        changed: false,
        removed: false,
        mutation: null,
        warnings: [`会话 ${sessionId} 不存在或已清理。`],
      };
    }

    const { warnings, mutation } = await removeSession(workspace, session, 'run', [
      'cleanup',
      sessionId,
    ]);
    try {
      await appendAudit(
        workspace.paths.auditPath,
        {
          at: workspace.now.toISOString(),
          action: 'run-cleanup',
          ok: true,
          hostsPath: workspace.hostsPath,
          command: 'run',
          operator: currentOperator(),
          detail: `会话 ${sessionId} 结束，移除 ${session.hostnames.join(', ')} → ${session.ip}。`,
        },
        { keep: workspace.config.defaults.auditKeep },
      );
    } catch (error) {
      await recordAuditFailure(workspace.dataDir, {
        at: workspace.now.toISOString(),
        command: 'run',
        detail: String(error),
      });
      warnings.push('会话已清理，但审计写入失败；audit verify 会报告存在未审计操作。');
    }
    return { changed: true, removed: true, mutation, warnings };
  });
}

/** 列出会话租约；`alive=false` 表示父进程已不在，可用 `run gc` 回收。 */
export async function listRuns(options: WorkspaceOptions = {}): Promise<RunListResult> {
  return withWorkspace(options, async (workspace) => ({
    sessions: workspace.state.sessions.map(toView),
  }));
}

/**
 * 回收父进程已退出（被强杀）的会话。只处理 pid 已不存在的记录；
 * 仍在运行的会话不会被误删。
 */
export async function gcRuns(
  options: WorkspaceOptions & { dryRun?: boolean } = {},
): Promise<RunGcResult> {
  return withWorkspace(options, async (workspace) => {
    const orphans = workspace.state.sessions.map(toView).filter((session) => session.orphan);
    if (orphans.length === 0) {
      return { changed: false, dryRun: Boolean(options.dryRun), removed: [], warnings: [] };
    }
    if (workspace.dryRun) {
      return {
        changed: false,
        dryRun: true,
        removed: orphans,
        warnings: [`将回收 ${orphans.length} 个孤儿会话。`],
      };
    }

    const warnings: string[] = [];
    for (const orphan of orphans) {
      const session = workspace.state.sessions.find(
        (record) => record.sessionId === orphan.sessionId,
      );
      if (session === undefined) continue;
      const result = await removeSession(workspace, session, 'run', ['gc', session.sessionId]);
      warnings.push(...result.warnings);
    }

    try {
      await appendAudit(
        workspace.paths.auditPath,
        {
          at: workspace.now.toISOString(),
          action: 'run-gc',
          ok: true,
          hostsPath: workspace.hostsPath,
          command: 'run gc',
          operator: currentOperator(),
          detail: `回收 ${orphans.length} 个孤儿会话：${orphans.map((session) => session.sessionId).join(', ')}。`,
        },
        { keep: workspace.config.defaults.auditKeep },
      );
    } catch (error) {
      await recordAuditFailure(workspace.dataDir, {
        at: workspace.now.toISOString(),
        command: 'run gc',
        detail: String(error),
      });
      warnings.push('孤儿会话已回收，但审计写入失败；audit verify 会报告存在未审计操作。');
    }

    return { changed: true, dryRun: false, removed: orphans, warnings };
  });
}
