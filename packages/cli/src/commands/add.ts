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
    .option('--profile <id>', '写入指定方案（等价于 --layer；未指定时写入当前生效方案）')
    .action(async (ip: string, hostnames: string[], options) => {
      if (
        options.profile !== undefined &&
        options.layer !== undefined &&
        options.profile !== options.layer
      ) {
        throw Object.assign(
          new Error(
            `--profile 与 --layer 指向不同方案（${options.profile} / ${options.layer}）；` +
              '二者等价，请只保留一个。',
          ),
          { code: 'INVALID_INPUT' },
        );
      }
      const layerId = options.profile ?? options.layer;

      const { addHosts } = await import('@hostscli/core/crud');
      const filePath = await resolveTargetPath(options);
      warnSystemHosts(filePath, options, '写入');

      const result = await addHosts({
        ...workspaceOptions(options),
        ip,
        hostnames,
        ...(options.comment !== undefined ? { comment: options.comment } : {}),
        ...(layerId !== undefined ? { layerId } : {}),
        onConflict: conflictStrategy(options),
      });

      printMutation(result, options, {
        success: `已添加：${ip} -> ${hostnames.join(', ')}`,
        unchanged: `无需变更：${ip} -> ${hostnames.join(', ')} 已存在。`,
      });
    });
}
