import { promises as dns } from 'node:dns';
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
        if (actual.includes(want)) return null;
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
