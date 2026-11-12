import type { Command } from 'commander';
import pc from 'picocolors';
import { addWorkspaceOptions, parseIntOption, printJson, workspaceOptions } from './common';
import { binName } from '../program-name';

export function registerBackupCommand(program: Command): void {
  addWorkspaceOptions(program.command('backup').description('手动创建 hosts 备份'), {
    json: true,
    dnsFlush: false,
  })
    .option('--list', '列出已有备份（新→旧）')
    .option('--keep <n>', '保留最近 N 份备份', parseIntOption('--keep', { min: 0 }))
    .action(async (options) => {
      if (options.list) {
        const { listHostsBackups } = await import('@hostscli/core/backup');
        const { backupDir, files } = await listHostsBackups(workspaceOptions(options));
        if (options.json) {
          printJson({ backupDir, files });
          return;
        }
        if (files.length === 0) {
          process.stdout.write(`（没有备份：${backupDir}）\n`);
          return;
        }
        process.stdout.write(files.map((file) => file).join('\n') + '\n');
        return;
      }

      const { createHostsBackup } = await import('@hostscli/core/backup');
      const backup = await createHostsBackup({
        ...workspaceOptions(options),
        ...(options.keep !== undefined ? { keep: options.keep } : {}),
      });

      if (options.json) {
        printJson({ backupPath: backup });
        return;
      }
      process.stdout.write(`已创建备份：${backup}\n`);
      process.stdout.write(
        pc.dim(`提示：恢复可用 ${binName()} restore 或 --from 指定这份备份。\n`),
      );
    });
}
