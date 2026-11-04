import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HostsCliError } from '../errors';
import { createEntryId } from '../hosts/models';
import { profileIdSchema } from '../profiles/store';
import { stateSchema } from '../storage/state';
import type { HostsCliState } from '../storage/state';
import { atomicWriteFile } from '../system/atomic-write';

/**
 * 写操作历史（undo 的持久化底座）。
 *
 * 每次成功写入后，把"写入前的 hosts / state / 相关 profile 原始字节"落到
 * `dataDir/history/<id>/`，并在 `history/journal.jsonl` 追加一条记录。
 * undo 直接按原始字节回放，不重新渲染，因此能保证 hosts、state、profile 三处
 * 与操作前完全一致（而不是"语义上差不多"）。
 *
 * 目录与文件都是 0600/0700；`history/` 不进入 git 快照（见 git.ts 的 exclude）。
 */

export interface ChangeEntry {
  ip: string;
  hostnames: string[];
}

export interface ChangeSummary {
  added: ChangeEntry[];
  removed: ChangeEntry[];
  disabled: ChangeEntry[];
  restored: ChangeEntry[];
}

export interface HistoryFingerprint {
  /** hosts 原始字节的 sha256；文件不存在时为 null。 */
  hosts: string | null;
  /** state.json 原始字节的 sha256；文件不存在时为 null。 */
  state: string | null;
  /** 本次操作触及的 profile 原始字节哈希；不存在的 profile 为 null。 */
  profiles: Record<string, string | null>;
}

export interface HistoryRecord {
  id: string;
  seq: number;
  at: string;
  kind: 'write' | 'undo';
  command: string;
  args?: string[];
  hostsPath: string;
  planHash: string | null;
  before: HistoryFingerprint;
  after: HistoryFingerprint;
  summary: ChangeSummary;
  /** 本次 undo 撤销（消费）的历史记录 ID，按旧 → 新排列。 */
  consumes?: string[];
  /** 写入者；与审计记录保持一致。 */
  operator?: { uid: number | null; username: string | null };
}

interface SnapshotManifest {
  hosts: boolean;
  state: boolean;
  profiles: Record<string, boolean>;
}

export interface HistorySnapshot {
  hosts: Buffer | null;
  state: Buffer | null;
  profiles: Map<string, Buffer | null>;
}

export function historyDirFor(dataDir: string): string {
  return join(dataDir, 'history');
}

function journalPathFor(dataDir: string): string {
  return join(historyDirFor(dataDir), 'journal.jsonl');
}

function snapshotDirFor(dataDir: string, id: string): string {
  return join(historyDirFor(dataDir), id);
}

export function hashBytes(value: Buffer | null): string | null {
  if (value === null) return null;
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function shaOrNull(value: Buffer | null): string | null {
  return hashBytes(value);
}

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isValidRecord(value: unknown): value is HistoryRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<HistoryRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.seq === 'number' &&
    typeof record.command === 'string' &&
    typeof record.before === 'object' &&
    typeof record.after === 'object'
  );
}

/** 读取全部历史记录；损坏行会被跳过，不阻断 undo。 */
export async function readHistory(dataDir: string): Promise<HistoryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(journalPathFor(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: HistoryRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isValidRecord(parsed)) records.push(parsed);
    } catch {
      // 损坏行跳过：历史是辅助能力，不应让主操作不可用。
    }
  }
  return records;
}

/** 按 journal 顺序（旧 → 新）返回尚未被 undo 消费的记录。 */
export function availableHistory(records: HistoryRecord[]): HistoryRecord[] {
  const consumed = new Set<string>();
  for (const record of records) {
    for (const id of record.consumes ?? []) consumed.add(id);
  }
  return records.filter((record) => !consumed.has(record.id));
}

