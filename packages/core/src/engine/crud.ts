import {
  DuplicateEntryError,
  EntryNotFoundError,
  ExternalEntryError,
  HostsFormatError,
  InvalidInputError,
} from '../errors';
import type { HostEntry, HostsDocument } from '../hosts/models';
import { normalizeHostname } from '../hosts/models';
import { validateEntryInput } from '../hosts/validation';
import type { Profile, ProfileEntry } from '../profiles/store';
import { buildRenderPlan } from './plan';
import { commitPlan } from './commit';
import type { Workspace } from './context';
import { loadHostsDocument } from './context';
import { withWorkspace } from './context';
import { entryIdFor, resolveActiveLayers } from './layers';
import { reconcileTtls } from './ttl';
import type {
  AddHostsOptions,
  HostsSnapshot,
  InitOptions,
  ListOptions,
  MutationResult,
  RemoveHostsOptions,
  SetEnabledOptions,
} from './types';
import type { LoadedHosts } from './context';

/** 结算到期 TTL，然后读取最新文件（只解析一次正常路径）。 */
async function prepare(workspace: Workspace): Promise<{ loaded: LoadedHosts; warnings: string[] }> {
  const warnings: string[] = [];
  if (workspace.state.ttl.length > 0) {
    const result = await reconcileTtls(workspace);
    warnings.push(...result.warnings);
  }
  return { loaded: await loadHostsDocument(workspace, true), warnings };
}

function toHostEntry(profile: Profile, entry: ProfileEntry): HostEntry {
  const value: HostEntry = {
    id: entryIdFor(profile.id, entry),
    ip: entry.ip,
    hostnames: entry.hostnames,
    enabled: entry.enabled,
    layerId: profile.id,
    source: 'managed',
  };
  if (entry.comment) value.comment = entry.comment;
  return value;
}

function hostnameSet(hostnames: string[]): Set<string> {
  return new Set(hostnames.map(normalizeHostname));
}

function matchEntries(
  profiles: Profile[],
  hostnames: string[],
  layerId?: string,
): Array<{ profile: Profile; entry: ProfileEntry }> {
  const keys = hostnameSet(hostnames);
  const matches: Array<{ profile: Profile; entry: ProfileEntry }> = [];
  for (const profile of profiles) {
    if (layerId && profile.id !== layerId) continue;
    for (const entry of profile.entries) {
      if (entry.hostnames.some((hostname) => keys.has(normalizeHostname(hostname)))) {
        matches.push({ profile, entry });
      }
    }
  }
  return matches;
}

function externalMatches(document: HostsDocument, hostnames: string[]): HostEntry[] {
  const keys = hostnameSet(hostnames);
  return document.entries.filter(
    (entry) =>
      entry.source === 'external' &&
      entry.hostnames.some((hostname) => keys.has(normalizeHostname(hostname))),
  );
}

/** 记录级操作提示：请求只给了部分主机名时，提醒用户整条记录都会被影响。 */
function pushScopeWarnings(
  warnings: string[],
  matches: Array<{ entry: ProfileEntry }>,
  requested: string[],
): void {
  const keys = hostnameSet(requested);
  for (const { entry } of matches) {
    const extra = entry.hostnames.filter((hostname) => !keys.has(normalizeHostname(hostname)));
    if (extra.length > 0) {
      warnings.push(`操作按整条记录生效，同时影响：${extra.join(', ')}`);
    }
  }
}

function assertSingleLayer(matches: Array<{ profile: Profile }>, hostnames: string[]): void {
  if (new Set(matches.map((match) => match.profile.id)).size > 1) {
    throw new InvalidInputError(
      `主机名 ${hostnames.join(', ')} 在多个层中命中，请用 --layer 指定层。`,
    );
  }
}

