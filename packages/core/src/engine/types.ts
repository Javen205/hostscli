import type { HostEntry } from '../hosts/models';
import type { Profile, ProfileEntry } from '../profiles/store';
import type { DnsFlushResult } from '../system/dns-flush';
import type { ConflictStrategy } from '../stack/merge';
import type { TtlRecord } from '../storage/state';
import type { WorkspaceOptions } from './context';

export interface MutationResult {
  changed: boolean;
  backupPath: string | null;
  affected: HostEntry[];
  diff: string;
  planHash: string | null;
  dnsFlush?: DnsFlushResult;
  warnings: string[];
}

/** useProfile 额外告诉调用方"生效层是否真的切换了"，用于区分 no-op 与仅文件无变化。 */
export interface UseProfileResult extends MutationResult {
  switched: boolean;
}

export interface ListOptions extends WorkspaceOptions {
  onConflict?: ConflictStrategy;
  /**
   * 查看指定方案（可包含未生效方案）。与 `allProfiles` 互斥。
   * 未指定时沿用原行为：只列出生效层的条目 + 非托管条目。
   */
  profiles?: string[];
  /** 一次性查看全部方案（含未生效方案）。 */
  allProfiles?: boolean;
}

export interface HostsSnapshot {
  filePath: string;
  activeLayers: string[];
  entries: HostEntry[];
  summary: {
    managed: number;
    external: number;
    disabled: number;
    ttlDisabled: number;
  };
  warnings: string[];
  /** 仅方案视图（`profiles` / `allProfiles`）出现，说明本次展示的范围。 */
  view?: {
    mode: 'profiles' | 'all';
    /** 实际展示的方案 ID（按展示顺序）。 */
    profiles: string[];
    /**
     * 因方案视图语义而省略的非托管行数量。
     * 非托管行不属于任何方案，只在默认（生效）视图里展示。
     */
    omittedExternal: number;
  };
}

export interface AddHostsOptions extends WorkspaceOptions {
  ip: string;
  hostnames: string[];
  comment?: string;
  /** 指定写入哪个方案层；多层的栈必须显式指定。 */
  layerId?: string;
  onConflict?: ConflictStrategy;
}

export interface RemoveHostsOptions extends WorkspaceOptions {
  hostnames: string[];
  layerId?: string;
  onConflict?: ConflictStrategy;
}

export interface SetEnabledOptions extends WorkspaceOptions {
  hostnames: string[];
  enabled: boolean;
  /** 可选：限定层，避免多层同名歧义。 */
  layerId?: string;
  onConflict?: ConflictStrategy;
}

export interface DisableForOptions extends WorkspaceOptions {
  hostnames: string[];
  /** 时长语法，如 `2h`；提供时启用单条 TTL。 */
  for: string;
  reason?: string;
  layerId?: string;
  /** 超过 7 天时跳过确认。 */
  yes?: boolean;
  /** 非交互调用方（CI）在超过阈值时是否直接失败。 */
  nonInteractive?: boolean;
  onConflict?: ConflictStrategy;
}

export interface InitOptions extends WorkspaceOptions {
  onConflict?: ConflictStrategy;
}

export interface ProfileCreateOptions extends WorkspaceOptions {
  id: string;
  name?: string;
  priority?: number;
  /** 从当前托管区块导入条目。 */
  fromCurrent?: boolean;
}

export interface ProfileUseOptions extends WorkspaceOptions {
  id: string;
  onConflict?: ConflictStrategy;
}

export interface ProfileSaveOptions extends WorkspaceOptions {
  id: string;
  /** 显式删除当前被禁用 / 被 TTL 隐藏的条目；默认保留，避免静默丢数据。 */
  prune?: boolean;
}

export interface ProfileMoveOptions extends WorkspaceOptions {
  /** 要迁移的主机名；整条记录（含同条目的其他主机名）一起迁移。 */
  hostname: string;
  /** 源方案 ID。 */
  from: string;
  /** 目标方案 ID。 */
  to: string;
  /**
   * 目标方案已存在同名主机名时的策略：
   * - 默认 fail：报错并提示用 --force；
   * - --force：把冲突主机名从目标条目中移除（其他主机名保留），并指向迁移条目的 IP。
   */
  force?: boolean;
  onConflict?: ConflictStrategy;
}

export interface ProfileMoveResult extends MutationResult {
  from: string;
  to: string;
  hostname: string;
  movedIp: string;
  movedHostnames: string[];
  /** 随条目一起迁移的 TTL 记录数（条目 ID 随方案变化，必须同步改写）。 */
  ttlRecords: number;
  /** 被 --force 从目标方案中移除的主机名。 */
  replacedHostnames: string[];
  /** 目标方案是否处于生效状态；未生效时迁移不会改变 hosts。 */
  toActive: boolean;
}

export interface ProfileView {
  profile: Profile;
  active: boolean;
  entryCount: number;
}

export interface TtlView {
  record: TtlRecord;
  hostnames: string[];
  ip: string | null;
  remainingMs: number;
  profileFound: boolean;
}

export interface TtlListResult {
  now: string;
  records: TtlView[];
}

export interface TtlMutationResult {
  record: TtlRecord;
  changed: boolean;
}

export interface ReconcileResult {
  changed: boolean;
  restored: HighLevelTtlRecord[];
  warnings: string[];
}

export interface HighLevelTtlRecord {
  hostname: string;
  layerId: string;
}

export interface TtlOptions extends WorkspaceOptions {
  hostname: string;
  layerId?: string;
}

export interface TtlExtendOptions extends TtlOptions {
  duration: string;
}

export interface DueOptions extends WorkspaceOptions {
  within: string;
}

export type ProfileEntryInput = ProfileEntry;
