import { promises as dns } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { EntryNotFoundError, InvalidInputError } from '../errors';
import type { HostsDocument } from '../hosts/models';
import { normalizeHostname } from '../hosts/models';
import type { Workspace, WorkspaceOptions } from '../engine/context';
import { loadHostsDocument, withWorkspace } from '../engine/context';
import { readDnsServers } from './dns-servers';
import type { DnsServerInfo } from './dns-servers';

export type DnsStatus = 'ok' | 'not-found' | 'error';

export interface DnsAnswers {
  a: string[];
  aaaa: string[];
  status: DnsStatus;
  error?: string;
}

export type DoctorVerdict =
  | 'hosts-effective'
  | 'not-effective'
  | 'indistinguishable'
  | 'normal'
  | 'nxdomain'
  | 'unreachable'
  | 'double-failure';

export interface DoctorRow {
  hostname: string;
  /** 托管区块里的期望 IP；空数组表示没有 hostscli 托管规则。 */
  expected: string[];
  systemDns: DnsAnswers;
  actual: DnsAnswers;
  verdict: DoctorVerdict;
  action: string;
  note?: string;
}

export interface DoctorSummary {
  total: number;
  effective: number;
  notEffective: number;
  indistinguishable: number;
  normal: number;
  nxdomain: number;
  unreachable: number;
  doubleFailure: number;
}

export interface DoctorReport {
  at: string;
  filePath: string;
  hostnames: string[];
  dnsServers: DnsServerInfo;
  rows: DoctorRow[];
  summary: DoctorSummary;
  exitCode: 0 | 5 | 6;
  warnings: string[];
}

export interface DoctorOptions extends WorkspaceOptions {
  /** 指定要诊断的域名；与 `all` 互斥。 */
  hostnames?: string[];
  /** 巡检托管区块里的全部域名。 */
  all?: boolean;
  /** 并发上限，默认 4。 */
  concurrency?: number;
  /** 单次查询超时，默认 3s。 */
  timeoutMs?: number;
}

