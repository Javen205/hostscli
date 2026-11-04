import type { Command } from 'commander';
import {
  addWorkspaceOptions,
  confirm,
  parseIntOption,
  printJson,
  printWarnings,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

export function registerRestoreCommand(program: Command): void {
  addWorkspaceOptions(program.command('restore').description('从备份恢复 hosts 文件'), {
    json: true,
  })
    .option('--from <file>', '指定备份文件（默认最近一份）')
    .option('--keep <n>', '恢复前保留最近 N 份备份', parseIntOption('--keep', { min: 0 }))
    .option('--yes', '跳过确认')
    .action(async (options) => {
      if (!options.yes && !options.json) {
        const confirmed = await confirm('恢复会覆盖当前 hosts 文件，确认？');
        if (!confirmed) {
          throw Object.assign(new Error('已取消恢复。'), { code: 'CANCELLED' });
        }
      }

      const { restoreHostsBackup } = await import('@hostscli/core/backup');
      const filePath = await resolveTargetPath(options);
      warnSystemHosts(filePath, options, '写入');
      const result = await restoreHostsBackup({
        ...workspaceOptions(options),
        ...(options.from !== undefined ? { backupFile: options.from } : {}),
        ...(options.keep !== undefined ? { keep: options.keep } : {}),
      });

      if (options.json) {
        printJson(result);
        return;
      }
      if (!result.changed) {
        process.stdout.write(`当前 hosts 已与备份一致：${result.restoredFrom}\n`);
        printWarnings(result.warnings);
        return;
      }
      process.stdout.write(`已从备份恢复：${result.restoredFrom}\n`);
      if (result.backupPath) process.stdout.write(`恢复前备份：${result.backupPath}\n`);
      printWarnings(result.warnings);
    });
}