async function writeSnapshot(
  dataDir: string,
  id: string,
  snapshot: HistorySnapshot,
): Promise<void> {
  const dir = snapshotDirFor(dataDir, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'profiles'), { recursive: true, mode: 0o700 });

  const manifest: SnapshotManifest = {
    hosts: snapshot.hosts !== null,
    state: snapshot.state !== null,
    profiles: {},
  };
  for (const [profileId, content] of snapshot.profiles) {
    profileIdSchema.parse(profileId);
    manifest.profiles[profileId] = content !== null;
    if (content !== null) {
      await atomicWriteFile(join(dir, 'profiles', `${profileId}.json`), content, { mode: 0o600 });
    }
  }
  if (snapshot.hosts !== null) {
    await atomicWriteFile(join(dir, 'hosts'), snapshot.hosts, { mode: 0o600 });
  }
  if (snapshot.state !== null) {
    await atomicWriteFile(join(dir, 'state.json'), snapshot.state, { mode: 0o600 });
  }
  await atomicWriteFile(join(dir, 'manifest.json'), Buffer.from(JSON.stringify(manifest)), {
    mode: 0o600,
  });
}

export async function readSnapshot(
  dataDir: string,
  record: HistoryRecord,
): Promise<HistorySnapshot> {
  const dir = snapshotDirFor(dataDir, record.id);
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as SnapshotManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HostsCliError(
        'INVALID_INPUT',
        `历史记录 ${record.id} 的快照已被清理，无法撤销；可用更近的记录或重新执行操作。`,
      );
    }
    throw new HostsCliError('STORAGE_CORRUPT', `历史快照损坏（${record.id}）：${String(error)}`);
  }

  // manifest 声称存在的文件必须能读到：静默当作 null 会在 undo 时删除用户文件。
  const readRequired = async (path: string, label: string): Promise<Buffer> => {
    try {
      return await readFile(path);
    } catch (error) {
      throw new HostsCliError(
        'INVALID_INPUT',
        `历史记录 ${record.id} 的 ${label} 缺失或不可读，已拒绝撤销以免删除现有内容：${String(error)}`,
      );
    }
  };

  const profiles = new Map<string, Buffer | null>();
  for (const [profileId, existed] of Object.entries(manifest.profiles ?? {})) {
    profiles.set(
      profileId,
      existed
        ? await readRequired(join(dir, 'profiles', `${profileId}.json`), `方案 ${profileId}`)
        : null,
    );
  }
  return {
    hosts: manifest.hosts ? await readRequired(join(dir, 'hosts'), 'hosts 快照') : null,
    state: manifest.state ? await readRequired(join(dir, 'state.json'), 'state 快照') : null,
    profiles,
  };
}

interface ProfileLike {
  id: string;
  entries: Array<{ ip: string; hostnames: string[]; enabled: boolean }>;
}

function parseProfileBytes(bytes: Buffer | null): ProfileLike | null {
  if (bytes === null) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8')) as ProfileLike;
    if (typeof value.id !== 'string' || !Array.isArray(value.entries)) return null;
    return value;
  } catch {
    return null;
  }
}

function hostKey(entry: { ip: string; hostnames: string[] }): string {
  return `${entry.ip}\u0000${entry.hostnames.join(',')}`;
}

function mapEntries(entries: Array<{ ip: string; hostnames: string[] }>): Map<string, ChangeEntry> {
  const map = new Map<string, ChangeEntry>();
  for (const entry of entries) {
    map.set(hostKey(entry), { ip: entry.ip, hostnames: [...entry.hostnames] });
  }
  return map;
}

function ttlKeys(state: HostsCliState): Set<string> {
  return new Set(state.ttl.map((record) => `${record.layerId}\u0000${record.entryId}`));
}

interface ChangeInput {
  hosts: Array<{ ip: string; hostnames: string[] }>;
  profiles: ProfileLike[];
  ttl: Set<string>;
}

function profileEntryKey(profileId: string, entry: { ip: string; hostnames: string[] }): string {
  return `${profileId}\u0000${createEntryId(profileId, entry.ip, entry.hostnames)}`;
}

/**
 * 计算条目级变更摘要：新增 / 删除 / 禁用 / 恢复。
 * - 禁用/恢复由 profile 的 enabled 翻转或 TTL 记录增减判定；
 * - 新增/删除是 hosts 托管区前后差集，剔除已归入禁用/恢复的条目，避免重复计数。
 */
