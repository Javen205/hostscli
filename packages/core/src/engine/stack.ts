import { readFile } from 'node:fs/promises';
import { EntryNotFoundError, InvalidInputError } from '../errors';
import type { HostsDocument } from '../hosts/models';
import { normalizeHostname } from '../hosts/models';
import type { Profile, ProfileEntry } from '../profiles/store';
import {
  listProfileIds,
  profileIdFromPath,
  profileIdSchema,
  profilePath,
  readProfile,
  readProfileSource,
  writeProfile,
  profileExists,
} from '../profiles/store';
import { saveState } from '../storage/state';
import { explainResolution } from '../stack/merge';
import type { ConflictStrategy, ExplainCandidate } from '../stack/merge';
import { commitPlan } from './commit';
import type { WorkspaceOptions } from './context';
import { loadHostsDocument, withWorkspace } from './context';
import { prepare } from './crud';
import { buildLayerInputs, resolveActiveLayers } from './layers';
import { buildRenderPlan, sha256Buffer } from './plan';
import type { MutationResult } from './types';
import { auditAuxWrite } from './aux-write';
import { hashBytes, readStateRaw } from './history';

export interface StackLayerView {
  profile: Profile;
  active: boolean;
  entryCount: number;
  disabledCount: number;
  ttlCount: number;
}

export interface StackListResult {
  activeLayers: string[];
  layers: StackLayerView[];
}

export interface AddStackLayerOptions extends WorkspaceOptions {
  /** 显式层 ID；缺省时取层文件里的 id 或文件名。 */
  id?: string;
  file: string;
  priority?: number;
  name?: string;
  /** 覆盖同名层。 */
  force?: boolean;
  /** 默认加入启用集合（true）。 */
  enable?: boolean;
}

export interface AddStackLayerResult {
  profile: Profile;
  enabled: boolean;
  replaced: boolean;
  activeLayers: string[];
}

export interface SetStackLayerOptions extends WorkspaceOptions {
  id: string;
  enabled: boolean;
}

export interface SetStackLayerResult {
  id: string;
  enabled: boolean;
  changed: boolean;
  activeLayers: string[];
  warnings: string[];
}

export interface ApplyStackOptions extends WorkspaceOptions {
  onConflict?: ConflictStrategy;
}

export interface ExplainStackOptions extends WorkspaceOptions {
  hostname: string;
  onConflict?: ConflictStrategy;
}

export interface ExternalMapping {
  ip: string;
  line: number;
  raw: string;
}

export interface ExplainStackResult {
  hostname: string;
  candidates: ExplainCandidate[];
  result: string | null;
  conflict: boolean;
  external: ExternalMapping[];
  stale: boolean;
  planHash: string | null;
  currentHash: string | null;
  warnings: string[];
}

export async function listStackLayers(options: WorkspaceOptions = {}): Promise<StackListResult> {
  return withWorkspace(options, async (workspace) => {
    const ids = await listProfileIds(workspace.paths.profilesDir);
    const layers = await Promise.all(
      ids.map(async (id): Promise<StackLayerView> => {
        const profile = await readProfile(workspace.paths.profilesDir, id);
        return {
          profile,
          active: workspace.state.activeLayers.includes(id),
          entryCount: profile.entries.length,
          disabledCount: profile.entries.filter((entry) => !entry.enabled).length,
          ttlCount: workspace.state.ttl.filter((record) => record.layerId === id).length,
        };
      }),
    );
    return { activeLayers: workspace.state.activeLayers, layers };
  });
}

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function addStackLayer(options: AddStackLayerOptions): Promise<AddStackLayerResult> {
  return withWorkspace(options, async (workspace) => {
    const source = await readProfileSource(options.file);
    const id = options.id ?? source.id ?? profileIdFromPath(options.file);
    const checkedId = profileIdSchema.safeParse(id);
    if (!checkedId.success) {
      throw new InvalidInputError(checkedId.error.issues[0]?.message ?? `无效的层 ID：${id}`);
    }

    const priority = options.priority ?? source.priority ?? 0;
    if (!Number.isInteger(priority)) {
      throw new InvalidInputError(`优先级必须是整数：${priority}`);
    }

    const replaced = await profileExists(workspace.paths.profilesDir, checkedId.data);
    if (replaced && !options.force) {
      throw new InvalidInputError(`层 ${checkedId.data} 已存在。使用 --force 覆盖，或换一个 ID。`);
    }

    const profilePathValue = profilePath(workspace.paths.profilesDir, checkedId.data);
    const beforeProfile = replaced ? await readFileOrNull(profilePathValue) : null;
    const beforeStateRaw = await readStateRaw(workspace.paths.statePath);

    const entries: ProfileEntry[] = source.entries.map((entry) => {
      const value: ProfileEntry = {
        ip: entry.ip,
        hostnames: entry.hostnames,
        enabled: entry.enabled,
      };
      if (entry.comment) value.comment = entry.comment;
      if (entry.disabledReason) value.disabledReason = entry.disabledReason;
      return value;
    });

    const profile = await writeProfile(
      workspace.paths.profilesDir,
      {
        schemaVersion: 1,
        id: checkedId.data,
        name: options.name ?? source.name ?? checkedId.data,
        priority,
        entries,
      },
      { createOnly: !replaced },
    );

    const enabled = options.enable !== false;
    if (enabled && !workspace.state.activeLayers.includes(profile.id)) {
      workspace.state.activeLayers.push(profile.id);
    }
    workspace.state.initialized = true;
    await saveState(workspace.paths.statePath, workspace.state);

    // 层导入同时改动方案文件与 state；审计以方案文件为主指纹，
    // state 的启用集合变化写进 detail，便于人工核对。
    await auditAuxWrite(workspace, {
      command: 'stack layer add',
      args: [checkedId.data, '--file', options.file],
      beforeSha256: hashBytes(beforeProfile),
      afterSha256: hashBytes(await readFileOrNull(profilePathValue)),
      detail: `导入层 ${profile.id}（${profile.entries.length} 条，priority ${profile.priority}；覆盖=${replaced}，启用=${enabled}；state ${hashBytes(beforeStateRaw)} → ${hashBytes(await readStateRaw(workspace.paths.statePath))}）。`,
    });

    return {
      profile,
      enabled,
      replaced,
      activeLayers: workspace.state.activeLayers,
    };
  });
}