function pickTargetProfile(profiles: Profile[], layerId: string | undefined): Profile {
  if (layerId) {
    const profile = profiles.find((candidate) => candidate.id === layerId);
    if (!profile) throw new EntryNotFoundError(`当前未启用方案：${layerId}`);
    return profile;
  }
  if (profiles.length === 1) return profiles[0] as Profile;
  throw new InvalidInputError('当前启用了多个规则层，请用 --layer 指定写入哪个层。');
}

export async function listHosts(options: ListOptions = {}): Promise<HostsSnapshot> {
  return withWorkspace(options, async (workspace) => {
    const { loaded, warnings } = await prepare(workspace);
    if (loaded.raw === null) {
      throw new HostsFormatError(`hosts 文件不存在：${workspace.hostsPath}`);
    }
    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: false });

    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: loaded.document.managedRange !== null,
      onConflict: options.onConflict,
    });

    if (plan.changed) {
      warnings.push(
        '托管区块与规则集不一致（可能是手工修改或阶段 1 的禁用注释），运行 hostscli apply 可重建。',
      );
    }

    const managed = [...plan.merged.entries, ...plan.disabled].sort(
      (a, b) => a.hostnames[0]?.localeCompare(b.hostnames[0] ?? '') ?? 0,
    );
    const external = loaded.document.entries.filter((entry) => entry.source === 'external');
    const entries = [...managed, ...external];

    return {
      filePath: workspace.hostsPath,
      activeLayers: profiles.map((profile) => profile.id),
      entries,
      summary: {
        managed: plan.merged.entries.length,
        external: external.length,
        disabled: plan.disabled.filter((entry) => !entry.ttl).length,
        ttlDisabled: plan.disabled.filter((entry) => entry.ttl).length,
      },
      warnings,
    };
  });
}

export async function addHosts(options: AddHostsOptions): Promise<MutationResult> {
  return withWorkspace(options, async (workspace) => {
    const { loaded, warnings } = await prepare(workspace);
    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
    const target = pickTargetProfile(profiles, options.layerId);
    const input = validateEntryInput({
      ip: options.ip,
      hostnames: options.hostnames,
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
    });
    const keys = hostnameSet(input.hostnames);

    for (const entry of target.entries) {
      const shared = entry.hostnames.some((hostname) => keys.has(normalizeHostname(hostname)));
      if (!shared) continue;
      if (entry.ip === input.ip) {
        throw new DuplicateEntryError(`条目已存在：${input.ip} ${input.hostnames.join(' ')}`);
      }
      throw new DuplicateEntryError(
        `主机名 ${input.hostnames.join(', ')} 在方案 ${target.id} 中已映射到 ${entry.ip}；` +
          '同层内同名主机只能有一个 IP。',
      );
    }

    const entry: ProfileEntry = {
      ip: input.ip,
      hostnames: input.hostnames,
      enabled: true,
    };
    if (input.comment) entry.comment = input.comment;
    target.entries.push(entry);

    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: true,
      onConflict: options.onConflict,
    });

    return commitPlan(workspace, plan, {
      profiles: [target],
      persistState: true,
      warnings,
      affected: [toHostEntry(target, entry)],
    });
  });
}