export function summarizeChange(before: ChangeInput, after: ChangeInput): ChangeSummary {
  const beforeHosts = mapEntries(before.hosts);
  const afterHosts = mapEntries(after.hosts);
  const disabled = new Map<string, ChangeEntry>();
  const restored = new Map<string, ChangeEntry>();

  const beforeEnabled = new Map<string, boolean>();
  const afterEnabled = new Map<string, boolean>();
  for (const profile of before.profiles) {
    for (const entry of profile.entries) {
      beforeEnabled.set(profileEntryKey(profile.id, entry), entry.enabled);
    }
  }
  for (const profile of after.profiles) {
    for (const entry of profile.entries) {
      afterEnabled.set(profileEntryKey(profile.id, entry), entry.enabled);
    }
  }

  for (const [key, enabled] of beforeEnabled) {
    if (enabled && afterEnabled.get(key) === false) {
      const [, ip, hostnames] = key.split('\u0000');
      const entry = { ip: ip ?? '', hostnames: (hostnames ?? '').split(',') };
      disabled.set(hostKey(entry), entry);
    }
    if (!enabled && afterEnabled.get(key) === true) {
      const [, ip, hostnames] = key.split('\u0000');
      const entry = { ip: ip ?? '', hostnames: (hostnames ?? '').split(',') };
      restored.set(hostKey(entry), entry);
    }
  }

  const addedTtl = [...after.ttl].filter((key) => !before.ttl.has(key));
  const removedTtl = [...before.ttl].filter((key) => !after.ttl.has(key));
  for (const key of addedTtl) {
    const entryId = key.split('\u0000')[1] ?? '';
    const entry =
      findProfileEntry(before.profiles, entryId) ?? findProfileEntry(after.profiles, entryId);
    if (entry) disabled.set(hostKey(entry), entry);
  }
  for (const key of removedTtl) {
    const entryId = key.split('\u0000')[1] ?? '';
    const entry =
      findProfileEntry(after.profiles, entryId) ?? findProfileEntry(before.profiles, entryId);
    if (entry) restored.set(hostKey(entry), entry);
  }

  const added: ChangeEntry[] = [];
  for (const [key, entry] of afterHosts) {
    if (!beforeHosts.has(key) && !restored.has(key)) added.push(entry);
  }
  const removed: ChangeEntry[] = [];
  for (const [key, entry] of beforeHosts) {
    if (!afterHosts.has(key) && !disabled.has(key)) removed.push(entry);
  }

  return {
    added,
    removed,
    disabled: [...disabled.values()],
    restored: [...restored.values()],
  };
}

function findProfileEntry(
  profiles: ProfileLike[],
  entryId: string,
): { ip: string; hostnames: string[] } | null {
  for (const profile of profiles) {
    for (const entry of profile.entries) {
      if (createEntryId(profile.id, entry.ip, entry.hostnames) === entryId) {
        return { ip: entry.ip, hostnames: entry.hostnames };
      }
    }
  }
  return null;
}

export interface RecordOperationInput {
  dataDir: string;
  hostsPath: string;
  command: string;
  args?: string[];
  planHash?: string | null;
  kind?: 'write' | 'undo';
  consumes?: string[];
  keep: number;
  beforeHosts: Buffer | null;
  afterHosts: Buffer | null;
  beforeStateRaw: Buffer | null;
  afterStateRaw: Buffer | null;
  beforeProfiles: Map<string, Buffer | null>;
  afterProfiles: Map<string, Buffer | null>;
  hostsBefore: Array<{ ip: string; hostnames: string[] }>;
  hostsAfter: Array<{ ip: string; hostnames: string[] }>;
  stateBefore: HostsCliState;
  stateAfter: HostsCliState;
  operator?: { uid: number | null; username: string | null };
  now: Date;
  /** 记录写入失败时不抛错以外的副作用；返回是否成功。 */
}

/**
 * 记录一次成功写入。快照先落盘、再追加日志；任何一步失败都由调用方
 * 降级为 warning，不阻断主操作。
 */
