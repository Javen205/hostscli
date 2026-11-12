import { appendFile, chmod, mkdir, readFile, unlink } from 'node:fs/promises';
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
  | 'run-gc'
  | 'move-failed';

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
}

const MAX_DETAIL_LENGTH = 500;
const MAX_LIMIT = 1000;

/** 旧版本写下的哈希链字段；读取时忽略，保证历史记录继续可读。 */
const LEGACY_CHAIN_FIELDS = ['seq', 'prevHash', 'recordHash', 'baseHash', 'onChain'] as const;

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_LENGTH ? value : `${value.slice(0, MAX_DETAIL_LENGTH)}…`;
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

function stripLegacyFields(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  for (const field of LEGACY_CHAIN_FIELDS) delete copy[field];
  return copy;
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
  let missingIdIndex = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.at !== 'string' || typeof parsed.action !== 'string') {
        invalidLines += 1;
        continue;
      }
      const id =
        typeof parsed.id === 'string'
          ? parsed.id
          : ((missingIdIndex += 1), `legacy-${missingIdIndex}`);
      records.push({ ...stripLegacyFields(parsed), id } as AuditRecord);
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

function nextId(records: AuditRecord[]): string {
  let highest = 0;
  for (const record of records) {
    if (/^\d+$/.test(record.id)) {
      highest = Math.max(highest, Number(record.id));
    }
  }
  return String(highest + 1);
}

/**
 * 追加审计记录（append-only JSONL，0600）。
 *
 * 审计只保证"写入记录可读、可查询、按条数轮转"，不提供防篡改能力：
 * 任何能写 `dataDir` 的用户都能同样改写 `audit.log`，无密钥哈希链挡不住。
 * 因此这里不做链式计算，只维护单调递增的 `id` 与时间戳。
 */
export async function appendAudit(
  path: string,
  entry: AuditEntry,
  options: { keep?: number } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // 旧版本的链状态文件已无用途；首次写入时尽力删除，删除失败不影响审计。
  await unlink(chainPathFor(path)).catch(() => undefined);

  const { records } = await parseAuditFile(path);
  const record: Record<string, unknown> = {
    id: nextId(records),
    at: entry.at,
    action: entry.action,
    ok: entry.ok,
    hostsPath: entry.hostsPath,
  };
  if (entry.planHash !== undefined) record.planHash = entry.planHash;
  if (entry.command !== undefined) record.command = entry.command;
  if (entry.commandArgs !== undefined) record.commandArgs = entry.commandArgs;
  if (entry.operator !== undefined) record.operator = entry.operator;
  if (entry.beforeSha256 !== undefined) record.beforeSha256 = entry.beforeSha256;
  if (entry.afterSha256 !== undefined) record.afterSha256 = entry.afterSha256;
  if (entry.summary !== undefined) record.summary = entry.summary;
  if (entry.changed !== undefined) record.changed = entry.changed;
  if (entry.checked !== undefined) record.checked = entry.checked;
  if (entry.failures !== undefined) record.failures = entry.failures;
  if (entry.detail !== undefined) record.detail = truncate(entry.detail);

  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);

  const keep = options.keep ?? 0;
  if (keep > 0 && records.length + 1 > keep) {
    const kept = [...records, record as unknown as AuditRecord].slice(-keep);
    const text = kept.map((item) => `${JSON.stringify(item)}\n`).join('');
    await atomicWriteFile(path, Buffer.from(text), { mode: 0o600 });
  }
}

/** 兼容旧接口：读取最近 N 条记录。 */
export async function readAudit(path: string, limit = 20): Promise<AuditRecord[]> {
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
  invalidLines: number;
  issues: AuditVerifyIssue[];
  unaudited: AuditUnauditedRecord[];
}

/**
 * 一致性检查（不是篡改检测）：
 * - 文件可读、每行都可解析为合法记录；
 * - 时间戳单调不倒退；
 * - 数字 ID 单调递增（轮转后仍从保留记录继续）。
 *
 * 明确不检查：内容是否被同一用户改写、尾部是否被删除。审计仅提供写入记录，
 * 不承诺防篡改。
 */
export async function verifyAudit(path: string): Promise<AuditVerifyResult> {
  const { records, invalidLines } = await parseAuditFile(path);
  const issues: AuditVerifyIssue[] = [];
  if (invalidLines > 0) {
    issues.push({ id: 'format', reason: `有 ${invalidLines} 行不是合法的审计记录` });
  }

  let previousAt: number | null = null;
  let previousNumericId = 0;
  for (const record of records) {
    const at = Date.parse(record.at);
    if (Number.isNaN(at)) {
      issues.push({ id: record.id, reason: '时间戳不可解析' });
    } else if (previousAt !== null && at < previousAt) {
      issues.push({ id: record.id, reason: '时间戳早于上一条记录（记录顺序不单调）' });
    } else {
      previousAt = at;
    }

    if (/^\d+$/.test(record.id)) {
      const numericId = Number(record.id);
      if (numericId <= previousNumericId) {
        issues.push({ id: record.id, reason: '数字 ID 未递增（可能重复或轮转后错位）' });
      } else {
        previousNumericId = numericId;
      }
    }
  }

  return {
    ok: issues.length === 0,
    auditPath: path,
    total: records.length,
    invalidLines,
    issues,
    unaudited: await readAuditFailures(dirname(path)),
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
  invalidLines: number;
  unaudited: AuditUnauditedRecord[];
  ok: boolean;
}> {
  const verification = await verifyAudit(path);
  return {
    total: verification.total,
    invalidLines: verification.invalidLines,
    unaudited: verification.unaudited,
    ok: verification.ok,
  };
}
