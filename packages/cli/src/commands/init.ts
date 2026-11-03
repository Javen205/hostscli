import type { Command } from 'commander';
import {
  addWorkspaceOptions,
  conflictStrategy,
  printMutation,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

export function registerInitCommand(program: Command): void {
  addWorkspaceOptions(program.command('init').description('初始化数据目录与托管区块（幂等）'), {
    json: true,
    dryRun: true,
    onConflict: true,
    verify: true,
  }).action(async (options) => {
    const { initHosts } = await import('@hostscli/core/crud');
    const filePath = await resolveTargetPath(options);
    warnSystemHosts(filePath, options, '写入');

    const result = await initHosts({
      ...workspaceOptions(options),
      onConflict: conflictStrategy(options),
    });
    printMutation(result, options, {
      success: '已初始化托管区块。',
      unchanged: '托管区块已存在，无需变更。',
    });
  });
}

export function registerApplyCommand(program: Command): void {
  addWorkspaceOptions(program.command('apply').description('按当前生效规则重建托管区块'), {
    json: true,
    dryRun: true,
    onConflict: true,
    verify: true,
  }).action(async (options) => {
    const { applyHosts } = await import('@hostscli/core/crud');
    const filePath = await resolveTargetPath(options);
    warnSystemHosts(filePath, options, '写入');

    const result = await applyHosts({
      ...workspaceOptions(options),
      onConflict: conflictStrategy(options),
    });
    printMutation(result, options, {
      success: '已按规则集重建托管区块。',
      unchanged: '托管区块已是最新，无需变更。',
    });
  });
}
