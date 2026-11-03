import { InvalidInputError } from '../errors';
import type { Profile, ProfileEntry } from '../profiles/store';
import {
  createProfile,
  deleteProfile,
  listProfileIds,
  readProfile,
  writeProfile,
} from '../profiles/store';
import { buildRenderPlan } from './plan';
import { commitPlan } from './commit';
import { loadHostsDocument, withWorkspace } from './context';
import type { WorkspaceOptions } from './context';
import { entryIdFor, resolveActiveLayers } from './layers';
import { prepare } from './crud';
import type {
  ProfileCreateOptions,
  ProfileSaveOptions,
  ProfileUseOptions,
  ProfileView,
  UseProfileResult,
} from './types';

// 子路径入口面向 CLI：把展示所需的轻量工具与类型一并再导出。
export { profileEntriesToHostEntries } from '../profiles/store';
export type {
  CreateProfileOptions,
  Profile,
  ProfileEntry,
  ProfileSource,
  WriteProfileOptions,
} from '../profiles/store';

export async function listProfiles(
  options: WorkspaceOptions = {},
): Promise<{ activeLayers: string[]; profiles: ProfileView[] }> {
  return withWorkspace(options, async (workspace) => {
    const ids = await listProfileIds(workspace.paths.profilesDir);
    const profiles = await Promise.all(
      ids.map((id) => readProfile(workspace.paths.profilesDir, id)),
    );
    return {
      activeLayers: workspace.state.activeLayers,
      profiles: profiles.map((profile) => ({
        profile,
        active: workspace.state.activeLayers.includes(profile.id),
        entryCount: profile.entries.length,
      })),
    };
  });
}

export async function showProfile(id: string, options: WorkspaceOptions = {}): Promise<Profile> {
  return withWorkspace(options, (workspace) => readProfile(workspace.paths.profilesDir, id));
}

export async function createProfileFromCurrent(options: ProfileCreateOptions): Promise<Profile> {
  return withWorkspace(options, async (workspace) => {
    const loaded = await loadHostsDocument(workspace, true);
    const entries: ProfileEntry[] = options.fromCurrent
      ? loaded.document.entries
          .filter((entry) => entry.source === 'managed')
          .map((entry) => ({
            ip: entry.ip,
            hostnames: entry.hostnames,
            enabled: entry.enabled,
            ...(entry.comment ? { comment: entry.comment } : {}),
          }))
      : [];

    return createProfile(workspace.paths.profilesDir, {
      id: options.id,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      entries,
    });
  });
}

/** 切换方案：activeLayers 只保留目标方案，并立即重建托管区块（阶段 2 语义）。 */
export async function useProfile(options: ProfileUseOptions): Promise<UseProfileResult> {
  return withWorkspace(options, async (workspace) => {
    await readProfile(workspace.paths.profilesDir, options.id);
    const { loaded, warnings } = await prepare(workspace);

    const switched = !(
      workspace.state.activeLayers.length === 1 && workspace.state.activeLayers[0] === options.id
    );
    workspace.state.activeLayers = [options.id];
    workspace.state.initialized = true;
    const profiles = [await readProfile(workspace.paths.profilesDir, options.id)];
    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: true,
      onConflict: options.onConflict,
    });

    const result = await commitPlan(workspace, plan, { persistState: true, warnings });
    return { ...result, switched };
  });
}

export async function removeProfile(id: string, options: WorkspaceOptions = {}): Promise<void> {
  await withWorkspace(options, async (workspace) => {
    if (workspace.state.activeLayers.includes(id)) {
      throw new InvalidInputError(
        `方案 ${id} 正在生效，不能删除。请先切换到其他方案，例如 hostscli profile use default。`,
      );
    }
    await deleteProfile(workspace.paths.profilesDir, id);
  });
}

/** 把当前托管区块保存为方案内容（更新操作）。 */
export async function saveProfileFromCurrent(options: ProfileSaveOptions): Promise<Profile> {
  return withWorkspace(options, async (workspace) => {
    const profile = await readProfile(workspace.paths.profilesDir, options.id);
    const { loaded, warnings } = await prepare(workspace);
    const managedEntries: ProfileEntry[] = loaded.document.entries
      .filter((entry) => entry.source === 'managed')
      .map((entry) => ({
        ip: entry.ip,
        hostnames: entry.hostnames,
        enabled: entry.enabled,
        ...(entry.comment ? { comment: entry.comment } : {}),
      }));

    // 托管区只包含“当前可见”的条目；已禁用、被 TTL 临时隐藏的条目不在其中。
    // 默认保留这些条目，避免 profile save 静默丢数据；--prune 才显式删除。
    const visibleIds = new Set(managedEntries.map((entry) => entryIdFor(options.id, entry)));
    const preserved: ProfileEntry[] = [];
    if (!options.prune) {
      const ttlHidden = new Set(
        workspace.state.ttl
          .filter((record) => record.layerId === options.id)
          .map((record) => record.entryId),
      );
      for (const entry of profile.entries) {
        const entryId = entryIdFor(options.id, entry);
        if (visibleIds.has(entryId)) continue;
        if (!entry.enabled || ttlHidden.has(entryId)) preserved.push(entry);
      }
    }
    profile.entries = [...managedEntries, ...preserved];

    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
    if (profiles.length !== 1 || profiles[0]?.id !== options.id) {
      const active = profiles.map((candidate) => candidate.id).join(', ') || '无';
      throw new InvalidInputError(
        `profile save 只能在“仅启用一个层且目标就是该层”时使用；` +
          `当前启用层：${active}，目标：${options.id}。`,
      );
    }
    const target = profiles[0] as Profile;
    target.entries = profile.entries;

    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: loaded.document.managedRange !== null,
    });
    await commitPlan(workspace, plan, {
      profiles: [target],
      persistState: true,
      warnings,
    });
    return target;
  });
}

/** 更新方案元信息（名称 / 优先级）。 */
export async function updateProfileMeta(
  id: string,
  changes: { name?: string; priority?: number },
  options: WorkspaceOptions = {},
): Promise<Profile> {
  return withWorkspace(options, async (workspace) => {
    const profile = await readProfile(workspace.paths.profilesDir, id);
    if (changes.name !== undefined) {
      if (changes.name.trim() === '') {
        throw new InvalidInputError('方案名称不能为空。');
      }
      profile.name = changes.name;
    }
    if (changes.priority !== undefined && !Number.isInteger(changes.priority)) {
      throw new InvalidInputError(`方案优先级必须是整数，收到：${changes.priority}`);
    }
    if (changes.priority !== undefined) profile.priority = changes.priority;
    // 元信息更新同样复用 profileSchema，禁止用 trusted 绕过字段校验。
    const updated = await writeProfile(workspace.paths.profilesDir, profile);

    if (workspace.state.activeLayers.includes(id)) {
      const loaded = await loadHostsDocument(workspace, true);
      const { profiles } = await resolveActiveLayers(workspace, loaded.document, {
        persist: false,
      });
      const plan = buildRenderPlan(workspace, loaded, profiles, {
        appendIfMissing: loaded.document.managedRange !== null,
      });
      await commitPlan(workspace, plan, { persistState: true });
    }
    return updated;
  });
}
