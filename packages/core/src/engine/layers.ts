import type { HostsDocument, HostEntry } from '../hosts/models';
import { createEntryId } from '../hosts/models';
import type { Profile, ProfileEntry } from '../profiles/store';
import {
  profileEntriesToHostEntries,
  profileExists,
  readProfile,
  writeProfile,
} from '../profiles/store';
import type { LayerInput } from '../stack/merge';
import type { HostsCliState, TtlRecord } from '../storage/state';
import type { Workspace } from './context';

export const DEFAULT_PROFILE_ID = 'default';

export interface ActiveLayers {
  profiles: Profile[];
  /** true 表示当前文件里的托管条目被临时当作 default 方案（尚未落盘）。 */
  virtual: boolean;
}

function importedEntries(document: HostsDocument): ProfileEntry[] {
  return document.entries
    .filter((entry) => entry.source === 'managed')
    .map((entry) => {
      const imported: ProfileEntry = {
        ip: entry.ip,
        hostnames: entry.hostnames,
        enabled: entry.enabled,
      };
      if (entry.comment) imported.comment = entry.comment;
      return imported;
    });
}

/**
 * 解析当前生效层。没有 activeLayers 时，把当前托管区块导入 default 方案，
 * 保证升级到阶段 2 后不会丢失用户已有规则。
 */
export async function resolveActiveLayers(
  workspace: Workspace,
  document: HostsDocument,
  options: { persist: boolean },
): Promise<ActiveLayers> {
  const state = workspace.state;

  if (state.activeLayers.length > 0) {
    const profiles = await Promise.all(
      state.activeLayers.map((id) => readProfile(workspace.paths.profilesDir, id)),
    );
    state.initialized = true;
    return { profiles, virtual: false };
  }

  // 用户主动停用了所有层：保持"无层"语义，不再自动迁移出 default。
  if (state.initialized) {
    return { profiles: [], virtual: false };
  }

  const exists = await profileExists(workspace.paths.profilesDir, DEFAULT_PROFILE_ID);
  let profile: Profile;

  if (exists) {
    profile = await readProfile(workspace.paths.profilesDir, DEFAULT_PROFILE_ID);
  } else {
    const entries = importedEntries(document);
    profile = {
      schemaVersion: 1,
      id: DEFAULT_PROFILE_ID,
      name: '默认',
      priority: 0,
      entries,
    };
    if (options.persist && !workspace.dryRun) {
      // 条目来自刚解析的 hosts 文档，结构可信；跳过 zod 全量深校验。
      profile = await writeProfile(workspace.paths.profilesDir, profile, {
        createOnly: true,
        trusted: true,
      }).catch(async (error: unknown) => {
        // 并发场景下另一个实例可能刚创建同名方案：重新读取即可。
        if (
          (error as { code?: string }).code === 'INVALID_INPUT' &&
          (await profileExists(workspace.paths.profilesDir, profile.id))
        ) {
          return readProfile(workspace.paths.profilesDir, profile.id);
        }
        throw error;
      });
    }
  }

  if (options.persist && !workspace.dryRun) {
    workspace.state.activeLayers = [profile.id];
    workspace.state.initialized = true;
  }

  return { profiles: [profile], virtual: !exists };
}

export function ttlKey(layerId: string, entryId: string): string {
  return `${layerId}\u0000${entryId}`;
}

export function collectTtlKeys(records: TtlRecord[]): Set<string> {
  return new Set(records.map((record) => ttlKey(record.layerId, record.entryId)));
}

/**
 * 组装合并输入：跳过持久禁用条目与 TTL 禁用条目。
 * 扩展点：新的"排除来源"（如 maintenance 标记）只需在这里追加判断。
 */
export function buildLayerInputs(
  profiles: Profile[],
  state: HostsCliState,
): { inputs: LayerInput[]; disabled: HostEntry[] } {
  const ttlKeys = collectTtlKeys(state.ttl);
  const inputs: LayerInput[] = [];
  const disabled: HostEntry[] = [];

  profiles.forEach((profile, order) => {
    const entries: HostEntry[] = [];

    for (const entry of profileEntriesToHostEntries(profile)) {
      if (!entry.enabled) {
        disabled.push(entry);
        continue;
      }
      if (ttlKeys.has(ttlKey(profile.id, entry.id))) {
        const record = state.ttl.find(
          (candidate) => candidate.layerId === profile.id && candidate.entryId === entry.id,
        );
        disabled.push({
          ...entry,
          enabled: false,
          ...(record ? { ttl: record } : {}),
        });
        continue;
      }
      entries.push(entry);
    }

    inputs.push({ id: profile.id, priority: profile.priority, entries, order });
  });

  return { inputs, disabled };
}

/** 当前文件托管条目与某个方案条目的差异（用于提示"托管区被外部修改"）。 */
export function documentManagedEntries(document: HostsDocument): HostEntry[] {
  return document.entries.filter((entry) => entry.source === 'managed');
}

export function entryKey(entry: Pick<HostEntry, 'ip' | 'hostnames'>): string {
  const hostnames = [...entry.hostnames]
    .map((name) => name.toLowerCase())
    .sort()
    .join(',');
  return `${entry.ip}\u0000${hostnames}`;
}

export function entryIdFor(layerId: string, entry: Pick<HostEntry, 'ip' | 'hostnames'>): string {
  return createEntryId(layerId, entry.ip, entry.hostnames);
}

export { writeProfile };
