import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { normalizeHostname } from '../hosts/models';
import type { HostEntry } from '../hosts/models';

export interface VerifyFailure {
  hostname: string;
  expected: string;
  actual: string[];
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  skipped: number;
  failures: VerifyFailure[];
}

export interface VerifyLookupRecord {
  address: string;
  family: number;
}

export interface VerifyDeps {
  lookup?: (hostname: string) => Promise<VerifyLookupRecord[]>;
}

export interface VerifyOptions {
  maxHostnames: number;
  timeoutMs: number;
  concurrency?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} 超时（${timeoutMs}ms）`), { code: 'ETIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const defaultLookup = async (hostname: string): Promise<VerifyLookupRecord[]> => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
};

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * getaddrinfo 返回的 IPv6 是压缩形式（`2001:db8::1`），而用户在 hosts 中写的
 * 可能是未压缩形式（`2001:0db8:0000:...:0001`）。按字符串直接比较会把
 * 完全等价的两个地址判成“未生效”，进而触发自动回滚，因此先归一化。
 */
function normalizeAddress(value: string): string {
  const text = value.trim().toLowerCase();
  if (isIP(text) !== 6) return text;

  // 把内嵌的 IPv4（如 ::ffff:1.2.3.4）转成两个十六进制分组，便于统一展开。
  let expanded = text;
  const embedded = expanded.match(/^(.+?:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) {
    const octets = embedded[2]!.split('.').map((part) => Number(part));
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    expanded = `${embedded[1]}${high}:${low}`;
  }

  const parts = expanded.split('::');
  const compressed = parts.length === 2;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = compressed && parts[1] ? parts[1].split(':') : [];
  const missing = compressed ? Math.max(0, 8 - left.length - right.length) : 0;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  return groups.map((group) => parseInt(group || '0', 16).toString(16)).join(':');
}

/**
 * 写入后用 getaddrinfo 复核托管域名是否真的解析到规则 IP。
 * 失败不代表 hosts 一定没生效（DNS 缓存可能滞后），因此默认关闭，由 `--verify`
 * 或 `defaults.verifyAfterApply` 显式启用；失败时 commit 会回滚并写 audit。
 */
export async function verifyManagedEntries(
  entries: HostEntry[],
  options: VerifyOptions,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const expected = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.enabled || entry.source !== 'managed') continue;
    for (const hostname of entry.hostnames) {
      const key = normalizeHostname(hostname);
      if (!expected.has(key)) expected.set(key, entry.ip);
    }
  }

  const all = [...expected.keys()];
  const selected = all.slice(0, Math.min(options.maxHostnames, all.length));
  const skipped = all.length - selected.length;
  const lookup = deps.lookup ?? defaultLookup;

  const failures = await mapLimit(
    selected,
    options.concurrency ?? 4,
    async (hostname): Promise<VerifyFailure | null> => {
      const want = expected.get(hostname) as string;
      try {
        const records = await withTimeout(lookup(hostname), options.timeoutMs, 'getaddrinfo');
        const actual = [...new Set(records.map((record) => record.address))];
        const wantNormalized = normalizeAddress(want);
        if (actual.some((address) => normalizeAddress(address) === wantNormalized)) return null;
        return { hostname, expected: want, actual };
      } catch (error) {
        return {
          hostname,
          expected: want,
          actual: [],
          error: (error as Error).message,
        };
      }
    },
  );

  const failureList = failures.filter((failure): failure is VerifyFailure => failure !== null);
  return {
    ok: failureList.length === 0,
    checked: selected.length,
    skipped,
    failures: failureList,
  };
}
