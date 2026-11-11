import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Command } from 'commander';
import pc from 'picocolors';
import { constants as osConstants } from 'node:os';
import { binName } from '../program-name';
import type { CommonOptions } from './common';
import {
  addDataDirOption,
  addWorkspaceOptions,
  printJson,
  printWarnings,
  workspaceOptions,
} from './common';

/**
 * 父命令与子命令都声明了同名 workspace 选项时，子命令未显式传入的项是 undefined。
 * 直接展开会把父命令的取值覆盖成 undefined，因此只合并有值的项。
 */
function inheritedOptions(parent: Command | undefined, options: CommonOptions): CommonOptions {
  const merged: CommonOptions = { ...(parent?.opts() ?? {}) };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

interface RunCliOptions {
  host?: string;
  ip?: string;
  file?: string;
  dataDir?: string;
  skipDnsFlush?: boolean;
  verify?: boolean;
}

async function findExecutable(name: string): Promise<string | null> {
  const hasSeparator = name.includes('/') || (process.platform === 'win32' && name.includes('\\'));
  if (hasSeparator) {
    try {
      await access(name, fsConstants.X_OK);
      return name;
    } catch {
      return null;
    }
  }

  const pathValue = process.env.PATH ?? '';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = `${dir}${sep}${name}${extension}`;
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // 继续找下一个候选。
      }
    }
  }
  return null;
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const map = osConstants.signals as Record<string, number | undefined>;
  return 128 + (map[signal] ?? 1);
}

async function runCommand(options: RunCliOptions, command: string[]): Promise<void> {
  if (!options.host || !options.ip) {
    throw Object.assign(new Error('run 需要 --host <hostname> 与 --ip <addr>。'), {
      code: 'INVALID_INPUT',
    });
  }
  if (command.length === 0) {
    throw Object.assign(new Error('run 需要在 -- 之后指定要执行的命令。'), {
      code: 'INVALID_INPUT',
    });
  }

  const executable = await findExecutable(command[0] as string);
  if (executable === null) {
    throw Object.assign(new Error(`找不到可执行文件：${command[0]}`), { code: 'INVALID_INPUT' });
  }

  const { startRun, finishRun } = await import('@hostscli/core/run');
  const started = await startRun({
    hostname: options.host,
    ip: options.ip,
    command,
    ...workspaceOptions(options),
  });
  printWarnings(started.mutation.warnings);

  let child: ChildProcess;
  try {
    child = spawn(executable, command.slice(1), {
      stdio: 'inherit',
      env: process.env,
      windowsHide: false,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
  } catch (error) {
    process.stderr.write(pc.red(`启动命令失败：${(error as Error).message}\n`));
    await finishRun(started.session.sessionId, workspaceOptions(options)).catch(() => undefined);
    throw Object.assign(error as Error, { code: 'INVALID_INPUT' });
  }

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);

  let exitCode: number | undefined;
  try {
    exitCode = await new Promise<number>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve(signal !== null ? exitCodeForSignal(signal) : (code ?? 1));
      });
    });
  } finally {
    for (const signal of signals) process.off(signal, forward);
    try {
      const cleanup = await finishRun(started.session.sessionId, workspaceOptions(options));
      printWarnings(cleanup.warnings);
    } catch (error) {
      process.stderr.write(
        pc.yellow(
          `警告：临时条目清理失败，稍后可执行 ${binName()} run gc 回收：${(error as Error).message}\n`,
        ),
      );
    }
  }

  process.exitCode = exitCode ?? 1;
}

export function registerRunCommand(program: Command): void {
  const run = program
    .command('run')
    .description('命令存活期间临时生效的 hosts 条目（退出后自动移除）')
    .option('--host <hostname>', '临时条目的主机名')
    .option('--ip <addr>', '临时条目解析到的地址')
    .argument('[command...]', '要执行的命令（建议用 -- 分隔）');

  // `--file/--data-dir` 只声明在父命令：Commander 会把同名选项挂到父命令，
  // 子命令 action 通过 command.parent.opts() 读取，避免值被子命令覆盖成默认值。
  addWorkspaceOptions(run, { verify: true }).action(async (command: string[], options) => {
    await runCommand(options, command);
  });

  addDataDirOption(
    run.command('list').description('列出 run 会话租约（orphan 表示父进程已退出）'),
    { json: true },
  ).action(async (options, command) => {
    const merged = inheritedOptions(command.parent, options);
    const { listRuns } = await import('@hostscli/core/run');
    const result = await listRuns(workspaceOptions(merged));
    if (options.json) {
      printJson(result);
      return;
    }
    if (result.sessions.length === 0) {
      process.stdout.write(pc.dim('没有 run 会话。\n'));
      return;
    }
    for (const session of result.sessions) {
      const state = session.orphan ? pc.yellow('orphan') : pc.green('alive');
      process.stdout.write(
        `${session.sessionId} ${state} pid=${session.pid} ${session.hostnames.join(', ')} → ${session.ip}\n`,
      );
    }
  });

  addWorkspaceOptions(
    run.command('gc').description('回收父进程已退出的 run 会话（不触碰仍在运行的会话）'),
    { json: true },
  )
    .option('--dry-run', '只列出将回收的会话，不写入')
    .option('--force', '忽略进程存活判断，回收所有会话（pid 复用兜底）')
    .action(async (options, command) => {
      const merged = inheritedOptions(command.parent, options);
      const { gcRuns } = await import('@hostscli/core/run');
      const result = await gcRuns({
        ...workspaceOptions(merged),
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.force ? { force: true } : {}),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      if (result.removed.length === 0) {
        process.stdout.write(pc.dim('没有可回收的孤儿会话。\n'));
        return;
      }
      process.stdout.write(
        `${result.dryRun ? '将回收' : '已回收'} ${result.removed.length} 个会话：${result.removed
          .map((session) => session.sessionId)
          .join(', ')}\n`,
      );
      printWarnings(result.warnings);
    });
}
