import { createHash } from 'node:crypto';
import { createUnifiedDiff } from '../diff';
import type { HostEntry } from '../hosts/models';
import { renderHosts } from '../hosts/render';
import type { ConflictStrategy, MergeResult } from '../stack/merge';
import { mergeLayers } from '../stack/merge';
import type { LoadedHosts, Workspace } from './context';
import { buildLayerInputs } from './layers';
import type { Profile } from '../profiles/store';
import type { HostEntry as ModelEntry } from '../hosts/models';

export interface RenderPlan {
  loaded: LoadedHosts;
  next: Buffer;
  diff: string;
  changed: boolean;
  planHash: string;
  merged: MergeResult;
  disabled: HostEntry[];
  profiles: Profile[];
}

export function sha256Buffer(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export interface BuildPlanOptions {
  onConflict?: ConflictStrategy;
  /** 无围栏时是否强制追加区块（init / profile use）。 */
  appendIfMissing?: boolean;
}

/**
 * 生成"从当前生效层渲染托管区块"的完整计划。只解析一次文件、只渲染一次。
 * 所有写操作都必须先经过这里，dry-run 与真实写入共享同一份计划。
 */
export function buildRenderPlan(
  workspace: Workspace,
  loaded: LoadedHosts,
  profiles: Profile[],
  options: BuildPlanOptions = {},
): RenderPlan {
  const { inputs, disabled } = buildLayerInputs(profiles, workspace.state);
  const merged = mergeLayers(inputs, { onConflict: options.onConflict });

  const appendIfMissing = options.appendIfMissing ?? merged.entries.length > 0;
  const next = renderHosts(loaded.document, {
    appendIfMissing,
    managedEntries: merged.entries.map((entry: ModelEntry) => ({
      ip: entry.ip,
      hostnames: entry.hostnames,
      ...(entry.comment ? { comment: entry.comment } : {}),
    })),
  });

  const previousText = loaded.raw?.toString('utf8') ?? '';
  const nextText = next.toString('utf8');
  const changed = loaded.raw === null ? next.length > 0 : !next.equals(loaded.raw);

  return {
    loaded,
    next,
    diff: changed
      ? createUnifiedDiff(previousText, nextText, {
          labelFrom: `a/${workspace.hostsPath}`,
          labelTo: `b/${workspace.hostsPath}`,
        })
      : '',
    changed,
    planHash: sha256Buffer(next),
    merged,
    disabled,
    profiles,
  };
}
