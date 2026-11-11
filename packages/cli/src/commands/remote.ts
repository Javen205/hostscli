import type { Command } from 'commander';
import pc from 'picocolors';
import { binName } from '../program-name';
import {
  addDataDirOption,
  parseIntOption,
  parsePriorityOption,
  printJson,
  printWarnings,
  workspaceOptions,
} from './common';

export function registerRemoteCommand(program: Command): void {
  const remote = program.command('remote').description('管理远程 hosts 订阅（拉取为规则层）');

  addDataDirOption(remote.command('add <id>').description('登记一个远程订阅（不会立即下载）'), {
    json: true,
  })
    .requiredOption('--url <url>', '订阅地址（http/https）')
    .option('--profile <id>', '生成的方案 ID（默认与订阅 ID 相同）')
    .option('--name <name>', '方案显示名')
    .option('--priority <n>', '方案优先级', parsePriorityOption)
    .option('--activate', '同时把该方案加入启用集合')
    .option('--disabled', '登记为停用（remote update 默认跳过）')
    .action(async (id: string, options) => {
      const { addRemoteSource } = await import('@hostscli/core/remote');
      const result = await addRemoteSource({
        ...workspaceOptions({ dataDir: options.dataDir }),
        id,
        url: options.url,
        ...(options.profile !== undefined ? { profileId: options.profile } : {}),
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
        enabled: !options.disabled,
        activate: Boolean(options.activate),
      });

      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        `已登记订阅 ${result.source.id} → ${result.source.url}（方案 ${result.source.profileId ?? result.source.id}）。\n`,
      );
      process.stdout.write(pc.dim(`运行 ${binName()} remote update ${id} 拉取内容。\n`));
      printWarnings(result.warnings);
    });

  addDataDirOption(remote.command('list').description('列出订阅与缓存状态'), {
    json: true,
  }).action(async (options) => {
    const { listRemoteSources } = await import('@hostscli/core/remote');
    const result = await listRemoteSources(workspaceOptions({ dataDir: options.dataDir }));
    if (options.json) {
      printJson(result);
      return;
    }
    if (result.sources.length === 0) {
      process.stdout.write(`（没有订阅，可用 ${binName()} remote add <id> --url <url> 添加）\n`);
      return;
    }
    const { default: Table } = await import('cli-table3');
    const table = new Table({
      head: ['ID', 'URL', 'PROFILE', 'CACHED', 'UPDATED', 'ENABLED'],
      style: { head: [], border: [] },
      wordWrap: false,
    });
    for (const view of result.sources) {
      table.push([
        view.source.id,
        view.source.url,
        view.profileId,
        view.cached ? `${view.bytes ?? 0} B` : pc.dim('no'),
        view.cachedAt ?? '-',
        view.source.enabled ? pc.green('yes') : pc.dim('no'),
      ]);
    }
    process.stdout.write(`${table.toString()}\n`);
  });

  addDataDirOption(remote.command('remove <id>').description('移除订阅登记与缓存'), {
    json: true,
  }).action(async (id: string, options) => {
    const { removeRemoteSource } = await import('@hostscli/core/remote');
    const result = await removeRemoteSource({
      ...workspaceOptions({ dataDir: options.dataDir }),
      id,
    });
    if (options.json) {
      printJson(result);
      return;
    }
    process.stdout.write(`已移除订阅 ${result.removed}。\n`);
    printWarnings(result.warnings);
  });

  addDataDirOption(
    remote.command('update [id]').description('拉取订阅并更新对应方案（缺省更新全部启用的订阅）'),
    { json: true },
  )
    .option('--force', '忽略 ETag/Last-Modified 与内容哈希，强制重新下载')
    .option('--timeout <ms>', '请求超时（毫秒）', parseIntOption('--timeout', { min: 1 }))
    .option('--max-bytes <n>', '响应体大小上限（字节）', parseIntOption('--max-bytes', { min: 1 }))
    .action(async (id: string | undefined, options) => {
      const { updateRemoteSources } = await import('@hostscli/core/remote');
      const result = await updateRemoteSources({
        ...workspaceOptions({ dataDir: options.dataDir }),
        ...(id !== undefined ? { id } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      });

      if (options.json) {
        printJson(result);
      } else {
        const { default: Table } = await import('cli-table3');
        const table = new Table({
          head: ['ID', 'STATUS', 'BYTES', 'PROFILE'],
          style: { head: [], border: [] },
          wordWrap: false,
        });
        for (const item of result.results) {
          const status =
            item.status === 'updated'
              ? pc.green(item.status)
              : item.status === 'not-modified'
                ? pc.dim(item.status)
                : pc.red(item.status);
          table.push([
            item.id,
            status,
            String(item.bytes ?? '-'),
            `${item.profileId}${item.profileUpdated ? '' : ' (unchanged)'}`,
          ]);
        }
        process.stdout.write(`${table.toString()}\n`);
      }
      printWarnings(result.warnings);
      if (result.failed > 0) {
        process.exitCode = 6;
      }
    });
}
