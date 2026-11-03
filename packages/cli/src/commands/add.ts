import type { Command } from 'commander';
import {
  addWorkspaceOptions,
  conflictStrategy,
  printMutation,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

export function registerAddCommand(program: Command): void {
  addWorkspaceOptions(
    program
      .command('add <ip> <hostname...>')
      .description('在托管区块中新增一条记录（多个主机名按每行一个写入）'),
    { json: true, dryRun: true, layer: true, onConflict: true, verify: true },
  )
    .option('--comment <text>', '为条目添加行内注释')
    .action(async (ip: string, hostnames: string[], options) => {
      const { addHosts } = await import('@hostscli/core/crud');
      const filePath = await resolveTargetPath(options);
      warnSystemHosts(filePath, options, '写入');

      const result = await addHosts({
        ...workspaceOptions(options),
        ip,
        hostnames,
        ...(options.comment !== undefined ? { comment: options.comment } : {}),
        ...(options.layer !== undefined ? { layerId: options.layer } : {}),
        onConflict: conflictStrategy(options),
      });

      printMutation(result, options, {
        success: `已添加：${ip} -> ${hostnames.join(', ')}`,
        unchanged: `无需变更：${ip} -> ${hostnames.join(', ')} 已存在。`,
      });
    });
}
