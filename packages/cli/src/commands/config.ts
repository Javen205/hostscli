import type { Command } from 'commander';
import { addDataDirOption, printJson, workspaceOptions } from './common';

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('查看与修改配置');

  addDataDirOption(config.command('show').description('显示当前配置与配置路径'), {
    json: true,
  }).action(async (options) => {
    const { showConfig } = await import('@hostscli/core/config');
    const result = await showConfig(workspaceOptions(options));
    if (options.json) {
      printJson(result);
      return;
    }
    process.stdout.write(`配置路径：${result.configPath}\n`);
    process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
  });

  addDataDirOption(config.command('set <key> <value>').description('修改一个配置项'), {
    json: true,
  }).action(async (key: string, value: string, options) => {
    const { updateConfig } = await import('@hostscli/core/config');
    const result = await updateConfig(key, value, workspaceOptions(options));
    if (options.json) {
      printJson(result);
      return;
    }
    process.stdout.write(`已设置 ${key} = ${value}（${result.configPath}）。\n`);
  });

  addDataDirOption(config.command('keys').description('列出可修改的配置项'), {
    json: true,
  }).action(async (options) => {
    const { availableConfigKeys } = await import('@hostscli/core/config');
    const keys = availableConfigKeys();
    if (options.json) {
      printJson({ keys });
      return;
    }
    process.stdout.write(`${keys.join('\n')}\n`);
  });
}
