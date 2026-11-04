import { readFile } from 'node:fs/promises';
import { EntryNotFoundError, InvalidInputError, NetworkError } from '../errors';
import { detectNetwork } from '../network/detect';
import type { NetworkInfo } from '../network/detect';
import { profileIdSchema, readProfile } from '../profiles/store';
import { saveConfig } from '../storage/config';
import type { NetworkMapping } from '../storage/config';
import { commitPlan } from './commit';
import type { WorkspaceOptions } from './context';
import { withWorkspace } from './context';
import { prepare } from './crud';
import { buildRenderPlan } from './plan';
import type { MutationResult } from './types';
import { auditAuxWrite } from './aux-write';
import { hashBytes } from './history';

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface NetworkStatusResult {
  network: NetworkInfo;
  mapping: NetworkMapping | null;
  activeLayers: string[];
  warnings: string[];
}

export interface MapNetworkOptions extends WorkspaceOptions {
  ssid: string;
  layers: string[];
  name?: string;
}

export interface UnmapNetworkOptions extends WorkspaceOptions {
  ssid: string;
}

export interface NetworkAutoOptions extends WorkspaceOptions {
  /** 测试注入网络识别。 */
  detect?: () => Promise<NetworkInfo>;
}

export interface NetworkAutoResult {
  network: NetworkInfo;
  mapping: NetworkMapping;
  previousLayers: string[];
  activeLayers: string[];
  changedLayers: boolean;
  dryRun: boolean;
  mutation: MutationResult | null;
  warnings: string[];
}

function findMapping(mappings: NetworkMapping[], ssid: string): NetworkMapping | undefined {
  return mappings.find((mapping) => mapping.ssid === ssid);
}

function assertSsid(ssid: string): string {
  const value = ssid.trim();
  if (!value) throw new InvalidInputError('SSID 不能为空。');
  if (value.length > 64) throw new InvalidInputError('SSID 过长（最多 64 字符）。');
  return value;
}

/** 去空白、去重；层 ID 同时是文件名，必须先校验再落盘，避免把非法配置保存下来。 */
function normalizeLayerIds(layers: string[]): string[] {
  const ids = [...new Set(layers.map((layer) => layer.trim()).filter(Boolean))];
  for (const id of ids) {
    const result = profileIdSchema.safeParse(id);
    if (!result.success) {
      throw new InvalidInputError(
        `无效的层 ID「${id}」：${result.error.issues[0]?.message ?? '格式不合法'}`,
      );
    }
  }
  return ids;
}

export async function listNetworkMappings(
  options: WorkspaceOptions = {},
): Promise<{ mappings: NetworkMapping[] }> {
  return withWorkspace(options, async (workspace) => ({
    mappings: workspace.config.network.mappings,
  }));
}

export async function mapNetwork(
  options: MapNetworkOptions,
): Promise<{ mapping: NetworkMapping; replaced: boolean; warnings: string[] }> {
  return withWorkspace(options, async (workspace) => {
    const ssid = assertSsid(options.ssid);
    const layers = normalizeLayerIds(options.layers);

    const mapping: NetworkMapping = {
      ssid,
      layers,
      ...(options.name !== undefined ? { name: options.name } : {}),
    };
    const before = await readFileOrNull(workspace.paths.configPath);
    const existing = findMapping(workspace.config.network.mappings, ssid);
    if (existing) Object.assign(existing, mapping);
    else workspace.config.network.mappings.push(mapping);
    await saveConfig(workspace.paths.configPath, workspace.config);
    await auditAuxWrite(workspace, {
      command: 'network map',
      args: [ssid, `--layers=${layers.join(',')}`],
      beforeSha256: hashBytes(before),
      afterSha256: hashBytes(await readFileOrNull(workspace.paths.configPath)),
      detail: `映射 ${ssid} → ${layers.join(', ') || '（空）'}（${existing ? '覆盖' : '新增'}）。`,
    });

    const warnings: string[] = [];
    if (layers.length === 0) {
      warnings.push('映射为空；network auto 会清空当前启用层。');
    }
    for (const layer of layers) {
      try {
        await readProfile(workspace.paths.profilesDir, layer);
      } catch (error) {
        // 只有“方案不存在”可以降级为警告；文件损坏必须暴露，不能静默保存坏映射。
        if (!(error instanceof EntryNotFoundError)) throw error;
        warnings.push(`层 ${layer} 尚不存在；network auto 时会失败，请先 stack layer add。`);
      }
    }
    return { mapping, replaced: existing !== undefined, warnings };
  });
}

