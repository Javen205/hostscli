import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { EntryNotFoundError, InvalidInputError, NetworkError } from '../errors';
import type { Profile } from '../profiles/store';
import {
  profileIdSchema,
  parseProfileSource,
  readProfile,
  profileExists,
  writeProfile,
} from '../profiles/store';
import { saveConfig } from '../storage/config';
import type { RemoteSource } from '../storage/config';
import { saveState } from '../storage/state';
import { writeJsonFile } from '../storage/json';
import { atomicWriteFile } from '../system/atomic-write';
import type { Workspace, WorkspaceOptions } from '../engine/context';
import { withWorkspace } from '../engine/context';
import { auditAuxWrite } from '../engine/aux-write';
import { hashBytes } from '../engine/history';

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const cacheMetaSchema = z.object({
  url: z.string(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  fetchedAt: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
});

type CacheMeta = z.infer<typeof cacheMetaSchema>;

export interface RemoteView {
  source: RemoteSource;
  profileId: string;
  cached: boolean;
  cachedAt?: string;
  bytes?: number;
  etag?: string;
}

export interface AddRemoteOptions extends WorkspaceOptions {
  id: string;
  url: string;
  profileId?: string;
  name?: string;
  priority?: number;
  enabled?: boolean;
  /** 添加后是否启用为规则层（默认否）。 */
  activate?: boolean;
}

export interface RemoveRemoteOptions extends WorkspaceOptions {
  id: string;
}

export interface UpdateRemoteOptions extends WorkspaceOptions {
  /** 指定 ID；缺省更新全部启用的订阅。 */
  id?: string;
  /** 忽略缓存校验，强制重新下载。 */
  force?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RemoteUpdateResult {
  id: string;
  profileId: string;
  status: 'updated' | 'not-modified' | 'failed' | 'skipped';
  bytes?: number;
  profileUpdated: boolean;
  error?: string;
}

export interface RemoteUpdateSummary {
  results: RemoteUpdateResult[];
  failed: number;
  warnings: string[];
}

/** 去掉 URL 中的用户名、密码与 query，避免错误信息泄漏 token。 */
export function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<无法解析的 URL>';
  }
}

function assertRemoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidInputError('订阅地址不是合法 URL。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidInputError('订阅地址只支持 http / https。');
  }
  if (url.username || url.password) {
    throw new InvalidInputError('订阅地址不能内嵌用户名/密码，请去掉凭据后重试。');
  }
  return url.toString();
}

function cachePaths(workspace: Workspace, profileId: string): { meta: string; content: string } {
  const checked = profileIdSchema.safeParse(profileId);
  if (!checked.success) {
    throw new InvalidInputError(`无效的方案 ID：${profileId}`);
  }
  const base = join(workspace.paths.cacheDir, 'remote', checked.data);
  return { meta: `${base}.json`, content: `${base}.content` };
}

async function readCacheMeta(path: string): Promise<CacheMeta | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const parsed = cacheMetaSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readCachedContent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

interface FetchedBody {
  status: number;
  text?: string;
  bytes?: number;
  etag?: string;
  lastModified?: string;
}

