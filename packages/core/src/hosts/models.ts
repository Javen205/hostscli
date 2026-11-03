import { z } from 'zod';

/** 托管区块的起始围栏（必须独占一行）。 */
export const BEGIN_MARKER = '# >>> hostscli managed (do not edit inside) >>>';

/** 托管区块的结束围栏（必须独占一行）。 */
export const END_MARKER = '# <<< hostscli managed <<<';

/** 托管区内被禁用条目的行前缀。 */
export const DISABLED_ENTRY_PREFIX = '# hostscli:disabled';

/** 阶段 1 只有单一托管层。 */
export const DEFAULT_LAYER_ID = 'default';

export const ttlStateSchema = z.object({
  disabledAt: z.string(),
  expiresAt: z.string(),
  reason: z.string().optional(),
  prevEnabled: z.boolean(),
  paused: z.boolean(),
  remainingMs: z.number().optional(),
  status: z.enum(['active', 'pending']),
  planHash: z.string(),
  /** 阶段 2 扩展：区分写回失败与托管区被外部修改。 */
  pendingReason: z.enum(['write-failed', 'external-modified']).optional(),
});

export type TtlState = z.infer<typeof ttlStateSchema>;

export const hostEntrySchema = z.object({
  /** 稳定 ID：层 ID + IP + hostname 集合的短哈希。 */
  id: z.string().min(1),
  /** IPv4 / IPv6 字面量，不做规范化。 */
  ip: z.string().min(1),
  hostnames: z.array(z.string().min(1)).min(1),
  comment: z.string().optional(),
  enabled: z.boolean(),
  layerId: z.string().min(1),
  source: z.enum(['managed', 'external']),
  ttl: ttlStateSchema.optional(),
  origin: z
    .object({
      raw: z.string(),
      line: z.number().int().nonnegative(),
    })
    .optional(),
});

export type HostEntry = z.infer<typeof hostEntrySchema>;

export const rawLineSchema = z.object({
  /** 不含行尾符的原始文本。 */
  text: z.string(),
  /** 原始行尾符：`\n`、`\r\n`、`\r` 或空字符串。 */
  eol: z.string(),
  index: z.number().int().nonnegative(),
});

export type RawLine = z.infer<typeof rawLineSchema>;

export const hostsDocumentSchema = z.object({
  rawLines: z.array(rawLineSchema),
  /** 文件主流行尾符，用于新增行。 */
  eol: z.string(),
  bom: z.boolean(),
  /**
   * 围栏之间内容行的闭区间。
   * 空区块时 `start > end`；没有围栏时为 `null`。
   */
  managedRange: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int(),
    })
    .nullable(),
  entries: z.array(hostEntrySchema),
});

export type HostsDocument = z.infer<typeof hostsDocumentSchema>;

/** hostname 归一化：小写并去掉一个末尾的点（DNS 语义）。 */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * 生成条目稳定 ID（16 位十六进制）。
 *
 * 这里用两路 FNV-1a 组合出 64 位摘要，而不是 sha256：解析 1k/5k/20k 行时，
 * `createEntryId` 在热路径上按行调用，crypto 哈希会成为主要耗时。
 * ID 仅用于进程内/状态文件里的条目识别，不是安全凭据；
 * 64 位在 20k 条目规模下的碰撞概率约 1e-11，远低于实际风险阈值。
 * 如需抗碰撞的对外标识，应另建 API 而不是修改这里（会破坏已有 TTL 记录的匹配）。
 */
export function createEntryId(layerId: string, ip: string, hostnames: string[]): string {
  // 绝大多数条目只有一个主机名，走单元素快速路径，避免 map/sort/join 的临时数组。
  const normalized =
    hostnames.length === 1
      ? normalizeHostname(hostnames[0]!)
      : hostnames.map(normalizeHostname).sort().join(',');
  const input = `${layerId}\u0000${ip}\u0000${normalized}`;

  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + index;
    h2 = Math.imul(h2, 0x85ebca6b);
  }

  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h2 ^= h2 >>> 15;
  h2 = Math.imul(h2, 0xc2b2ae35);
  h2 ^= h2 >>> 16;

  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}
