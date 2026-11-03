import type { HostsCliConfig } from '../storage/config';
import type { HostsCliState } from '../storage/state';
import { readProfiles } from '../profiles/store';
import type { Profile } from '../profiles/store';
import type { WorkspaceOptions } from './context';
import { withWorkspace } from './context';

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
  return withWorkspace(options, async (workspace) => ({
    schemaVersion: 1,
    exportedAt: workspace.now.toISOString(),
    hostsPath: workspace.hostsPath,
    platform: workspace.platformId,
    config: workspace.config,
    state: workspace.state,
    profiles: await readProfiles(workspace.paths.profilesDir),
  }));
}

/** JSON 输出固定使用 2 空格缩进与结尾换行，便于 diff 与版本库提交。 */
export function snapshotToJson(snapshot: ExportSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
