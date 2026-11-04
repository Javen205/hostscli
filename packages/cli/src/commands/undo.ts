import type { Command } from 'commander';
import pc from 'picocolors';
import {
  addWorkspaceOptions,
  parseIntOption,
  printJson,
  printWarnings,
  workspaceOptions,
} from './common';

export function registerUndoCommand(program: Command): void {
  const command = program
    .command('undo')
    .description('撤销最近 N 次成功写入（hosts + state + 相关方案）')
    .option(
      '--steps <n>',
      '撤销最近多少次写入（1–100，默认 1）',
      parseIntOption('--steps', { min: 1, max: 100 }),
      1,
    );
  addWorkspaceOptions(command, { json: true, dryRun: true, verify: true }).action(
    async (options) => {
      const { undoHosts } = await import('@hostscli/core/undo');
      const result = await undoHosts({
        ...workspaceOptions(options),
        steps: options.steps,
        // 显式 --dry-run 与配置无关，永远不写。
        ...(options.dryRun ? { dryRun: true } : {}),
      });

      if (options.json) {
        printJson({
          changed: result.changed,
          dryRun: result.dryRun,
          steps: result.steps,
          records: result.records,
          diff: result.diff,
          warnings: result.warnings,
        });
        return;
      }

      if (result.dryRun) {
        if (result.diff) process.stdout.write(result.diff);
        else process.stdout.write(pc.dim('只有 state / 方案变化，hosts 内容不变。\n'));
        printWarnings(result.warnings);
        return;
      }

      process.stdout.write(
        `${pc.green('已撤销')} ${result.steps} 次写入：${result.records
          .map((record) => `${record.id}(${record.command})`)
          .join(' → ')}\n`,
      );
      printWarnings(result.warnings);
    },
  );
}
