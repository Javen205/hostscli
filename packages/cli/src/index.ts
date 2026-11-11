#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import {
  findCommandEntry,
  registerCommandPlaceholders,
  type CommandEntry,
} from './command-manifest';
import { errorMessage, exitCodeFor } from './errors';
import { binName } from './program-name';

const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };

const HELP_CODES = new Set(['commander.help', 'commander.helpDisplayed', 'commander.version']);

function handleError(error: unknown): void {
  if (error instanceof CommanderError) {
    if (HELP_CODES.has(error.code)) return;
    process.exitCode = 2;
    return;
  }

  process.stderr.write(`${pc.red('错误:')} ${errorMessage(error)}\n`);
  process.exitCode = exitCodeFor(error);
}

/**
 * 只加载命令行实际指定的命令。`--version`、`--help` 与未知命令
 * 走轻量占位注册，不触发 core / cli-table3 / yaml 的模块求值。
 */
function findRequestedCommand(args: string[]): CommandEntry | undefined {
  const firstPositional = args.find((arg) => !arg.startsWith('-'));
  if (!firstPositional || firstPositional === 'help') return undefined;
  return findCommandEntry(firstPositional);
}

/**
 * sudo 下写系统 hosts 时，macOS 会把 HOME 保留为调用者家目录，数据文件因此
 * 落成 root 属主，普通用户之后完全读不了。命令结束时把数据目录内 root 属主
 * 的条目归还给 `SUDO_UID`（只有能确认数据目录属于调用者家目录时才做）。
 * 这是尽力而为的收尾：失败不影响命令退出码。
 */
async function adoptDataOwnership(dataDir: string | undefined): Promise<void> {
  try {
    const [{ resolveDataDir, sudoDataOwner, adoptDataDirOwnership }] = await Promise.all([
      import('@hostscli/core/storage'),
    ]);
    const resolved = resolveDataDir(dataDir);
    const owner = sudoDataOwner({ dataDir: resolved });
    if (owner === null) return;
    await adoptDataDirOwnership(resolved, owner);
  } catch {
    // 属主归还失败不改变命令结果，用户仍可用 sudo chown 手动修复。
  }
}

async function main(): Promise<void> {
  const program = new Command();
  const ownership = { dataDir: undefined as string | undefined, executed: false };

  program
    // 按 argv[1] 的 basename 自适应：`hosts-cli` 调用时 Usage 显示 hosts-cli。
    .name(binName())
    .description('跨平台 hosts 管理 CLI：方案切换、单条 TTL、规则栈与 DNS 诊断')
    .version(packageJson.version)
    .showHelpAfterError()
    .exitOverride();

  program.configureOutput({
    writeErr: (text) => process.stderr.write(text),
  });

  // 审计/undo 历史需要知道实际命令；在 preAction 统一注入，避免每个子命令重复传参。
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const names: string[] = [];
    let cursor: Command | null = actionCommand;
    while (cursor !== null && cursor.parent !== null) {
      names.unshift(cursor.name());
      cursor = cursor.parent;
    }
    process.env.HOSTSCLI_COMMAND = names.join(' ') || actionCommand.name();
    process.env.HOSTSCLI_COMMAND_ARGS = JSON.stringify(process.argv.slice(2));

    ownership.executed = true;
    const options = actionCommand.opts() as { dataDir?: string };
    ownership.dataDir = options.dataDir;
  });

  program.action(() => {
    program.help();
  });

  const requested = findRequestedCommand(process.argv.slice(2));
  if (requested) {
    await requested.register(program);
  } else {
    registerCommandPlaceholders(program);
  }

  try {
    await program.parseAsync(process.argv);
  } finally {
    if (ownership.executed) await adoptDataOwnership(ownership.dataDir);
  }
}

main().catch(handleError);
