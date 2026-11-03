import type { Command } from 'commander';
import {
  addWorkspaceOptions,
  printJson,
  printMutation,
  printWarnings,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

function ttlJson(result: {
  now: string;
  records: Array<{
    hostnames: string[];
    ip: string | null;
    record: {
      layerId: string;
      expiresAt: string;
      paused: boolean;
      status: string;
      reason?: string;
    };
    remainingMs: number;
  }>;
}): Record<string, unknown> {
  return {
    now: result.now,
    records: result.records.map((view) => ({
      hostname: view.hostnames.join(', '),
      hostnames: view.hostnames,
      ip: view.ip,
      layerId: view.record.layerId,
      expiresAt: view.record.expiresAt,
      remainingMs: view.remainingMs,
      paused: view.record.paused,
      status: view.record.status,
      ...(view.record.reason !== undefined ? { reason: view.record.reason } : {}),
    })),
  };
}

export function registerTtlCommand(program: Command): void {
  const ttl = program.command('ttl').description('管理单条记录的 TTL 定时禁用');

  addWorkspaceOptions(ttl.command('list').description('列出 TTL 记录与倒计时'), { json: true })
    .option('--within <duration>', '只显示该时长内到期的记录')
    .action(async (options) => {
      const { listTtl } = await import('@hostscli/core/ttl');
      const result = await listTtl({
        ...workspaceOptions(options),
        ...(options.within !== undefined ? { within: options.within } : {}),
      });
      if (options.json) {
        printJson(ttlJson(result));
        return;
      }
      const { renderTtlTable } = await import('../output/table');
      process.stdout.write(`${renderTtlTable(result.records)}\n`);
    });

  addWorkspaceOptions(ttl.command('due').description('列出即将到期的 TTL（默认 1 天）'), {
    json: true,
  })
    .option('--within <duration>', '到期窗口，默认 1d')
    .action(async (options) => {
      const { listTtl } = await import('@hostscli/core/ttl');
      const result = await listTtl({
        ...workspaceOptions(options),
        within: options.within ?? '1d',
      });
      if (options.json) {
        printJson(ttlJson(result));
        return;
      }
      const { renderTtlTable } = await import('../output/table');
      process.stdout.write(`${renderTtlTable(result.records)}\n`);
    });

  addWorkspaceOptions(ttl.command('pause <hostname>').description('暂停 TTL 倒计时'), {
    json: true,
    layer: true,
  }).action(async (hostname: string, options) => {
    const [{ pauseTtl }, { formatRemaining }] = await Promise.all([
      import('@hostscli/core/ttl'),
      import('@hostscli/core/duration'),
    ]);
    const record = await pauseTtl({
      ...workspaceOptions(options),
      hostname,
      ...(options.layer !== undefined ? { layerId: options.layer } : {}),
    });
    if (options.json) {
      printJson(record);
      return;
    }
    process.stdout.write(
      `已暂停 ${hostname} 的 TTL（暂停时剩余 ${formatRemaining(record.remainingMs ?? 0)}）。\n`,
    );
  });

  addWorkspaceOptions(ttl.command('resume <hostname>').description('恢复 TTL 倒计时'), {
    json: true,
    layer: true,
  }).action(async (hostname: string, options) => {
    const { resumeTtl } = await import('@hostscli/core/ttl');
    const record = await resumeTtl({
      ...workspaceOptions(options),
      hostname,
      ...(options.layer !== undefined ? { layerId: options.layer } : {}),
    });
    if (options.json) {
      printJson(record);
      return;
    }
    process.stdout.write(`已恢复 ${hostname} 的 TTL，到期时间 ${record.expiresAt}。\n`);
  });

  addWorkspaceOptions(ttl.command('extend <hostname>').description('重置 TTL 到期时间'), {
    json: true,
    layer: true,
  })
    .requiredOption('--for <duration>', '新的时长，例如 90m')
    .action(async (hostname: string, options) => {
      const { extendTtl } = await import('@hostscli/core/ttl');
      const record = await extendTtl({
        ...workspaceOptions(options),
        hostname,
        duration: options.for,
        ...(options.layer !== undefined ? { layerId: options.layer } : {}),
      });
      if (options.json) {
        printJson(record);
        return;
      }
      process.stdout.write(`已续期 ${hostname}，到期时间 ${record.expiresAt}。\n`);
    });

  registerMutationSubcommand(ttl, 'restore', '立即恢复条目（清除 TTL）', 'resolve');
  registerMutationSubcommand(ttl, 'cancel', '取消 TTL 并转为普通禁用');

  addWorkspaceOptions(ttl.command('tick').description('结算所有已到期的 TTL（可放入 cron）'), {
    json: true,
  }).action(async (options) => {
    const { tickTtl } = await import('@hostscli/core/ttl');
    const result = await tickTtl(workspaceOptions(options));
    if (options.json) {
      printJson(result);
      return;
    }
    const count = result.restored.length;
    process.stdout.write(count === 0 ? '没有到期的 TTL。\n' : `已恢复 ${count} 条到期 TTL。\n`);
    printWarnings(result.warnings);
  });
}

function registerMutationSubcommand(
  parent: Command,
  name: string,
  description: string,
  alias?: string,
): void {
  const command = parent.command(`${name} <hostname>`).description(description);
  if (alias) command.alias(alias);
  addWorkspaceOptions(command, { json: true, dryRun: true, layer: true }).action(
    async (hostname: string, options) => {
      const core = await import('@hostscli/core/ttl');
      const filePath = await resolveTargetPath(options);
      warnSystemHosts(filePath, options, '写入');
      const fn = name === 'restore' ? core.restoreTtl : core.cancelTtl;
      const result = await fn({
        ...workspaceOptions(options),
        hostname,
        ...(options.layer !== undefined ? { layerId: options.layer } : {}),
      });
      printMutation(result, options, {
        success:
          name === 'restore' ? `已恢复：${hostname}` : `已取消 TTL，条目保持禁用：${hostname}`,
        unchanged:
          name === 'restore'
            ? `无需变更：${hostname} 已经处于启用状态。`
            : `已取消 TTL，条目保持禁用：${hostname}（托管区块无变化）。`,
      });
    },
  );
}
