import type { Command } from 'commander';
import pc from 'picocolors';
import { addDataDirOption, printJson } from './common';

interface AuditListOptions {
  dataDir?: string;
  json?: boolean;
  since?: string;
  until?: string;
  command?: string;
  result?: string;
  limit?: number;
}

function formatEntry(entry: {
  at: string;
  action: string;
  ok: boolean;
  command?: string;
  operator?: { uid: number | null; username: string | null };
  detail?: string;
  beforeSha256?: string | null;
  afterSha256?: string | null;
  summary?: { added: unknown[]; removed: unknown[]; disabled: unknown[]; restored: unknown[] };
  id?: string;
}): string {
  const status = entry.ok ? pc.green('ok') : pc.red('failed');
  const id = entry.id ? `${pc.dim(`#${entry.id}`)} ` : '';
  const command = entry.command ? ` ${pc.cyan(entry.command)}` : '';
  const operator = entry.operator
    ? ` ${pc.dim(`uid=${entry.operator.uid ?? '-'} user=${entry.operator.username ?? '-'}`)}`
    : '';
  let line = `${id}${entry.at} ${status} ${entry.action}${command}${operator}\n`;
  if (entry.summary) {
    const summary = entry.summary;
    const parts = [
      summary.added.length ? `+${summary.added.length}` : '',
      summary.removed.length ? `-${summary.removed.length}` : '',
      summary.disabled.length ? `disable ${summary.disabled.length}` : '',
      summary.restored.length ? `restore ${summary.restored.length}` : '',
    ].filter(Boolean);
    if (parts.length > 0) line += pc.dim(`  变更：${parts.join(' ')}\n`);
  }
  if (entry.detail) line += pc.dim(`  ${entry.detail}\n`);
  return line;
}

export function registerAuditCommand(program: Command): void {
  const audit = program.command('audit').description('写入审计：哈希链校验、查询、导出');

  addDataDirOption(audit.command('list').description('列出审计记录（支持时间/命令/结果过滤）'), {
    json: true,
  })
    .option('--limit <n>', '最多显示条数（1–1000，默认 20）', (value) => Number.parseInt(value, 10))
    .option('--since <time>', '起始时间（ISO 8601 或可解析日期）')
    .option('--until <time>', '截止时间（ISO 8601 或可解析日期）')
    .option('--command <name>', '按命令名精确过滤（例如 add / undo / run）')
    .option('--result <ok|failed>', '按结果过滤')
    .action(async (options: AuditListOptions) => {
      const [{ queryAudit }, { resolveDataPaths }] = await Promise.all([
        import('@hostscli/core/audit'),
        import('@hostscli/core/storage'),
      ]);
      const paths = resolveDataPaths({ dataDir: options.dataDir });
      const limit =
        options.limit !== undefined && !Number.isNaN(options.limit) ? options.limit : 20;
      if (options.result !== undefined && options.result !== 'ok' && options.result !== 'failed') {
        throw Object.assign(new Error('--result 只支持 ok 或 failed。'), { code: 'INVALID_INPUT' });
      }
      const result = await queryAudit(paths.auditPath, {
        limit,
        ...(options.since !== undefined ? { since: options.since } : {}),
        ...(options.until !== undefined ? { until: options.until } : {}),
        ...(options.command !== undefined ? { command: options.command } : {}),
        ...(options.result !== undefined ? { result: options.result } : {}),
      });

      if (options.json) {
        printJson({ auditPath: paths.auditPath, ...result });
        return;
      }
      if (result.unaudited.length > 0) {
        process.stdout.write(
          pc.yellow(
            `警告：有 ${result.unaudited.length} 次操作未成功写入审计（见 audit verify）。\n`,
          ),
        );
      }
      if (result.records.length === 0) {
        process.stdout.write(pc.dim(`暂无匹配的审计记录（${paths.auditPath}）。\n`));
        return;
      }
      for (const entry of result.records) {
        process.stdout.write(formatEntry(entry));
      }
      if (result.legacy > 0) {
        process.stdout.write(pc.dim(`其中 ${result.legacy} 条为旧格式记录（不在哈希链上）。\n`));
      }
    });

  addDataDirOption(audit.command('show').description('按 ID 显示单条审计记录'), { json: true })
    .argument('<id>', '记录 ID（audit list 输出中的 #序号）')
    .action(async (id: string, options: { dataDir?: string; json?: boolean }) => {
      const [{ showAudit }, { resolveDataPaths }] = await Promise.all([
        import('@hostscli/core/audit'),
        import('@hostscli/core/storage'),
      ]);
      const paths = resolveDataPaths({ dataDir: options.dataDir });
      const entry = await showAudit(paths.auditPath, id);
      if (entry === null) {
        process.stderr.write(pc.red(`未找到审计记录 ${id}。\n`));
        process.exitCode = 2;
        return;
      }
      if (options.json) {
        printJson(entry);
        return;
      }
      process.stdout.write(formatEntry(entry));
      process.stdout.write(
        pc.dim(
          `链：${entry.onChain ? '在链上' : '旧格式，不在链上'} prev=${entry.prevHash ?? '-'} hash=${entry.recordHash ?? '-'}\n`,
        ),
      );
    });

  addDataDirOption(audit.command('verify').description('校验哈希链，发现被删改的记录'), {
    json: true,
  }).action(async (options: { dataDir?: string; json?: boolean }) => {
    const [{ verifyAudit }, { resolveDataPaths }] = await Promise.all([
      import('@hostscli/core/audit'),
      import('@hostscli/core/storage'),
    ]);
    const paths = resolveDataPaths({ dataDir: options.dataDir });
    const result = await verifyAudit(paths.auditPath);
    if (options.json) {
      printJson(result);
    } else {
      process.stdout.write(
        `审计记录 ${result.total} 条：链上 ${result.chained}，旧格式 ${result.legacy}；` +
          `${result.ok ? pc.green('链完整') : pc.red('链校验失败')}\n`,
      );
      if (result.legacy > 0) {
        process.stdout.write(pc.dim('旧格式记录可读，但不在哈希链上，不做完整性保证。\n'));
      }
      if (!result.chain.tailVerified) {
        process.stdout.write(pc.dim('缺少 chain sidecar，无法判断尾部记录是否被截断。\n'));
      }
      for (const issue of result.issues) {
        process.stdout.write(pc.red(`  #${issue.id}: ${issue.reason}\n`));
      }
      for (const item of result.unaudited) {
        process.stdout.write(
          pc.yellow(`  未审计操作：${item.at}${item.command ? ` ${item.command}` : ''}\n`),
        );
      }
      if (result.unaudited.length > 0) {
        process.stdout.write(pc.yellow(`有 ${result.unaudited.length} 次操作未写入审计日志。\n`));
      }
    }
    if (!result.ok) process.exitCode = 1;
  });

  addDataDirOption(audit.command('export').description('导出全部审计记录'))
    .option('--format <format>', '输出格式：json / ndjson（默认 json）', 'json')
    .action(async (options: { dataDir?: string; format?: string }) => {
      const [{ exportAudit }, { resolveDataPaths }] = await Promise.all([
        import('@hostscli/core/audit'),
        import('@hostscli/core/storage'),
      ]);
      if (options.format !== 'json' && options.format !== 'ndjson') {
        throw Object.assign(new Error('--format 只支持 json 或 ndjson。'), {
          code: 'INVALID_INPUT',
        });
      }
      const paths = resolveDataPaths({ dataDir: options.dataDir });
      const result = await exportAudit(paths.auditPath, options.format);
      process.stdout.write(result.content);
    });
}
