/**
 * core 的高层公共 API 入口。所有会写 hosts 的操作都在这里汇总，
 * 便于 CLI 只依赖这一个模块，也便于后续阶段在扩展点追加能力。
 */
export {
  listHosts,
  addHosts,
  removeHosts,
  setHostsEnabled,
  initHosts,
  applyHosts,
} from './engine/crud';
export {
  disableFor,
  listTtl,
  pauseTtl,
  resumeTtl,
  extendTtl,
  restoreTtl,
  cancelTtl,
  reconcileTtls,
  tickTtl,
} from './engine/ttl';
export {
  listProfiles,
  showProfile,
  createProfileFromCurrent,
  useProfile,
  removeProfile,
  saveProfileFromCurrent,
  updateProfileMeta,
  moveProfileEntry,
} from './engine/profiles';
export { createHostsBackup, listHostsBackups, restoreHostsBackup } from './engine/backup-service';
export { showConfig, updateConfig, availableConfigKeys } from './engine/config-service';
export {
  listStackLayers,
  addStackLayer,
  setStackLayerEnabled,
  applyStack,
  explainStackHostname,
} from './engine/stack';
export {
  listNetworkMappings,
  mapNetwork,
  unmapNetwork,
  networkStatus,
  networkAuto,
} from './engine/network';
export type {
  MapNetworkOptions,
  NetworkAutoOptions,
  NetworkAutoResult,
  NetworkStatusResult,
  UnmapNetworkOptions,
} from './engine/network';
export {
  assertGitRev,
  gitDiff,
  gitDirFor,
  gitInit,
  gitLog,
  gitRollback,
  gitSnapshot,
  gitStatusOf,
} from './engine/git';
export type {
  GitDiffOptions,
  GitLogEntry,
  GitRollbackOptions,
  GitRollbackResult,
  GitSnapshotOptions,
  GitSnapshotResult,
  GitStatusResult,
} from './engine/git';
export { exportSnapshot, snapshotToJson } from './engine/export';
export type { ExportSnapshot } from './engine/export';
export {
  appendAudit,
  readAudit,
  queryAudit,
  verifyAudit,
  showAudit,
  exportAudit,
  auditHealth,
  readAuditFailures,
  currentOperator,
} from './engine/audit';
export type {
  AuditAction,
  AuditEntry,
  AuditFailure,
  AuditQuery,
  AuditQueryResult,
  AuditRecord,
  AuditVerifyResult,
  AuditUnauditedRecord,
} from './engine/audit';
export { undoHosts, listUndoHistory } from './engine/undo';
export type { UndoOptions, UndoResult, UndoRecordView } from './engine/undo';
export type {
  ChangeEntry,
  ChangeSummary,
  HistoryFingerprint,
  HistoryRecord,
  HistorySnapshot,
} from './engine/history';
export { readHistory } from './engine/history';
export { startRun, finishRun, listRuns, gcRuns } from './engine/run';
export type {
  RunStartOptions,
  RunStartResult,
  RunFinishResult,
  RunListResult,
  RunGcResult,
  RunView,
} from './engine/run';
export { verifyManagedEntries } from './engine/verify';
export type { VerifyOptions, VerifyResult, VerifyFailure } from './engine/verify';
export type {
  AddStackLayerOptions,
  AddStackLayerResult,
  ApplyStackOptions,
  ExplainStackOptions,
  ExplainStackResult,
  StackLayerView,
  StackListResult,
  SetStackLayerOptions,
  SetStackLayerResult,
  ExternalMapping,
} from './engine/stack';
export type {
  AddHostsOptions,
  DisableForOptions,
  DueOptions,
  HostsSnapshot,
  InitOptions,
  ListOptions,
  MutationResult,
  ProfileCreateOptions,
  ProfileMoveOptions,
  ProfileMoveResult,
  ProfileSaveOptions,
  ProfileUseOptions,
  ProfileView,
  RemoveHostsOptions,
  SetEnabledOptions,
  TtlListResult,
  TtlMutationResult,
  TtlOptions,
  TtlView,
} from './engine/types';
export type {
  BackupOptions as HostsBackupOptions,
  RestoreOptions as HostsRestoreOptions,
  RestoreResult,
} from './engine/backup-service';
export type { WorkspaceOptions } from './engine/context';