export interface DoctorDeps {
  readServers?: () => Promise<DnsServerInfo>;
  querySystem?: (hostname: string, servers: string[], timeoutMs: number) => Promise<DnsAnswers>;
  lookupActual?: (hostname: string) => Promise<DnsAnswers>;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 3000;

function emptyAnswers(status: DnsStatus, error?: string): DnsAnswers {
  return {
    a: [],
    aaaa: [],
    status,
    ...(error !== undefined ? { error } : {}),
  };
}

function classifyDnsError(error: unknown): DnsStatus {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return 'not-found';
  return 'error';
}

function errorText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const message = (error as Error).message;
  return code ? `${code}: ${message}` : message;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} 查询超时（${timeoutMs}ms）`), { code: 'ETIMEOUT' }));
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

const defaultQuerySystem = async (
  hostname: string,
  servers: string[],
  timeoutMs: number,
): Promise<DnsAnswers> => {
  // c-ares（dns.resolve*）不读 /etc/hosts，这与 dns.lookup（getaddrinfo）形成三路对比。
  // 本机已实测：hosts 中自定义的 mysql/nacos 在 resolve4 下为 ENOTFOUND，
  // 而 lookup 返回 127.0.0.1（见 docs/stages/stage-3.md）。
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  if (servers.length > 0) resolver.setServers(servers);

  const [ipv4, ipv6] = await Promise.allSettled([
    withTimeout(resolver.resolve4(hostname), timeoutMs, 'A'),
    withTimeout(resolver.resolve6(hostname), timeoutMs, 'AAAA'),
  ]);

  const a = ipv4.status === 'fulfilled' ? unique(ipv4.value) : [];
  const aaaa = ipv6.status === 'fulfilled' ? unique(ipv6.value) : [];
  if (a.length > 0 || aaaa.length > 0) return { a, aaaa, status: 'ok' };

  const failures = [ipv4, ipv6].filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  const statuses = failures.map((failure) => classifyDnsError(failure.reason));
  if (statuses.every((status) => status === 'not-found')) {
    return emptyAnswers('not-found');
  }
  const firstFailure = failures.find((failure) => classifyDnsError(failure.reason) === 'error');
  return emptyAnswers('error', firstFailure ? errorText(firstFailure.reason) : 'DNS 查询失败');
};

const defaultLookupActual = async (hostname: string): Promise<DnsAnswers> => {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    const a = unique(
      records.filter((record) => record.family === 4).map((record) => record.address),
    );
    const aaaa = unique(
      records.filter((record) => record.family === 6).map((record) => record.address),
    );
    return { a, aaaa, status: 'ok' };
  } catch (error) {
    return emptyAnswers(classifyDnsError(error), errorText(error));
  }
};

function intersects(left: string[], right: string[]): boolean {
  return left.some((value) => right.includes(value));
}

/** 判定矩阵（方案 2.5），独立导出以便穷举单元测试。 */
export function judge(
  expected: string[],
  system: DnsAnswers,
  actual: DnsAnswers,
): { verdict: DoctorVerdict; action: string; note?: string } {
  const systemAddrs = [...system.a, ...system.aaaa];
  const actualAddrs = [...actual.a, ...actual.aaaa];

  if (expected.length > 0) {
    const actualHasRule = actual.status === 'ok' && intersects(expected, actualAddrs);
    if (actualHasRule) {
      if (system.status === 'ok' && intersects(expected, systemAddrs)) {
        return {
          verdict: 'indistinguishable',
          action: '结论不确定：DNS 与规则同值，建议换一个可观测域名验证。',
          note: '无法区分是 hosts 生效还是 DNS 本身返回同值。',
        };
      }
      const note =
        actual.aaaa.length > 0 && actual.aaaa[0] !== undefined && actual.a.length === 0
          ? '实际解析优先返回 IPv6（AAAA），部分应用可能走 IPv6。'
          : undefined;
      return {
        verdict: 'hosts-effective',
        action: '无需动作。',
        ...(note ? { note } : {}),
      };
    }

    if (actual.status !== 'ok' && system.status !== 'ok') {
      return {
        verdict: 'double-failure',
        action: '先检查 hosts 文件权限/格式，再检查网络与 DNS 服务器可达性。',
        note: `实际解析：${actual.status}${actual.error ? `（${actual.error}）` : ''}；系统 DNS：${system.status}${system.error ? `（${system.error}）` : ''}`,
      };
    }

    return {
      verdict: 'not-effective',
      action: '检查缓存/权限/格式，先运行 hostscli dns flush。',
      note: `托管规则为 ${expected.join(', ')}，实际解析为 ${actualAddrs.join(', ') || '无结果'}。`,
    };
  }

  if (actual.status === 'ok' && actualAddrs.length > 0) {
    return { verdict: 'normal', action: '无需动作（没有 hostscli 托管规则）。' };
  }
  if (actual.status === 'error' || system.status === 'error') {
    return {
      verdict: 'unreachable',
      action: '检查网络与 DNS 服务器可达性。',
      note: `${actual.error ?? system.error ?? 'DNS 查询失败'}`,
    };
  }
  return {
    verdict: 'nxdomain',
    action: '检查域名拼写与网络；DNS 侧没有该记录。',
  };
}

function summarize(rows: DoctorRow[]): DoctorSummary {
  const summary: DoctorSummary = {
    total: rows.length,
    effective: 0,
    notEffective: 0,
    indistinguishable: 0,
    normal: 0,
    nxdomain: 0,
    unreachable: 0,
    doubleFailure: 0,
  };
  for (const row of rows) {
    switch (row.verdict) {
      case 'hosts-effective':
        summary.effective += 1;
        break;
      case 'not-effective':
        summary.notEffective += 1;
        break;
      case 'indistinguishable':
        summary.indistinguishable += 1;
        break;
      case 'normal':
        summary.normal += 1;
        break;
      case 'nxdomain':
        summary.nxdomain += 1;
        break;
      case 'unreachable':
        summary.unreachable += 1;
        break;
      case 'double-failure':
        summary.doubleFailure += 1;
        break;
    }
  }
  return summary;
}

function exitCodeForRows(summary: DoctorSummary): 0 | 5 | 6 {
  if (summary.nxdomain > 0 || summary.unreachable > 0 || summary.doubleFailure > 0) return 6;
  if (summary.notEffective > 0) return 5;
  return 0;
}

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

function managedExpectations(document: HostsDocument): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of document.entries) {
    if (entry.source !== 'managed') continue;
    for (const hostname of entry.hostnames) {
      const key = normalizeHostname(hostname);
      const ips = map.get(key) ?? [];
      if (!ips.includes(entry.ip)) ips.push(entry.ip);
      map.set(key, ips);
    }
  }
  return map;
}

function externalHostnames(document: HostsDocument): Set<string> {
  const set = new Set<string>();
  for (const entry of document.entries) {
    if (entry.source !== 'external') continue;
    for (const hostname of entry.hostnames) set.add(normalizeHostname(hostname));
  }
  return set;
}

async function runDoctor(
  workspace: Workspace,
  options: DoctorOptions,
  deps: DoctorDeps,
): Promise<DoctorReport> {
  if (options.all && options.hostnames && options.hostnames.length > 0) {
    throw new InvalidInputError('--all 与显式域名不能同时使用。');
  }

  const loaded = await loadHostsDocument(workspace, false);
  const expectations = managedExpectations(loaded.document);
  const external = externalHostnames(loaded.document);

  let hostnames: string[];
  if (options.all) {
    hostnames = [...expectations.keys()].sort((a, b) => a.localeCompare(b));
  } else {
    hostnames = (options.hostnames ?? []).map(normalizeHostname);
    if (hostnames.length === 0) {
      throw new EntryNotFoundError('请指定至少一个域名，或使用 --all 巡检全部托管条目。');
    }
    hostnames = unique(hostnames).sort((a, b) => a.localeCompare(b));
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new InvalidInputError('并发上限必须是 1–32 的整数。');
  }

  const readServers = deps.readServers ?? (() => readDnsServers(workspace.platformId));
  const querySystem = deps.querySystem ?? defaultQuerySystem;
  const lookupActual = deps.lookupActual ?? defaultLookupActual;

  const dnsServers = await readServers();
  const warnings: string[] = [];
  if (dnsServers.warning) warnings.push(dnsServers.warning);

  const rows = await mapLimit(hostnames, concurrency, async (hostname) => {
    const [system, actual] = await Promise.all([
      querySystem(hostname, dnsServers.servers, timeoutMs).catch((error: unknown) =>
        emptyAnswers('error', errorText(error)),
      ),
      withTimeout(lookupActual(hostname), timeoutMs, 'getaddrinfo').catch((error: unknown) =>
        emptyAnswers('error', errorText(error)),
      ),
    ]);
    const expected = expectations.get(hostname) ?? [];
    const judged = judge(expected, system, actual);
    const notes: string[] = [];
    if (judged.note) notes.push(judged.note);
    if (expected.length === 0 && external.has(hostname) && actual.status === 'ok') {
      notes.push('该域名只出现在非托管行，结果来自用户手写或其他工具的 hosts 记录。');
    }
    return {
      hostname,
      expected,
      systemDns: system,
      actual,
      verdict: judged.verdict,
      action: judged.action,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    } satisfies DoctorRow;
  });

  const summary = summarize(rows);
  return {
    at: workspace.now.toISOString(),
    filePath: workspace.hostsPath,
    hostnames,
    dnsServers,
    rows,
    summary,
    exitCode: exitCodeForRows(summary),
    warnings,
  };
}

/**
 * 三路解析对比诊断（只读）：
 * 规则期望 = 托管区块；系统 DNS = c-ares 直连 DNS 服务器；实际解析 = getaddrinfo。
 */
export async function doctorHosts(
  options: DoctorOptions = {},
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  return withWorkspace(options, (workspace) => runDoctor(workspace, options, deps));
}