export async function unmapNetwork(options: UnmapNetworkOptions): Promise<{ removed: string }> {
  return withWorkspace(options, async (workspace) => {
    const ssid = assertSsid(options.ssid);
    const before = await readFileOrNull(workspace.paths.configPath);
    const beforeCount = workspace.config.network.mappings.length;
    workspace.config.network.mappings = workspace.config.network.mappings.filter(
      (mapping) => mapping.ssid !== ssid,
    );
    if (workspace.config.network.mappings.length === beforeCount) {
      throw new EntryNotFoundError(`没有 SSID ${ssid} 的映射。`);
    }
    await saveConfig(workspace.paths.configPath, workspace.config);
    await auditAuxWrite(workspace, {
      command: 'network unmap',
      args: [ssid],
      beforeSha256: hashBytes(before),
      afterSha256: hashBytes(await readFileOrNull(workspace.paths.configPath)),
      detail: `删除 SSID ${ssid} 的映射。`,
    });
    return { removed: ssid };
  });
}

export async function networkStatus(
  options: WorkspaceOptions & { detect?: () => Promise<NetworkInfo> } = {},
): Promise<NetworkStatusResult> {
  return withWorkspace(options, async (workspace) => {
    const network = options.detect
      ? await options.detect()
      : await detectNetwork(workspace.platformId);
    const warnings: string[] = [];
    if (network.detail) warnings.push(network.detail);
    const mapping = network.ssid
      ? (findMapping(workspace.config.network.mappings, network.ssid) ?? null)
      : null;
    if (network.ssid && !mapping) {
      warnings.push(`SSID ${network.ssid} 尚未配置映射（hostscli network map）。`);
    }
    return {
      network,
      mapping,
      activeLayers: workspace.state.activeLayers,
      warnings,
    };
  });
}

/**
 * 按当前网络应用映射层并重建 hosts。可重复执行（幂等）；供用户手动调用，
 * 也可交给 launchd/cron 定期触发。本阶段不安装后台守护进程（见 stage-4 限制）。
 */
export async function networkAuto(options: NetworkAutoOptions = {}): Promise<NetworkAutoResult> {
  return withWorkspace(options, async (workspace) => {
    const network = options.detect
      ? await options.detect()
      : await detectNetwork(workspace.platformId);
    const warnings: string[] = [];
    if (!network.supported) {
      throw new NetworkError(network.detail ?? '当前平台不支持网络环境识别。');
    }
    if (!network.ssid) {
      throw new NetworkError(network.detail ?? '无法识别当前 Wi-Fi SSID（可能未连接或无权限）。');
    }

    const found = findMapping(workspace.config.network.mappings, network.ssid);
    if (!found) {
      throw new EntryNotFoundError(
        `SSID ${network.ssid} 没有映射。先运行 hostscli network map ${network.ssid} --layers <id,id>。`,
      );
    }

    // 配置可能被手工编辑，这里再校验一次，避免把非法 ID 当作文件名读取。
    const layers = normalizeLayerIds(found.layers);
    if (layers.length === 0) warnings.push('该 SSID 的映射为空，将清空当前启用层。');
    const mapping: NetworkMapping = { ...found, layers };

    const profiles = await Promise.all(
      layers.map((id) => readProfile(workspace.paths.profilesDir, id)),
    );

    const previousLayers = [...workspace.state.activeLayers];
    const changedLayers =
      previousLayers.length !== layers.length ||
      previousLayers.some((id, index) => id !== layers[index]);

    if (workspace.dryRun) {
      return {
        network,
        mapping,
        previousLayers,
        activeLayers: layers,
        changedLayers,
        dryRun: true,
        mutation: null,
        warnings,
      };
    }

    workspace.state.activeLayers = [...layers];
    workspace.state.initialized = true;

    const { loaded, warnings: prepareWarnings } = await prepare(workspace);
    warnings.push(...prepareWarnings);
    const plan = buildRenderPlan(workspace, loaded, profiles, {
      appendIfMissing: loaded.document.managedRange !== null || profiles.length > 0,
    });
    const mutation = await commitPlan(workspace, plan, {
      persistState: true,
      warnings,
    });

    return {
      network,
      mapping,
      previousLayers,
      activeLayers: mapping.layers,
      changedLayers,
      dryRun: false,
      mutation,
      warnings: mutation.warnings,
    };
  });
}