export async function recordOperation(input: RecordOperationInput): Promise<HistoryRecord> {
  const records = await readHistory(input.dataDir);
  const last = records.at(-1);
  const seq = (last?.seq ?? 0) + 1;
  const id = `${String(seq).padStart(5, '0')}-${randomBytes(3).toString('hex')}`;

  const beforeFingerprint: HistoryFingerprint = {
    hosts: shaOrNull(input.beforeHosts),
    state: shaOrNull(input.beforeStateRaw),
    profiles: {},
  };
  const afterFingerprint: HistoryFingerprint = {
    hosts: shaOrNull(input.afterHosts),
    state: shaOrNull(input.afterStateRaw),
    profiles: {},
  };
  for (const [profileId, content] of input.beforeProfiles) {
    beforeFingerprint.profiles[profileId] = shaOrNull(content);
  }
  for (const [profileId, content] of input.afterProfiles) {
    afterFingerprint.profiles[profileId] = shaOrNull(content);
  }

  const profilesBefore = [...input.beforeProfiles.values()]
    .map(parseProfileBytes)
    .filter((profile): profile is ProfileLike => profile !== null);
  const profilesAfter = [...input.afterProfiles.values()]
    .map(parseProfileBytes)
    .filter((profile): profile is ProfileLike => profile !== null);

  const record: HistoryRecord = {
    id,
    seq,
    at: input.now.toISOString(),
    kind: input.kind ?? 'write',
    command: input.command,
    ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
    hostsPath: input.hostsPath,
    planHash: input.planHash ?? null,
    before: beforeFingerprint,
    after: afterFingerprint,
    summary: summarizeChange(
      {
        hosts: input.hostsBefore,
        profiles: profilesBefore,
        ttl: ttlKeys(input.stateBefore),
      },
      { hosts: input.hostsAfter, profiles: profilesAfter, ttl: ttlKeys(input.stateAfter) },
    ),
    ...(input.consumes && input.consumes.length > 0 ? { consumes: input.consumes } : {}),
    ...(input.operator ? { operator: input.operator } : {}),
  };

  await writeSnapshot(input.dataDir, id, {
    hosts: input.beforeHosts,
    state: input.beforeStateRaw,
    profiles: input.beforeProfiles,
  });

  await mkdir(historyDirFor(input.dataDir), { recursive: true, mode: 0o700 });
  await appendFile(journalPathFor(input.dataDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });

  await pruneHistory(input.dataDir, Math.max(1, input.keep));
  return record;
}

async function pruneHistory(dataDir: string, keep: number): Promise<void> {
  const records = await readHistory(dataDir);
  if (records.length <= keep) return;
  const removed = records.slice(0, records.length - keep);
  const kept = records.slice(records.length - keep);
  for (const record of removed) {
    await rm(snapshotDirFor(dataDir, record.id), { recursive: true, force: true });
  }
  await atomicWriteFile(
    journalPathFor(dataDir),
    Buffer.from(kept.map((record) => `${JSON.stringify(record)}\n`).join('')),
    { mode: 0o600 },
  );
}

/** 读取目录下所有 profile 原始字节（undo 回放时用于构造可再撤销的快照）。 */
export async function readAllProfiles(profilesDir: string): Promise<Map<string, Buffer | null>> {
  const map = new Map<string, Buffer | null>();
  let names: string[];
  try {
    names = await readdir(profilesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return map;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!profileIdSchema.safeParse(id).success) continue;
    map.set(id, await readFileOrNull(join(profilesDir, name)));
  }
  return map;
}

/** 写入快照时用到的底层函数（undo 回滚失败时复用）。 */
export async function restoreFile(path: string, content: Buffer | null): Promise<void> {
  if (content === null) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  await atomicWriteFile(path, content, { mode: 0o600 });
}

export async function readStateRaw(statePath: string): Promise<Buffer | null> {
  return readFileOrNull(statePath);
}

/** 把原始 state 字节解析为模型；损坏时抛出 STORAGE_CORRUPT。 */
export function parseStateBytes(bytes: Buffer | null): HostsCliState {
  if (bytes === null) return stateSchema.parse({});
  try {
    return stateSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new HostsCliError('STORAGE_CORRUPT', '历史快照中的 state.json 已损坏，无法撤销。');
  }
}
