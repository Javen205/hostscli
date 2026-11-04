import { RuleConflictError } from '../errors';
import type { ConflictCandidate } from '../errors';
import { createEntryId, normalizeHostname } from '../hosts/models';
import type { HostEntry } from '../hosts/models';

/**
 * 冲突策略。
 * - `fail`：同优先级同名多 IP 直接失败（默认）。
 * - `highest-priority`：语义与默认一致（高优先级胜出，最高档仍有多 IP 时失败）。
 * - `first-wins` / `last-wins`：仅在最高优先级档存在多 IP 时按稳定顺序裁决。
 */
export type ConflictStrategy = 'fail' | 'highest-priority' | 'first-wins' | 'last-wins';

export interface LayerInput {
  id: string;
  priority: number;
  /** 已转换为 HostEntry；`enabled=false` 与 TTL 禁用的条目应在传入前排除。 */
  entries: HostEntry[];
  /** 同名优先级时的稳定顺序。 */
  order?: number;
}

export interface MergeOptions {
  onConflict?: ConflictStrategy;
}

export interface ExplainCandidate {
  layerId: string;
  priority: number;
  ip: string;
  hostname: string;
  selected: boolean;
  shadowed: boolean;
}

export interface MergeResult {
  /** 每条最终主机名一条记录（hostnames 长度为 1），按主机名字典序。 */
  entries: HostEntry[];
  /** 主机名 → 全部候选，供 `stack explain` 使用。 */
  candidates: Map<string, ExplainCandidate[]>;
}

interface Candidate {
  layerId: string;
  priority: number;
  order: number;
  ip: string;
  hostname: string;
  entry: HostEntry;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.order !== b.order) return a.order - b.order;
  return a.layerId.localeCompare(b.layerId);
}

function uniqueIps(candidates: Candidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.ip))];
}

function pickWinner(
  hostname: string,
  candidates: Candidate[],
  strategy: ConflictStrategy,
): Candidate {
  const ips = uniqueIps(candidates);
  if (ips.length === 1) {
    return [...candidates].sort(compareCandidates).at(-1) as Candidate;
  }

  const highestPriority = Math.max(...candidates.map((candidate) => candidate.priority));
  const highest = candidates.filter((candidate) => candidate.priority === highestPriority);

  if (uniqueIps(highest).length === 1) {
    return [...highest].sort(compareCandidates).at(-1) as Candidate;
  }

  // 同优先级同名多 IP：默认失败，不静默覆盖。
  if (strategy === 'first-wins') {
    return [...highest].sort(compareCandidates)[0] as Candidate;
  }
  if (strategy === 'last-wins') {
    return [...highest].sort(compareCandidates).at(-1) as Candidate;
  }

  const conflict: ConflictCandidate[] = highest.map((candidate) => ({
    layerId: candidate.layerId,
    priority: candidate.priority,
    ip: candidate.ip,
    hostname,
  }));
  throw new RuleConflictError(hostname, conflict);
}

interface Aggregated {
  byHostname: Map<string, Candidate[]>;
}

/**
 * 候选聚合。扩展点：新增匹配方式（通配、正则、CIDR）时，只需把这里的
 * “hostname 作为聚合键”扩展为“匹配键集合”，裁决与渲染逻辑保持不变。
 */
function aggregate(layers: LayerInput[]): Aggregated {
  const sorted = [...layers].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.order ?? 0) - (b.order ?? 0);
  });

  // 同层内同名多 IP 是规则集自身错误，直接失败（方案 2.4 第 3 条）。
  for (const layer of sorted) {
    const seen = new Map<string, string>();
    for (const entry of layer.entries) {
      if (!entry.enabled) continue;
      for (const hostname of entry.hostnames) {
        const key = normalizeHostname(hostname);
        const previous = seen.get(key);
        if (previous !== undefined && previous !== entry.ip) {
          throw new RuleConflictError(key, [
            { layerId: layer.id, priority: layer.priority, ip: previous, hostname: key },
            { layerId: layer.id, priority: layer.priority, ip: entry.ip, hostname: key },
          ]);
        }
        seen.set(key, entry.ip);
      }
    }
  }

  const byHostname = new Map<string, Candidate[]>();
  const orderByLayer = new Map(sorted.map((layer, index) => [layer.id, index]));

  for (const layer of sorted) {
    for (const entry of layer.entries) {
      if (!entry.enabled) continue;
      for (const hostname of entry.hostnames) {
        const key = normalizeHostname(hostname);
        const list = byHostname.get(key) ?? [];
        list.push({
          layerId: layer.id,
          priority: layer.priority,
          order: orderByLayer.get(layer.id) ?? 0,
          ip: entry.ip,
          hostname: key,
          entry,
        });
        byHostname.set(key, list);
      }
    }
  }

  return { byHostname };
}

function toExplainCandidates(list: Candidate[], winner: Candidate | null): ExplainCandidate[] {
  const unique = uniqueIps(list);
  return list.map((candidate) => ({
    layerId: candidate.layerId,
    priority: candidate.priority,
    ip: candidate.ip,
    hostname: candidate.hostname,
    selected: winner !== null && candidate === winner,
    shadowed: winner !== null && candidate !== winner && unique.length > 1,
  }));
}

export function mergeLayers(layers: LayerInput[], options: MergeOptions = {}): MergeResult {
  const strategy = options.onConflict ?? 'fail';
  const { byHostname } = aggregate(layers);

  const keys = [...byHostname.keys()].sort((a, b) => a.localeCompare(b));
  const entries: HostEntry[] = [];
  const candidates = new Map<string, ExplainCandidate[]>();

  for (const hostname of keys) {
    const list = byHostname.get(hostname) ?? [];
    const winner = pickWinner(hostname, list, strategy);

    entries.push({
      id: createEntryId(winner.layerId, winner.ip, [hostname]),
      ip: winner.ip,
      hostnames: [hostname],
      enabled: true,
      layerId: winner.layerId,
      source: 'managed',
      ...(winner.entry.comment ? { comment: winner.entry.comment } : {}),
    });

    candidates.set(hostname, toExplainCandidates(list, winner));
  }

  return { entries, candidates };
}

export interface ExplainResolution {
  hostname: string;
  candidates: ExplainCandidate[];
  /** 无法裁决时为 null（同优先级多 IP 冲突）。 */
  result: string | null;
  conflict: boolean;
}

/**
 * 只解释单个主机名的候选链，不渲染整份文件；供 `stack explain` 使用。
 * 与 `mergeLayers` 共享聚合与裁决实现，避免两套算法漂移。
 */
export function explainResolution(
  layers: LayerInput[],
  hostname: string,
  strategy: ConflictStrategy = 'fail',
): ExplainResolution {
  const key = normalizeHostname(hostname);
  const { byHostname } = aggregate(layers);
  const list = byHostname.get(key) ?? [];

  if (list.length === 0) {
    return { hostname: key, candidates: [], result: null, conflict: false };
  }

  try {
    const winner = pickWinner(key, list, strategy);
    return {
      hostname: key,
      candidates: toExplainCandidates(list, winner),
      result: winner.ip,
      conflict: false,
    };
  } catch (error) {
    if (!(error instanceof RuleConflictError)) throw error;
    return {
      hostname: key,
      candidates: toExplainCandidates(list, null),
      result: null,
      conflict: true,
    };
  }
}
