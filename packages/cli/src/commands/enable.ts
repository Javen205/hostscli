import type { Command } from 'commander';
import {
  addWorkspaceOptions,
  conflictStrategy,
  printMutation,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

export function registerEnableCommand(program: Command): void {
  addWorkspaceOptions(
    program.command('enable <hostname...>').description('启用托管区块中的记录（并清除 TTL）'),
    { json: true, dryRun: true, layer: true, onConflict: true, verify: true },
  ).action(async (hostnames: string[], options) => {
    const { setHostsEnabled } = await import('@hostscli/core/crud');
    const filePath = await resolveTargetPath(options);
    warnSystemHosts(filePath, options, '写入');

    const result = await setHostsEnabled({
      ...workspaceOptions(options),
      hostnames,
      enabled: true,
      ...(options.layer !== undefined ? { layerId: options.layer } : {}),
      onConflict: conflictStrategy(options),
    });

    printMutation(result, options, {
      success: `已启用：${hostnames.join(', ')}`,
      unchanged: `无需变更：${hostnames.join(', ')} 已经是启用状态。`,
    });
  });
}
