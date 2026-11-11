import type { Command } from 'commander';
import pc from 'picocolors';
import { binName } from '../program-name';
import {
  addDataDirOption,
  addWorkspaceOptions,
  parseIntOption,
  printJson,
  printWarnings,
  workspaceOptions,
} from './common';

export function registerGitCommand(program: Command): void {
  const git = program.command('git').description('数据目录快照（独立 git 仓库，不触碰系统 hosts）');

  addDataDirOption(git.command('init').description('初始化数据目录快照仓库（幂等）'), {
    json: true,
  }).action(async (options) => {
    const { gitInit } = await import('@hostscli/core/git');
    const result = await gitInit(workspaceOptions({ dataDir: options.dataDir }));
    if (options.json) {
      printJson(result);
      return;
    }
    process.stdout.write(`已初始化：${result.gitDir}\n`);
  });

  addDataDirOption(git.command('status').description('显示快照仓库状态'), { json: true }).action(
    async (options) => {
      const { gitStatusOf } = await import('@hostscli/core/git');
      const result = await gitStatusOf(workspaceOptions({ dataDir: options.dataDir }));
      if (options.json) {
        printJson(result);
        return;
      }
      if (!result.initialized) {
        process.stdout.write(pc.dim(`尚未初始化快照仓库；运行 ${binName()} git init。\n`));
        return;
      }
      process.stdout.write(`仓库：${result.gitDir}\n`);
      process.stdout.write(`HEAD：${result.head ?? '（还没有快照）'}\n`);
      process.stdout.write(`工作区：${result.dirty ? '有未快照变更' : '干净'}\n`);
    },
  );

  addDataDirOption(git.command('snapshot').description('把数据目录当前内容提交为一个快照'), {
    json: true,
  })
    .option('-m, --message <text>', '快照说明')
    .action(async (options) => {
      const { gitSnapshot } = await import('@hostscli/core/git');
      const result = await gitSnapshot({
        ...workspaceOptions({ dataDir: options.dataDir }),
        ...(options.message !== undefined ? { message: options.message } : {}),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        result.created
          ? `已创建快照 ${result.commit?.slice(0, 7)}（${result.message}）\n`
          : pc.dim(`${result.message}\n`),
      );
    });

  addDataDirOption(git.command('log').description('列出快照历史'), { json: true })
    .option(
      '--limit <n>',
      '最多显示条数（1–200，默认 20）',
      parseIntOption('--limit', { min: 1, max: 200 }),
    )
    .action(async (options) => {
      const { gitLog } = await import('@hostscli/core/git');
      const result = await gitLog({
        ...workspaceOptions({ dataDir: options.dataDir }),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      if (result.entries.length === 0) {
        process.stdout.write(pc.dim('还没有快照。\n'));
        return;
      }
      for (const entry of result.entries) {
        process.stdout.write(`${pc.cyan(entry.hash.slice(0, 7))} ${entry.date} ${entry.subject}\n`);
      }
    });

  addDataDirOption(git.command('diff').description('比较快照与当前数据目录'), { json: true })
    .option('--rev <rev>', '提交哈希（默认 HEAD）')
    .action(async (options) => {
      const { gitDiff } = await import('@hostscli/core/git');
      const result = await gitDiff({
        ...workspaceOptions({ dataDir: options.dataDir }),
        ...(options.rev !== undefined ? { rev: options.rev } : {}),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(result.diff || pc.dim('没有差异。\n'));
    });

  addWorkspaceOptions(
    git.command('rollback <rev>').description('恢复数据目录并重建 hosts（默认重建）'),
    { json: true },
  )
    .option('--no-rebuild', '只恢复数据目录，不重建 hosts')
    .action(async (rev: string, options) => {
      const { gitRollback } = await import('@hostscli/core/git');
      const result = await gitRollback({
        ...workspaceOptions(options),
        rev,
        rebuild: options.rebuild !== false,
      });
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        `已恢复到 ${result.restored.slice(0, 7)}（记录为新快照 ${result.commit.slice(0, 7)}）\n`,
      );
      if (result.mutation) {
        process.stdout.write(
          result.mutation.changed ? '已按恢复后的规则重建 hosts。\n' : pc.dim('hosts 无需变更。\n'),
        );
      }
      printWarnings(result.warnings);
    });
}