async function fetchText(
  url: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    etag?: string;
    lastModified?: string;
  },
): Promise<FetchedBody> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();

  try {
    const headers: Record<string, string> = {
      'user-agent': 'hostscli-remote/1',
      accept: 'text/plain, application/json;q=0.9, */*;q=0.1',
    };
    if (options.etag) headers['if-none-match'] = options.etag;
    if (options.lastModified) headers['if-modified-since'] = options.lastModified;

    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    const etag = response.headers.get('etag') ?? undefined;
    const lastModified = response.headers.get('last-modified') ?? undefined;

    if (response.status === 304) return { status: 304, etag, lastModified };

    if (!response.ok) {
      throw new NetworkError(
        `订阅 ${displayUrl(url)} 返回 HTTP ${response.status}，保留上次成功缓存。`,
      );
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      throw new NetworkError(
        `订阅内容超过 --max-bytes 限制（${contentLength} > ${options.maxBytes}），已中止。`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new NetworkError(`订阅 ${displayUrl(url)} 没有返回可读内容。`);
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new NetworkError(
          `订阅内容超过 --max-bytes 限制（> ${options.maxBytes} 字节），已中止。`,
        );
      }
      chunks.push(Buffer.from(value));
    }

    return {
      status: response.status,
      text: Buffer.concat(chunks).toString('utf8'),
      bytes,
      etag,
      lastModified,
    };
  } catch (error) {
    if (error instanceof NetworkError) throw error;
    const aborted = (error as Error).name === 'AbortError';
    throw new NetworkError(
      aborted
        ? `订阅 ${displayUrl(url)} 请求超时（${options.timeoutMs}ms），保留上次成功缓存。`
        : `订阅 ${displayUrl(url)} 请求失败：${(error as Error).message}，保留上次成功缓存。`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function findSource(workspace: Workspace, id: string): Promise<RemoteSource> {
  const source = workspace.config.remote.sources.find((candidate) => candidate.id === id);
  if (!source) throw new EntryNotFoundError(`订阅不存在：${id}`);
  return source;
}

function toProfile(source: RemoteSource, parsed: ReturnType<typeof parseProfileSource>): Profile {
  const id = source.profileId ?? source.id;
  return {
    schemaVersion: 1,
    id,
    name: source.name ?? parsed.name ?? id,
    priority: source.priority ?? parsed.priority ?? 0,
    entries: parsed.entries,
  };
}

async function updateOne(
  workspace: Workspace,
  source: RemoteSource,
  options: { force?: boolean; timeoutMs: number; maxBytes: number },
): Promise<RemoteUpdateResult> {
  const profileId = source.profileId ?? source.id;
  const paths = cachePaths(workspace, profileId);

  const meta = options.force ? null : await readCacheMeta(paths.meta);
  const cached = meta ? await readCachedContent(paths.content) : null;

  let fetched: FetchedBody;
  try {
    fetched = await fetchText(source.url, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      ...(meta?.etag ? { etag: meta.etag } : {}),
      ...(meta?.lastModified ? { lastModified: meta.lastModified } : {}),
    });
  } catch (error) {
    return {
      id: source.id,
      profileId,
      status: 'failed',
      profileUpdated: false,
      error: (error as Error).message,
    };
  }

  if (fetched.status === 304) {
    if (!cached) {
      return {
        id: source.id,
        profileId,
        status: 'failed',
        profileUpdated: false,
        error: '服务端返回 304，但本地没有缓存内容。请使用 remote update --force 重新拉取。',
      };
    }
    return {
      id: source.id,
      profileId,
      status: 'not-modified',
      bytes: cached.byteLength,
      profileUpdated: false,
    };
  }

  const content = Buffer.from(fetched.text ?? '', 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');

  if (meta && meta.sha256 === sha256 && cached) {
    await writeCacheMeta(paths.meta, { ...meta, fetchedAt: workspace.now.toISOString() });
    return {
      id: source.id,
      profileId,
      status: 'not-modified',
      bytes: content.byteLength,
      profileUpdated: false,
    };
  }

  let parsed: ReturnType<typeof parseProfileSource>;
  try {
    parsed = parseProfileSource(content, `远程订阅 ${source.id}`);
  } catch (error) {
    return {
      id: source.id,
      profileId,
      status: 'failed',
      profileUpdated: false,
      error: (error as Error).message,
    };
  }

  // 先写缓存，再写方案：缓存是“上次成功内容”，失败时不能被半截覆盖。
  await mkdir(join(workspace.paths.cacheDir, 'remote'), { recursive: true, mode: 0o700 });
  await atomicWriteFile(paths.content, content, { mode: 0o600, defaultMode: 0o600 });
  await writeCacheMeta(paths.meta, {
    url: source.url,
    fetchedAt: workspace.now.toISOString(),
    sha256,
    bytes: content.byteLength,
    ...(fetched.etag ? { etag: fetched.etag } : {}),
    ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
  });

  const exists = await profileExists(workspace.paths.profilesDir, profileId);
  let profile: Profile;
  if (exists) {
    const existing = await readProfile(workspace.paths.profilesDir, profileId);
    profile = { ...existing, entries: parsed.entries };
  } else {
    profile = toProfile(source, parsed);
  }
  await writeProfile(workspace.paths.profilesDir, profile);

  source.lastUpdatedAt = workspace.now.toISOString();
  return {
    id: source.id,
    profileId,
    status: 'updated',
    bytes: content.byteLength,
    profileUpdated: true,
  };
}

async function writeCacheMeta(path: string, meta: CacheMeta): Promise<void> {
  // 写缓存前重新校验，防止调用方传入缺字段/负字节数等不完整元数据。
  await writeJsonFile(path, cacheMetaSchema.parse(meta));
}

export async function addRemoteSource(
  options: AddRemoteOptions,
): Promise<{ source: RemoteSource; warnings: string[] }> {
  return withWorkspace(options, async (workspace) => {
    const checkedId = profileIdSchema.safeParse(options.id);
    if (!checkedId.success) {
      throw new InvalidInputError(
        checkedId.error.issues[0]?.message ?? `无效的订阅 ID：${options.id}`,
      );
    }
    if (workspace.config.remote.sources.some((source) => source.id === checkedId.data)) {
      throw new InvalidInputError(`订阅已存在：${checkedId.data}`);
    }

    const url = assertRemoteUrl(options.url);
    const profileId = options.profileId ?? checkedId.data;
    const checkedProfileId = profileIdSchema.safeParse(profileId);
    if (!checkedProfileId.success) {
      throw new InvalidInputError(
        checkedProfileId.error.issues[0]?.message ?? `无效的方案 ID：${profileId}`,
      );
    }

    const source: RemoteSource = {
      id: checkedId.data,
      url,
      enabled: options.enabled !== false,
      profileId: checkedProfileId.data,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
    };
    const before = await readFileOrNull(workspace.paths.configPath);
    workspace.config.remote.sources.push(source);

    if (options.activate) {
      if (!workspace.state.activeLayers.includes(source.profileId ?? source.id)) {
        workspace.state.activeLayers.push(source.profileId ?? source.id);
      }
      workspace.state.initialized = true;
    }

    await saveConfig(workspace.paths.configPath, workspace.config);
    if (options.activate) {
      await saveState(workspace.paths.statePath, workspace.state);
    }
    // detail 只放去掉凭据与 query 的 URL，避免审计日志泄漏订阅 token。
    await auditAuxWrite(workspace, {
      command: 'remote add',
      args: [source.id],
      beforeSha256: hashBytes(before),
      afterSha256: hashBytes(await readFileOrNull(workspace.paths.configPath)),
      detail: `添加订阅 ${source.id} → ${displayUrl(source.url)}（方案 ${source.profileId}，启用=${source.enabled}，activate=${options.activate === true}）。`,
    });

    const warnings: string[] = [];
    const profileIdValue = source.profileId ?? source.id;
    if (await profileExists(workspace.paths.profilesDir, profileIdValue)) {
      warnings.push(`方案 ${profileIdValue} 已存在，remote update 会覆盖其 entries。`);
    }
    if (options.activate) {
      warnings.push('层已加入启用集合；运行 hostscli stack apply --apply 才会写入 hosts。');
    }
    return { source, warnings };
  });
}

export async function listRemoteSources(
  options: WorkspaceOptions = {},
): Promise<{ sources: RemoteView[] }> {
  return withWorkspace(options, async (workspace) => {
    const sources = await Promise.all(
      workspace.config.remote.sources.map(async (source): Promise<RemoteView> => {
        const profileId = source.profileId ?? source.id;
        const meta = await readCacheMeta(cachePaths(workspace, profileId).meta);
        return {
          source,
          profileId,
          cached: meta !== null,
          ...(meta?.fetchedAt ? { cachedAt: meta.fetchedAt } : {}),
          ...(meta?.bytes !== undefined ? { bytes: meta.bytes } : {}),
          ...(meta?.etag ? { etag: meta.etag } : {}),
        };
      }),
    );
    return { sources };
  });
}

export async function removeRemoteSource(
  options: RemoveRemoteOptions,
): Promise<{ removed: string; warnings: string[] }> {
  return withWorkspace(options, async (workspace) => {
    const source = await findSource(workspace, options.id);
    const before = await readFileOrNull(workspace.paths.configPath);
    workspace.config.remote.sources = workspace.config.remote.sources.filter(
      (candidate) => candidate.id !== options.id,
    );
    await saveConfig(workspace.paths.configPath, workspace.config);

    const profileId = source.profileId ?? source.id;
    const paths = cachePaths(workspace, profileId);
    await Promise.all([
      unlink(paths.meta).catch(() => undefined),
      unlink(paths.content).catch(() => undefined),
    ]);
    await auditAuxWrite(workspace, {
      command: 'remote remove',
      args: [options.id],
      beforeSha256: hashBytes(before),
      afterSha256: hashBytes(await readFileOrNull(workspace.paths.configPath)),
      detail: `删除订阅 ${source.id}（${displayUrl(source.url)}），清理缓存；方案 ${profileId} 保留。`,
    });

    return {
      removed: options.id,
      warnings: [
        `方案 ${profileId} 仍保留；如不再需要，请运行 hostscli profile remove ${profileId}。`,
      ],
    };
  });
}

export async function updateRemoteSources(
  options: UpdateRemoteOptions = {},
): Promise<RemoteUpdateSummary> {
  return withWorkspace(options, async (workspace) => {
    const targets = options.id
      ? [await findSource(workspace, options.id)]
      : workspace.config.remote.sources.filter((source) => source.enabled);

    if (targets.length === 0) {
      throw new InvalidInputError('没有可更新的订阅（用 remote add 添加，或指定 ID）。');
    }

    const timeoutMs = options.timeoutMs ?? workspace.config.remote.timeoutMs;
    const maxBytes = options.maxBytes ?? workspace.config.remote.maxBytes;
    const before = await readFileOrNull(workspace.paths.configPath);
    const results: RemoteUpdateResult[] = [];
    const warnings: string[] = [];

    for (const source of targets) {
      if (!source.enabled && options.id) {
        warnings.push(`订阅 ${source.id} 处于停用状态，本次按显式 ID 仍执行更新。`);
      }
      const result = await updateOne(workspace, source, {
        force: options.force,
        timeoutMs,
        maxBytes,
      });
      results.push(result);
      if (result.status === 'failed' && result.error) {
        warnings.push(`${source.id}: ${result.error}`);
      }
    }

    await saveConfig(workspace.paths.configPath, workspace.config);
    // 订阅更新会同时改写缓存、方案文件与 config（lastUpdatedAt）；
    // 以 config 前后指纹作为命令级凭据，逐个结果写入 detail。
    await auditAuxWrite(workspace, {
      command: 'remote update',
      args: options.id ? [options.id] : [],
      beforeSha256: hashBytes(before),
      afterSha256: hashBytes(await readFileOrNull(workspace.paths.configPath)),
      changed: results.some((result) => result.profileUpdated),
      detail: `更新订阅：${results
        .map(
          (result) =>
            `${result.id}→${result.profileId} ${result.status}${result.profileUpdated ? '（方案已改写）' : ''}`,
        )
        .join('；')}。`,
    });
    return {
      results,
      failed: results.filter((result) => result.status === 'failed').length,
      warnings,
    };
  });
}
