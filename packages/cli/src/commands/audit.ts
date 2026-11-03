import type { Command } from 'commander';
import pc from 'picocolors';
import { addDataDirOption, printJson } from './common';

export function registerAuditCommand(program: Command): void {
  const audit = program.command('audit').description('写入后验证 / 回滚审计日志（JSONL）');

  addDataDirOption(audit.command('list').description('列出最近的审计记录'), { json: true })
    .option('--limit <n>', '最多显示条数（1–1000，默认 20）', (value) => Number.parseInt(value, 10))
    .action(async (options) => {
      const [{ readAudit }, { resolveDataPaths }] = await Promise.all([
        import('@hostscli/core/audit'),
        import('@hostscli/core/storage'),
      ]);
      const paths = resolveDataPaths({ dataDir: options.dataDir });
      const limit =
        options.limit !== undefined && !Number.isNaN(options.limit) ? options.limit : 20;
      const entries = await readAudit(paths.auditPath, limit);

      if (options.json) {
        printJson({ auditPath: paths.auditPath, entries });
        return;
      }
      if (entries.length === 0) {
        process.stdout.write(pc.dim(`暂无审计记录（${paths.auditPath}）。\n`));
        return;
      }
      for (const entry of entries) {
        const status = entry.ok ? pc.green('ok') : pc.red('failed');
        process.stdout.write(
          `${entry.at} ${status} ${entry.action}${entry.checked !== undefined ? ` checked=${entry.checked}` : ''}\n`,
        );
        if (entry.detail) process.stdout.write(pc.dim(`  ${entry.detail}\n`));
        for (const failure of entry.failures ?? []) {
          process.stdout.write(
            pc.dim(
              `  ${failure.hostname} 期望 ${failure.expected}，实际 ${failure.actual.join(', ') || '无结果'}\n`,
            ),
          );
        }
      }
    });
}
