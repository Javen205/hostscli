import type { HostsCliConfig } from '../storage/config';
import type { HostsCliState } from '../storage/state';
import { readProfiles } from '../profiles/store';
import type { Profile } from '../profiles/store';
import type { WorkspaceOptions } from './context';
import { withWorkspace } from './context';
import { logRuntime } from './aux-write';

/**
 * 可移植的数据快照。只包含用户可读/可迁移内容：
 * - `config`：含默认值、网络映射、远程订阅来源；
 * - `state`：含 activeLayers、TTL 记录、上次渲染来源；
 * - `profiles`：全部规则层。
 *
 * 不含 audit / cache / backups（体积大或含运行态），也不含 hosts 文件原文，
 * 因为托管区可由 profiles 重建、非托管区属于系统文件而不属于 hostscli 数据。
 */
export interface ExportSnapshot {
  schemaVersion: 1;
  exportedAt: string;
  hostsPath: string;
  platform: string;
  config: HostsCliConfig;
  state: HostsCliState;
  profiles: Profile[];
}

export async function exportSnapshot(options: WorkspaceOptions = {}): Promise<ExportSnapshot> {
  return withWorkspace(options, async (workspace) => {
    const snapshot: ExportSnapshot = {
      schemaVersion: 1,
      exportedAt: workspace.now.toISOString(),
      hostsPath: workspace.hostsPath,
      platform: workspace.platformId,
      config: workspace.config,
      state: workspace.state,
      profiles: await readProfiles(workspace.paths.profilesDir),
    };
    // export 只读数据目录；写入的文件由用户通过 --out 指定，可能不在数据目录内，
    // 因此只记运行日志，不进审计哈希链（理由见 docs/pages/cli-reference.md）。
    await logRuntime(workspace, {
      event: 'export',
      detail: '导出数据快照（不修改数据目录）。',
    });
    return snapshot;
  });
}

/** JSON 输出固定使用 2 空格缩进与结尾换行，便于 diff 与版本库提交。 */
export function snapshotToJson(snapshot: ExportSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
