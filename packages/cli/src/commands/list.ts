import type { Command } from 'commander';
import pc from 'picocolors';
import {
  addWorkspaceOptions,
  conflictStrategy,
  printJson,
  printWarnings,
  workspaceOptions,
} from './common';

function entryStatus(entry: { enabled: boolean; ttl?: unknown }): string {
  if (entry.ttl) return 'ttl_disabled';
  return entry.enabled ? 'enabled' : 'disabled';
}

export function registerListCommand(program: Command): void {
  addWorkspaceOptions(program.command('list').description('列出托管区与非托管区的 hosts 条目'), {
    json: true,
    onConflict: true,
  }).action(async (options) => {
    const { listHosts } = await import('@hostscli/core/crud');
    const snapshot = await listHosts({
      ...workspaceOptions(options),
      onConflict: conflictStrategy(options),
    });

    if (options.json) {
      printJson({
        filePath: snapshot.filePath,
        activeLayers: snapshot.activeLayers,
        entries: snapshot.entries.map((entry) => ({
          ...entry,
          status: entryStatus(entry),
        })),
        summary: snapshot.summary,
        warnings: snapshot.warnings,
      });
      return;
    }

    const { renderEntryTable } = await import('../output/table');
    process.stdout.write(`${renderEntryTable(snapshot.entries)}\n`);
    process.stdout.write(
      pc.dim(
        `文件: ${snapshot.filePath} | 生效层: ${snapshot.activeLayers.join(', ') || '-'} | ` +
          `托管 ${snapshot.summary.managed} 条，禁用 ${snapshot.summary.disabled} 条，` +
          `TTL ${snapshot.summary.ttlDisabled} 条，非托管 ${snapshot.summary.external} 条\n`,
      ),
    );
    printWarnings(snapshot.warnings);
  });
}
