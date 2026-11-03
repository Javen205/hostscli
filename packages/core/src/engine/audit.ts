import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InvalidInputError } from '../errors';

export type AuditAction = 'verify-ok' | 'verify-rollback' | 'write-rollback' | 'verify-error';

export interface AuditFailure {
  hostname: string;
  expected: string;
  actual: string[];
  error?: string;
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
}

const MAX_DETAIL_LENGTH = 500;

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_LENGTH ? value : `${value.slice(0, MAX_DETAIL_LENGTH)}…`;
}

/**
 * 追加审计日志（JSONL，0600）。只记录主机名/IP 与结果，不写文件内容、URL 或凭据。
 * 审计失败不应阻断主流程，调用方需要自行吞掉异常。
 */
export async function appendAudit(path: string, entry: AuditEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record: AuditEntry = {
    ...entry,
    ...(entry.detail !== undefined ? { detail: truncate(entry.detail) } : {}),
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** 读取最近 N 条审计记录；损坏的行会被跳过而不是整体失败。 */
export async function readAudit(path: string, limit = 20): Promise<AuditEntry[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new InvalidInputError('audit limit 必须是 1–1000 的整数。');
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const entries: AuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuditEntry;
      if (typeof parsed.at === 'string' && typeof parsed.action === 'string') entries.push(parsed);
    } catch {
      // 跳过损坏行。
    }
  }
  return entries.slice(-limit);
}
