import type { Command } from 'commander';
import { printJson, printWarnings } from './common';

export function registerDnsCommand(program: Command): void {
  const dns = program.command('dns').description('DNS 缓存操作');

  dns
    .command('flush')
    .description('刷新系统 DNS 缓存')
    .option('--json', '以 JSON 输出')
    .action(async (options: { json?: boolean }) => {
      const { currentPlatformId, flushDns } = await import('@hostscli/core/system');
      const result = await flushDns(currentPlatformId());
      if (options.json) {
        printJson(result);
      } else if (result.ok) {
        process.stdout.write('已刷新 DNS 缓存。\n');
      } else {
        process.stderr.write(`${result.detail ?? 'DNS 缓存刷新失败。'}\n`);
      }
      printWarnings(result.ok ? [] : result.detail ? [result.detail] : []);
      if (!result.ok) process.exitCode = 6;
    });
}