export async function setStackLayerEnabled(
  options: SetStackLayerOptions,
): Promise<SetStackLayerResult> {
  return withWorkspace(options, async (workspace) => {
    await readProfile(workspace.paths.profilesDir, options.id);
    const current = workspace.state.activeLayers.includes(options.id);
    const changed = current !== options.enabled;
    const beforeStateRaw = await readStateRaw(workspace.paths.statePath);

    if (options.enabled && !current) {
      workspace.state.activeLayers.push(options.id);
    } else if (!options.enabled) {
      workspace.state.activeLayers = workspace.state.activeLayers.filter((id) => id !== options.id);
    }

    workspace.state.initialized = true;
    if (changed) {
      await saveState(workspace.paths.statePath, workspace.state);
      await auditAuxWrite(workspace, {
        command: options.enabled ? 'stack layer enable' : 'stack layer disable',
        args: [options.id],
        beforeSha256: hashBytes(beforeStateRaw),
        afterSha256: hashBytes(await readStateRaw(workspace.paths.statePath)),
        detail: `${options.enabled ? '启用' : '停用'}层 ${options.id}（只改 activeLayers，需再 apply 才写入 hosts）。`,
      });
    }

    return {
      id: options.id,
      enabled: options.enabled,
      changed,
      activeLayers: workspace.state.activeLayers,
      warnings: changed
        ? [`运行 hostscli stack apply --apply 使层 ${options.id} 的变更写入 hosts。`]
        : [],
    };
  });
}

/**
 * 按启用的层重建托管区块。调用方传入 `dryRun` 时只预览；CLI 的
 * `stack apply` 默认就是 dry-run，必须显式 `--apply` 才落盘（方案 2.4）。
 */
export async function applyStack(options: ApplyStackOptions = {}): Promise<MutationResult> {
  return withWorkspace(options, async (workspace) => {
    const { loaded, warnings } = await prepare(workspace);
    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
    if (profiles.length === 0) {
      warnings.push('当前没有启用的层，托管区块将被清空（非托管内容保持不变）。');
    }

    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: loaded.document.managedRange !== null || profiles.length > 0,
      onConflict: options.onConflict,
    });

    return commitPlan(workspace, plan, { persistState: true, warnings });
  });
}

export async function explainStackHostname(
  options: ExplainStackOptions,
): Promise<ExplainStackResult> {
  return withWorkspace(options, async (workspace) => {
    const loaded = await loadHostsDocument(workspace, false);
    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: false });
    const { inputs, disabled } = buildLayerInputs(profiles, workspace.state);

    const resolution = explainResolution(inputs, options.hostname, options.onConflict ?? 'fail');
    const key = normalizeHostname(options.hostname);

    const external = externalMappings(loaded.document, key);
    const disabledTtl = disabled.some(
      (entry) =>
        entry.ttl && entry.hostnames.some((hostname) => normalizeHostname(hostname) === key),
    );

    if (resolution.candidates.length === 0 && external.length === 0) {
      throw new EntryNotFoundError(`找不到主机名 ${key} 的规则或 hosts 记录。`);
    }

    const currentHash = loaded.raw ? sha256Buffer(loaded.raw) : null;
    const stale =
      loaded.document.managedRange !== null &&
      workspace.state.lastRender !== undefined &&
      currentHash !== null &&
      workspace.state.lastRender.planHash !== currentHash;

    const warnings: string[] = [];
    if (stale) {
      warnings.push(
        '托管区块与上次 apply 的来源记录不一致（可能被手工修改）；请先运行 hostscli stack apply --apply 重建。',
      );
    }
    if (disabledTtl) {
      warnings.push(`主机名 ${key} 当前被 TTL 禁用，因此不在候选链中。`);
    }
    if (external.length > 0) {
      warnings.push('该主机名也出现在非托管行，hostscli 不会改动这些行。');
    }

    return {
      hostname: key,
      candidates: resolution.candidates,
      result: resolution.result,
      conflict: resolution.conflict,
      external,
      stale,
      planHash: workspace.state.lastRender?.planHash ?? null,
      currentHash,
      warnings,
    };
  });
}

function externalMappings(document: HostsDocument, key: string): ExternalMapping[] {
  return document.entries
    .filter(
      (entry) =>
        entry.source === 'external' &&
        entry.hostnames.some((hostname) => normalizeHostname(hostname) === key),
    )
    .map((entry) => ({
      ip: entry.ip,
      line: (entry.origin?.line ?? 0) + 1,
      raw: entry.origin?.raw ?? `${entry.ip} ${entry.hostnames.join(' ')}`,
    }));
}
