import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { InvalidInputError } from '../errors';
import type { ChangeSummary } from './history';
import { atomicWriteFile } from '../system/atomic-write';

export type AuditAction =
  | 'verify-ok'
  | 'verify-rollback'
  | 'write-rollback'
  | 'verify-error'
  | 'write-ok'
  | 'undo-ok'
  | 'run-start'
  | 'run-cleanup'
  | 'run-gc';

export interface AuditFailure {
  hostname: string;
  expected: string;
  actual: string[];
  error?: string;
}

export interface AuditOperator {
  uid: number | null;
  username: string | null;
}

export interface AuditEntry {
  at: string;
  action: AuditAction;
  ok: boolean;
  hostsPath: string;
  planHash?: string;
  checked?: number;
  failures?: AuditFailure[];
  detail?: string;
  /** 产生本次写入的命令与关键参数。 */
  command?: string;
  commandArgs?: string[];
  operator?: AuditOperator;
  beforeSha256?: string | null;
  afterSha256?: string | null;
  /** 条目级变更摘要（新增 / 删除 / 禁用 / 恢复）。 */
  summary?: ChangeSummary;
  changed?: boolean;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  seq: number | null;
  prevHash: string | null;
  recordHash: string | null;
  onChain: boolean;
  legacy: boolean;
}

export interface AuditChainState {
  seq: number;
  lastHash: string;
  baseHash: string;
  rotatedAt?: string;
}

const GENESIS = 'GENESIS';
const MAX_DETAIL_LENGTH = 500;
const MAX_LIMIT = 1000;

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_LENGTH ? value : `${value.slice(0, MAX_DETAIL_LENGTH)}…`;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function chainPathFor(auditPath: string): string {
  return `${auditPath}.chain.json`;
}

export function auditMissingPathFor(dataDir: string): string {
  return join(dataDir, 'audit-unaudited.jsonl');
}

/** 当前操作者：sudo 场景下同时记录调用者用户名，避免只看到 root。 */
export function currentOperator(): AuditOperator {
  let username: string | null;
  try {
    username = process.env.SUDO_USER ?? userInfo().username;
  } catch {
    username = process.env.SUDO_USER ?? null;
  }
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    username,
  };
}

interface ParsedAudit {
  records: AuditRecord[];
  invalidLines: number;
}

async function parseAuditFile(path: string): Promise<ParsedAudit> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], invalidLines: 0 };
    throw error;
  }

  const records: AuditRecord[] = [];
  let invalidLines = 0;
  let legacyIndex = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuditEntry & {
        id?: unknown;
        seq?: unknown;
        prevHash?: unknown;
        recordHash?: unknown;
      };
      if (typeof parsed.at !== 'string' || typeof parsed.action !== 'string') {
        invalidLines += 1;
        continue;
      }
      const onChain = typeof parsed.recordHash === 'string' && typeof parsed.prevHash === 'string';
      legacyIndex += onChain ? 0 : 1;
      records.push({
        ...parsed,
        id: typeof parsed.id === 'string' ? parsed.id : `legacy-${legacyIndex}`,
        seq: typeof parsed.seq === 'number' ? parsed.seq : null,
        prevHash: typeof parsed.prevHash === 'string' ? parsed.prevHash : null,
        recordHash: typeof parsed.recordHash === 'string' ? parsed.recordHash : null,
        onChain,
        legacy: !onChain,
      });
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

