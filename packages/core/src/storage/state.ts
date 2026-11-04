import { z } from 'zod';
import { readJsonOrDefault, writeJsonFile } from './json';

/**
 * TTL 记录。字段遵循方案 7.3；`pendingReason` 是阶段 2 为区分
 * "写回失败" 与 "托管区被外部修改" 增加的扩展字段（不改变原字段语义）。
 */
export const ttlRecordSchema = z.object({
  entryId: z.string().min(1),
  layerId: z.string().min(1),
  /** 条目的首个主机名，用于展示；完整主机名从 profile 读取。 */
  hostname: z.string().min(1),
  disabledAt: z.string(),
  expiresAt: z.string(),
  reason: z.string().optional(),
  prevEnabled: z.boolean(),
  paused: z.boolean(),
  remainingMs: z.number().nonnegative().optional(),
  status: z.enum(['active', 'pending']),
  planHash: z.string(),
  pendingReason: z.enum(['write-failed', 'external-modified']).optional(),
});

export type TtlRecord = z.infer<typeof ttlRecordSchema>;

/**
 * `run` 的会话租约。父进程被强杀时无法执行清理，记录会残留；
 * `run list` / `run gc` 依据 pid 是否存活回收。
 */
export const sessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  layerId: z.string().min(1),
  pid: z.number().int(),
  ip: z.string().min(1),
  hostnames: z.array(z.string().min(1)).min(1),
  command: z.array(z.string()).default(() => []),
  startedAt: z.string(),
  heartbeatAt: z.string(),
});

export type SessionRecord = z.infer<typeof sessionRecordSchema>;

/**
 * 上一次成功渲染的标记，只保留渲染时间与整文件哈希。
 *
 * 旧版本还持久化了一份按主机名逐条记录的 `sources` 映射，但全仓没有读取方：
 * `stack explain` 从当前规则与 hosts 现算候选链，`list` / `doctor` 也从当前
 * hosts 解析。这份副本只会随写入重写，100k 条时可达十余 MB，因此不再持久化。
 * 旧 state 里的 `sources` 会被 schema 丢弃，下次写入自然瘦身。
 */
export const lastRenderSchema = z.object({
  at: z.string(),
  planHash: z.string(),
});

export type LastRender = z.infer<typeof lastRenderSchema>;

export const stateSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** 当前启用的层（阶段 3 起支持多层）。 */
    activeLayers: z.array(z.string().min(1)).default(() => []),
    /**
     * 是否完成过一次"方案初始化"。
     * 为 false 且 activeLayers 为空时，把当前托管区块安全迁移为 default 方案；
     * 为 true 且为空表示用户主动停用了所有层，不能再自动复活方案。
     */
    initialized: z.boolean().default(false),
    ttl: z.array(ttlRecordSchema).default(() => []),
    lastRender: lastRenderSchema.optional(),
    /** `run` 会话租约；残留记录由 run gc 回收。 */
    sessions: z.array(sessionRecordSchema).default(() => []),
  })
  .passthrough();

export type HostsCliState = z.infer<typeof stateSchema>;

export function defaultState(): HostsCliState {
  return stateSchema.parse({});
}

export async function loadState(statePath: string): Promise<HostsCliState> {
  return readJsonOrDefault(statePath, stateSchema, () => defaultState());
}

export async function saveState(statePath: string, state: HostsCliState): Promise<void> {
  await writeJsonFile(statePath, stateSchema.parse(state));
}
