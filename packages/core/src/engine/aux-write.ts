import type { ChangeSummary } from './history';
import { appendAudit, currentOperator, recordAuditFailure } from './audit';
import type { Workspace } from './context';
import { appendRuntimeLog } from '../system/runtime-log';
import type { RuntimeLogLevel } from '../system/runtime-log';

function commandFromEnv(): string {
  const value = process.env.HOSTSCLI_COMMAND?.trim();
  return value && value.length > 0 ? value : 'write';
}

function argsFromEnv(): string[] | undefined {
  const raw = process.env.HOSTSCLI_COMMAND_ARGS;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed as string[];
    }
  } catch {
    // 环境变量损坏时忽略，不影响主操作。
  }
  return undefined;
}

export interface RuntimeLogInput {
  level?: RuntimeLogLevel;
  command?: string;
  args?: string[];
  event: string;
  detail?: string;
}

/**
 * 写一条运行日志（非审计）。开关默认开启，可用 `config set logging.enabled false` 关闭。
 * 日志失败不影响主流程，因此这里不返回错误、也不抛出。
 */
export async function logRuntime(workspace: Workspace, input: RuntimeLogInput): Promise<void> {
  if (!workspace.config.logging.enabled) return;
  const args = input.args && input.args.length > 0 ? input.args : argsFromEnv();
  await appendRuntimeLog(
    workspace.dataDir,
    {
      at: workspace.now.toISOString(),
      level: input.level ?? 'info',
      command: input.command ?? commandFromEnv(),
      ...(args ? { args } : {}),
      event: input.event,
      ...(input.detail ? { detail: input.detail } : {}),
    },
    { keep: workspace.config.logging.keep },
  );
}

export interface AuxAuditInput {
  command: string;
  args?: string[];
  /** 人可读的变更说明；不要放密码、token 或完整订阅 URL。 */
  detail?: string;
  /** 被改动文件（或状态）的前后指纹，沿用 audit.log 的 sha256 格式。 */
  beforeSha256?: string | null;
  afterSha256?: string | null;
  summary?: ChangeSummary;
  changed?: boolean;
}

/**
 * 记录一次"不经过 commitPlan 但确有落盘"的操作。
 *
 * 与主写入一致：审计失败绝不回滚或阻断主操作，改为写 `audit-unaudited.jsonl`
 * 并给出 warning，让 `audit verify` 能发现缺口。
 */
export async function auditAuxWrite(
  workspace: Workspace,
  input: AuxAuditInput,
  warnings: string[] = [],
): Promise<boolean> {
  try {
    await appendAudit(
      workspace.paths.auditPath,
      {
        at: workspace.now.toISOString(),
        action: 'write-ok',
        ok: true,
        hostsPath: workspace.hostsPath,
        command: input.command,
        ...(input.args && input.args.length > 0 ? { commandArgs: input.args } : {}),
        operator: currentOperator(),
        beforeSha256: input.beforeSha256 ?? null,
        afterSha256: input.afterSha256 ?? null,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
        changed: input.changed ?? true,
      },
      { keep: workspace.config.defaults.auditKeep },
    );
  } catch (error) {
    await recordAuditFailure(workspace.dataDir, {
      at: workspace.now.toISOString(),
      command: input.command,
      detail: String(error),
    });
    warnings.push(
      `操作已完成，但审计记录失败（${input.command}）；audit verify 会报告未审计操作。`,
    );
    await logRuntime(workspace, {
      level: 'warn',
      command: input.command,
      event: 'audit-failure',
      detail: String(error),
    });
    return false;
  }

  await logRuntime(workspace, {
    command: input.command,
    args: input.args,
    event: 'write-ok',
    detail: input.detail,
  });
  return true;
}
