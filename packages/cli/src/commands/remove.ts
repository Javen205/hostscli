import type { Command } from 'commander';
import {
  addWorkspaceOptions,
  conflictStrategy,
  printMutation,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

export function registerRemoveCommand(program: Command): void {
  addWorkspaceOptions(
    program.command('remove <hostname...>').description('从托管区块移除记录（整条记录）'),
    { json: true, dryRun: true, layer: true, onConflict: true, verify: true },
  ).action(async (hostnames: string[], options) => {
    const { removeHosts } = await import('@hostscli/core/crud');
    const filePath = await resolveTargetPath(options);
    warnSystemHosts(filePath, options, '写入');

    const result = await removeHosts({
      ...workspaceOptions(options),
      hostnames,
      ...(options.layer !== undefined ? { layerId: options.layer } : {}),
      onConflict: conflictStrategy(options),
    });

    printMutation(result, options, {
      success: `已移除：${hostnames.join(', ')}`,
      unchanged: `无需变更：${hostnames.join(', ')} 不存在。`,
    });
  });
}