async function readChainState(path: string): Promise<AuditChainState | null> {
  try {
    const parsed = JSON.parse(
      await readFile(chainPathFor(path), 'utf8'),
    ) as Partial<AuditChainState>;
    if (
      typeof parsed.seq === 'number' &&
      typeof parsed.lastHash === 'string' &&
      typeof parsed.baseHash === 'string'
    ) {
      return {
        seq: parsed.seq,
        lastHash: parsed.lastHash,
        baseHash: parsed.baseHash,
        ...(typeof parsed.rotatedAt === 'string' ? { rotatedAt: parsed.rotatedAt } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeChainState(path: string, state: AuditChainState): Promise<void> {
  await mkdir(dirname(chainPathFor(path)), { recursive: true, mode: 0o700 });
  await atomicWriteFile(chainPathFor(path), Buffer.from(`${JSON.stringify(state)}\n`), {
    mode: 0o600,
  });
}

/**
 * 追加审计日志（JSONL，0600），并维护哈希链。
 *
 * 每条链上记录包含 `prevHash`（上一条记录的 recordHash）与 `recordHash`
 * （本条内容去掉 recordHash 后的 sha256）。旧格式记录（无哈希字段）保持可读，
 * 但 `onChain=false`，校验时如实标注，绝不伪造链完整性。
 */
export async function appendAudit(
  path: string,
  entry: AuditEntry,
  options: { keep?: number } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { records } = await parseAuditFile(path);
  const chained = records.filter((record) => record.onChain);
  const sidecar = await readChainState(path);
  const lastChained = chained.at(-1);
  const prevSeq = Math.max(sidecar?.seq ?? 0, lastChained?.seq ?? 0);
  const prevHash = lastChained?.recordHash ?? sidecar?.lastHash ?? GENESIS;
  const seq = prevSeq + 1;

  const base: Record<string, unknown> = {
    id: String(seq),
    seq,
    at: entry.at,
    action: entry.action,
    ok: entry.ok,
    hostsPath: entry.hostsPath,
  };
  if (entry.planHash !== undefined) base.planHash = entry.planHash;
  if (entry.command !== undefined) base.command = entry.command;
  if (entry.commandArgs !== undefined) base.commandArgs = entry.commandArgs;
  if (entry.operator !== undefined) base.operator = entry.operator;
  if (entry.beforeSha256 !== undefined) base.beforeSha256 = entry.beforeSha256;
  if (entry.afterSha256 !== undefined) base.afterSha256 = entry.afterSha256;
  if (entry.summary !== undefined) base.summary = entry.summary;
  if (entry.changed !== undefined) base.changed = entry.changed;
  if (entry.checked !== undefined) base.checked = entry.checked;
  if (entry.failures !== undefined) base.failures = entry.failures;
  if (entry.detail !== undefined) base.detail = truncate(entry.detail);
  base.prevHash = prevHash;

  const record = { ...base, recordHash: sha256(JSON.stringify(base)) };
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);

  const keep = options.keep ?? 0;
  if (keep > 0) {
    const all = await parseAuditFile(path);
    if (all.records.length > keep) {
      const kept = all.records.slice(all.records.length - keep);
      const text = kept.map((item) => `${JSON.stringify(item)}\n`).join('');
      await atomicWriteFile(path, Buffer.from(text), { mode: 0o600 });
      const firstKept = kept[0];
      const lastKept = kept.at(-1);
      await writeChainState(path, {
        seq: lastKept?.seq ?? 0,
        lastHash: lastKept?.recordHash ?? GENESIS,
        baseHash: firstKept?.prevHash ?? GENESIS,
        rotatedAt: entry.at,
      });
      return;
    }
  }

  await writeChainState(path, {
    seq,
    lastHash: record.recordHash,
    baseHash: sidecar?.baseHash ?? GENESIS,
  });
}

/** 兼容旧接口：读取最近 N 条记录（含链字段）。 */
export async function readAudit(path: string, limit = 20): Promise<AuditEntry[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidInputError('audit limit 必须是 1–1000 的整数。');
  }
  const { records } = await parseAuditFile(path);
  return records.slice(-limit);
}

export interface AuditQuery {
  since?: string;
  until?: string;
  /** 命令名精确匹配（例如 add / undo / run）。 */
  command?: string;
  result?: 'ok' | 'failed';
  limit?: number;
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidInputError(`${label} 必须是可解析的时间（例如 2026-11-01 或 ISO 8601）。`);
  }
  return parsed;
}

export interface AuditQueryResult {
  records: AuditRecord[];
  total: number;
  legacy: number;
  invalidLines: number;
  unaudited: AuditUnauditedRecord[];
}

export async function queryAudit(path: string, query: AuditQuery = {}): Promise<AuditQueryResult> {
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidInputError('audit limit 必须是 1–1000 的整数。');
  }
  const since = query.since !== undefined ? parseTime(query.since, '--since') : null;
  const until = query.until !== undefined ? parseTime(query.until, '--until') : null;
  if (since !== null && until !== null && since > until) {
    throw new InvalidInputError('--since 不能晚于 --until。');
  }

  const parsed = await parseAuditFile(path);
  const matched = parsed.records.filter((record) => {
    if (since !== null || until !== null) {
      const at = Date.parse(record.at);
      if (Number.isNaN(at)) return false;
      if (since !== null && at < since) return false;
      if (until !== null && at > until) return false;
    }
    if (query.command !== undefined && record.command !== query.command) return false;
    if (query.result === 'ok' && !record.ok) return false;
    if (query.result === 'failed' && record.ok) return false;
    return true;
  });

  return {
    records: matched.slice(-limit),
    total: parsed.records.length,
    legacy: parsed.records.filter((record) => record.legacy).length,
    invalidLines: parsed.invalidLines,
    unaudited: await readAuditFailures(dirname(path)),
  };
}

export interface AuditVerifyIssue {
  id: string;
  reason: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  auditPath: string;
  total: number;
  chained: number;
  legacy: number;
  issues: AuditVerifyIssue[];
  unaudited: AuditUnauditedRecord[];
  chain: {
    seq: number | null;
    lastHash: string | null;
    baseHash: string | null;
    /** 没有 sidecar 时无法校验"尾部是否被截断"。 */
    tailVerified: boolean;
  };
}

/**
 * 校验哈希链：
 * - 每条链上记录的内容哈希与 prevHash 是否一致；
 * - 最后一条与 sidecar 的 seq/lastHash 是否一致（检测尾部删除）；
 * - 旧格式记录不计入链，只统计数量。
 */
export async function verifyAudit(path: string): Promise<AuditVerifyResult> {
  const { records } = await parseAuditFile(path);
  const chained = records.filter((record) => record.onChain);
  const sidecar = await readChainState(path);
  const issues: AuditVerifyIssue[] = [];
  const baseHash = sidecar?.baseHash ?? chained[0]?.prevHash ?? null;
  let previousHash: string | null = null;

  for (const record of chained) {
    const base = { ...record };
    delete (base as Partial<AuditRecord>).recordHash;
    delete (base as Partial<AuditRecord>).onChain;
    delete (base as Partial<AuditRecord>).legacy;
    const expected = sha256(JSON.stringify(base));
    if (record.recordHash !== expected) {
      issues.push({ id: record.id, reason: '记录内容被修改（哈希不匹配）' });
    }
    if (previousHash === null) {
      if (sidecar !== null && record.prevHash !== sidecar.baseHash) {
        issues.push({ id: record.id, reason: '链头 prevHash 与 sidecar 不一致' });
      }
    } else if (record.prevHash !== previousHash) {
      issues.push({ id: record.id, reason: '与上一条记录不连续（可能被删除）' });
    }
    previousHash = record.recordHash;
  }

  const lastChained = chained.at(-1);
  if (sidecar !== null) {
    if (lastChained === undefined) {
      if (sidecar.seq > 0) {
        issues.push({
          id: 'chain',
          reason: `审计文件为空，但 sidecar 记录 seq=${sidecar.seq}（记录被删除）`,
        });
      }
    } else if (lastChained.seq !== sidecar.seq || lastChained.recordHash !== sidecar.lastHash) {
      issues.push({
        id: lastChained.id,
        reason: `尾部记录缺失或被截断（sidecar seq=${sidecar.seq}，实际 seq=${lastChained.seq ?? '?'}）`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    auditPath: path,
    total: records.length,
    chained: chained.length,
    legacy: records.length - chained.length,
    issues,
    unaudited: await readAuditFailures(dirname(path)),
    chain: {
      seq: lastChained?.seq ?? null,
      lastHash: lastChained?.recordHash ?? null,
      baseHash,
      tailVerified: sidecar !== null,
    },
  };
}

export async function showAudit(path: string, id: string): Promise<AuditRecord | null> {
  const { records } = await parseAuditFile(path);
  return records.find((record) => record.id === id) ?? null;
}

export async function exportAudit(
  path: string,
  format: 'json' | 'ndjson',
): Promise<{ content: string; count: number }> {
  const { records } = await parseAuditFile(path);
  if (format === 'ndjson') {
    return {
      content:
        records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
      count: records.length,
    };
  }
  return { content: `${JSON.stringify(records, null, 2)}\n`, count: records.length };
}

export interface AuditUnauditedRecord {
  at: string;
  command?: string;
  detail?: string;
}

/**
 * 审计写入失败时留下标记。标记本身也尽力而为：失败不能反过来阻断主操作，
 * 但 `audit verify` / `audit list` 会把它展示为"有操作未被审计"。
 */
export async function recordAuditFailure(
  dataDir: string,
  entry: AuditUnauditedRecord,
): Promise<void> {
  try {
    const path = auditMissingPathFor(dataDir);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  } catch {
    // 标记写入失败也只能放弃；主操作成功优先。
  }
}

export async function readAuditFailures(dataDir: string): Promise<AuditUnauditedRecord[]> {
  try {
    const raw = await readFile(auditMissingPathFor(dataDir), 'utf8');
    const records: AuditUnauditedRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AuditUnauditedRecord;
        if (typeof parsed.at === 'string') records.push(parsed);
      } catch {
        // 跳过损坏行。
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** 只读健康摘要，供 `audit list` 一并展示。 */
export async function auditHealth(path: string): Promise<{
  total: number;
  legacy: number;
  unaudited: AuditUnauditedRecord[];
  chainOk: boolean;
}> {
  const verification = await verifyAudit(path);
  return {
    total: verification.total,
    legacy: verification.legacy,
    unaudited: verification.unaudited,
    chainOk: verification.ok,
  };
}