export async function removeHosts(options: RemoveHostsOptions): Promise<MutationResult> {
  return withWorkspace(options, async (workspace) => {
    const { loaded, warnings } = await prepare(workspace);
    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
    const matches = matchEntries(profiles, options.hostnames, options.layerId);

    if (matches.length === 0) {
      const external = externalMatches(loaded.document, options.hostnames);
      if (external.length > 0) {
        throw new ExternalEntryError(
          `主机名只出现在非托管行中，hostscli 不会修改非托管内容：${options.hostnames.join(', ')}`,
        );
      }
      throw new EntryNotFoundError(`托管规则中找不到主机名：${options.hostnames.join(', ')}`);
    }

    assertSingleLayer(matches, options.hostnames);

    pushScopeWarnings(warnings, matches, options.hostnames);

    const affected = matches.map((match) => toHostEntry(match.profile, match.entry));
    const touched = new Set<string>();

    for (const match of matches) {
      const profile = match.profile;
      profile.entries = profile.entries.filter((entry) => entry !== match.entry);
      touched.add(profile.id);
      const entryId = entryIdFor(profile.id, match.entry);
      workspace.state.ttl = workspace.state.ttl.filter(
        (record) => !(record.layerId === profile.id && record.entryId === entryId),
      );
    }

    const external = externalMatches(loaded.document, options.hostnames);
    if (external.length > 0) {
      warnings.push('部分匹配只存在于非托管行，已保留未改动。');
    }

    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: loaded.document.managedRange !== null,
      onConflict: options.onConflict,
    });

    const result = await commitPlan(workspace, plan, {
      profiles: profiles.filter((profile) => touched.has(profile.id)),
      persistState: true,
      warnings,
      affected,
    });

    // 删除一条"已禁用"的条目不会改变 hosts 字节，但确实修改了方案数据；
    // 对调用方来说这仍是一次生效的操作，不能报成"不存在/无需变更"。
    const appliedToData = !workspace.dryRun && affected.length > 0;
    return { ...result, changed: result.changed || appliedToData };
  });
}

export async function setHostsEnabled(options: SetEnabledOptions): Promise<MutationResult> {
  return withWorkspace(options, async (workspace) => {
    const { loaded, warnings } = await prepare(workspace);
    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
    const matches = matchEntries(profiles, options.hostnames, options.layerId);

    if (matches.length === 0) {
      const external = externalMatches(loaded.document, options.hostnames);
      if (external.length > 0) {
        throw new ExternalEntryError(
          `主机名只出现在非托管行中，hostscli 不会修改非托管内容：${options.hostnames.join(', ')}`,
        );
      }
      throw new EntryNotFoundError(`托管规则中找不到主机名：${options.hostnames.join(', ')}`);
    }

    assertSingleLayer(matches, options.hostnames);

    pushScopeWarnings(warnings, matches, options.hostnames);

    const affected: HostEntry[] = [];
    const touched = new Set<string>();

    for (const match of matches) {
      if (match.entry.enabled !== options.enabled) {
        match.entry.enabled = options.enabled;
      }
      touched.add(match.profile.id);
      affected.push(toHostEntry(match.profile, match.entry));

      const entryId = entryIdFor(match.profile.id, match.entry);
      workspace.state.ttl = workspace.state.ttl.filter(
        (record) => !(record.layerId === match.profile.id && record.entryId === entryId),
      );
    }

    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: loaded.document.managedRange !== null,
      onConflict: options.onConflict,
    });

    const profilesToWrite = profiles.filter((profile) => touched.has(profile.id));

    return commitPlan(workspace, plan, {
      profiles: profilesToWrite,
      persistState: true,
      warnings,
      affected,
    });
  });
}

export async function initHosts(options: InitOptions = {}): Promise<MutationResult> {
  return withWorkspace(options, async (workspace) => {
    const { loaded, warnings } = await prepare(workspace);
    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: true,
      onConflict: options.onConflict,
    });

    const result = await commitPlan(workspace, plan, { persistState: true, warnings });
    if (!result.changed) {
      // init 的幂等性：已有围栏时重复执行不应产生写入或备份。
      return { ...result, backupPath: null, diff: '' };
    }
    return result;
  });
}

export async function applyHosts(options: InitOptions = {}): Promise<MutationResult> {
  return withWorkspace(options, async (workspace) => {
    const { loaded, warnings } = await prepare(workspace);
    const { profiles } = await resolveActiveLayers(workspace, loaded.document, { persist: true });
    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: loaded.document.managedRange !== null || profiles.length > 0,
      onConflict: options.onConflict,
    });
    return commitPlan(workspace, plan, { persistState: true, warnings });
  });
}

export { prepare, toHostEntry, matchEntries, assertSingleLayer, entryIdFor };
