import type { Command } from 'commander';
import pc from 'picocolors';
import { binName } from '../program-name';
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

/** `--profile a --profile b,c` 都累加成一个列表；重复项在 core 侧去重。 */
function collectProfileIds(value: string, previous: string[] | undefined): string[] {
  const ids = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return [...(previous ?? []), ...ids];
}

export function registerListCommand(program: Command): void {
  addWorkspaceOptions(program.command('list').description('列出托管区与非托管区的 hosts 条目'), {
    json: true,
    onConflict: true,
    dnsFlush: false,
  })
    .option(
      '--profile <id>',
      '查看指定方案的条目（可含未生效方案；可重复或用逗号分隔）',
      collectProfileIds,
    )
    .option('--all-profiles', '查看全部方案的条目（含未生效方案）')
    .action(async (options) => {
      const requested: string[] | undefined = options.profile;
      if (requested !== undefined && requested.length === 0) {
        throw Object.assign(new Error('--profile 至少要提供一个方案 ID（多个可用逗号分隔）。'), {
          code: 'INVALID_INPUT',
        });
      }

      const { listHosts } = await import('@hostscli/core/crud');
      const snapshot = await listHosts({
        ...workspaceOptions(options),
        onConflict: conflictStrategy(options),
        ...(requested !== undefined ? { profiles: requested } : {}),
        ...(options.allProfiles ? { allProfiles: true } : {}),
      });

      if (options.json) {
        printJson({
          filePath: snapshot.filePath,
          activeLayers: snapshot.activeLayers,
          ...(snapshot.view ? { view: snapshot.view } : {}),
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
      process.stdout.write(`${renderEntryTable(snapshot.entries, { index: true })}\n`);

      const summary =
        `托管 ${snapshot.summary.managed} 条，禁用 ${snapshot.summary.disabled} 条，` +
        `TTL ${snapshot.summary.ttlDisabled} 条`;
      if (snapshot.view) {
        const scope = snapshot.view.mode === 'all' ? '全部方案' : '方案';
        const marked = snapshot.view.profiles
          .map((id) => `${id}（${snapshot.activeLayers.includes(id) ? '生效' : '未生效'}）`)
          .join(', ');
        process.stdout.write(
          pc.dim(
            `文件: ${snapshot.filePath} | 视图: ${scope} ${marked || '-'} | ` +
              `生效层: ${snapshot.activeLayers.join(', ') || '-'} | ${summary}\n`,
          ),
        );
        if (snapshot.view.omittedExternal > 0) {
          process.stdout.write(
            pc.dim(
              `非托管条目 ${snapshot.view.omittedExternal} 条不在方案视图中展示，` +
                `用不带 --profile 的 ${binName()} list 查看。\n`,
            ),
          );
        }
      } else {
        process.stdout.write(
          pc.dim(
            `文件: ${snapshot.filePath} | 生效层: ${snapshot.activeLayers.join(', ') || '-'} | ` +
              `${summary}，非托管 ${snapshot.summary.external} 条\n`,
          ),
        );
      }
      printWarnings(snapshot.warnings);
    });
}
