import type { Command } from 'commander';
import pc from 'picocolors';
import {
  addWorkspaceOptions,
  confirm,
  conflictStrategy,
  printJson,
  printMutation,
  printWarnings,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

interface DisableOptions {
  file?: string;
  dataDir?: string;
  json?: boolean;
  dryRun?: boolean;
  skipDnsFlush?: boolean;
  layer?: string;
  onConflict?: string;
  for?: string;
  reason?: string;
  yes?: boolean;
}

export function registerDisableCommand(program: Command): void {
  addWorkspaceOptions(
    program.command('disable <hostname...>').description('禁用托管记录；提供 --for 时到期自动恢复'),
    { json: true, dryRun: true, layer: true, onConflict: true, verify: true },
  )
    .option('--for <duration>', '启用单条 TTL，例如 30m / 2h / 3d（最小 1 分钟）')
    .option('--reason <text>', 'TTL 备注（写入 state，不下发到 hosts 文件）')
    .option('--yes', '跳过超过阈值时长的确认')
    .action(async (hostnames: string[], options: DisableOptions) => {
      const [{ setHostsEnabled }, { showConfig }, { parseDuration }, ttl] = await Promise.all([
        import('@hostscli/core/crud'),
        import('@hostscli/core/config'),
        import('@hostscli/core/duration'),
        import('@hostscli/core/ttl'),
      ]);
      const filePath = await resolveTargetPath(options);
      warnSystemHosts(filePath, options, '写入');
      const base = {
        ...workspaceOptions(options),
        hostnames,
        ...(options.layer !== undefined ? { layerId: options.layer } : {}),
        onConflict: conflictStrategy(options),
      };

      if (!options.for) {
        const result = await setHostsEnabled({ ...base, enabled: false });
        printMutation(result, options, {
          success: `已禁用：${hostnames.join(', ')}`,
          unchanged: `无需变更：${hostnames.join(', ')} 已经是禁用状态。`,
        });
        return;
      }

      const { config } = await showConfig(workspaceOptions(options));
      const threshold = parseDuration(config.defaults.ttlWarnThreshold);
      const durationMs = parseDuration(options.for);
      let yes = Boolean(options.yes);

      if (!yes && !options.dryRun && durationMs > threshold) {
        const confirmed = await confirm(
          `TTL 时长 ${options.for} 超过默认阈值 ${config.defaults.ttlWarnThreshold}，确认设置？`,
        );
        if (!confirmed) {
          throw Object.assign(new Error('已取消 TTL 设置。'), { code: 'CANCELLED' });
        }
        yes = true;
      }

      const result = await ttl.disableFor({
        ...workspaceOptions(options),
        hostnames,
        for: options.for,
        ...(options.layer !== undefined ? { layerId: options.layer } : {}),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        yes,
      });

      if (options.json) {
        printJson({ ...result, ttl: result.record, warnings: result.warnings });
        return;
      }

      if (options.dryRun) {
        process.stdout.write(result.diff);
        printWarnings(result.warnings);
        return;
      }

      process.stdout.write(
        `已设置 TTL：${result.record.hostname} 将在 ${options.for} 后自动恢复（到期 ${result.record.expiresAt}）\n`,
      );
      if (result.backupPath) process.stdout.write(pc.dim(`备份：${result.backupPath}\n`));
      printWarnings(result.warnings);
    });
}
