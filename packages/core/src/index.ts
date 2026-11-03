// hosts 文件无损模型
export {
  BEGIN_MARKER,
  DEFAULT_LAYER_ID,
  DISABLED_ENTRY_PREFIX,
  END_MARKER,
  createEntryId,
  hostEntrySchema,
  hostsDocumentSchema,
  normalizeHostname,
  rawLineSchema,
  ttlStateSchema,
} from './hosts/models';
export type { HostEntry, HostsDocument, RawLine, TtlState } from './hosts/models';

export { parseHosts } from './hosts/parser';
export type { ParseOptions } from './hosts/parser';

export { renderHosts } from './hosts/render';
export type { RenderOptions } from './hosts/render';

export { tokenize } from './hosts/tokenizer';
export type { TokenizeResult } from './hosts/tokenizer';

export { validateEntryInput } from './hosts/validation';
export type { EntryInput } from './hosts/validation';

// 错误与退出码语义
export {
  HostsCliError,
  DuplicateEntryError,
  EntryNotFoundError,
  ExternalEntryError,
  HostsFormatError,
  InvalidInputError,
  PermissionError,
  UnsupportedEncodingError,
  UnsupportedPlatformError,
  VerificationError,
  StorageCorruptError,
  LockedError,
  RuleConflictError,
  NetworkError,
  CancelledError,
} from './errors';
export type { HostsCliErrorCode, ConflictCandidate } from './errors';

// 备份底层能力
export {
  backupFile,
  defaultBackupDir,
  DEFAULT_BACKUP_KEEP,
  latestBackupFile,
  listBackupFiles,
} from './backup';
export type { BackupOptions } from './backup';

// 高层操作（唯一写 hosts 的入口）
export {
  addHosts,
  applyHosts,
  cancelTtl,
  createHostsBackup,
  createProfileFromCurrent,
  disableFor,
  extendTtl,
  initHosts,
  listHosts,
  listHostsBackups,
  listProfiles,
  listTtl,
  pauseTtl,
  reconcileTtls,
  removeHosts,
  removeProfile,
  restoreHostsBackup,
  restoreTtl,
  resumeTtl,
  saveProfileFromCurrent,
  setHostsEnabled,
  tickTtl,
  showConfig,
  showProfile,
  updateConfig,
  updateProfileMeta,
  useProfile,
  availableConfigKeys,
  listStackLayers,
  addStackLayer,
  setStackLayerEnabled,
  applyStack,
  explainStackHostname,
  listNetworkMappings,
  mapNetwork,
  unmapNetwork,
  networkStatus,
  networkAuto,
  assertGitRev,
  gitDiff,
  gitDirFor,
  gitInit,
  gitLog,
  gitRollback,
  gitSnapshot,
  gitStatusOf,
  exportSnapshot,
  snapshotToJson,
  appendAudit,
  readAudit,
  queryAudit,
  verifyAudit,
  showAudit,
  exportAudit,
  auditHealth,
  readAuditFailures,
  currentOperator,
  readHistory,
  verifyManagedEntries,
} from './operations';
export type {
  AddHostsOptions,
  AddStackLayerOptions,
  AddStackLayerResult,
  ApplyStackOptions,
  DisableForOptions,
  DueOptions,
  ExplainStackOptions,
  ExplainStackResult,
  ExternalMapping,
  HostsBackupOptions,
  HostsRestoreOptions,
  HostsSnapshot,
  InitOptions,
  ListOptions,
  MutationResult,
  ProfileCreateOptions,
  ProfileSaveOptions,
  ProfileUseOptions,
  ProfileView,
  RemoveHostsOptions,
  RestoreResult,
  SetEnabledOptions,
  SetStackLayerOptions,
  SetStackLayerResult,
  StackLayerView,
  StackListResult,
  TtlListResult,
  TtlMutationResult,
  TtlOptions,
  TtlView,
  WorkspaceOptions,
  MapNetworkOptions,
  NetworkAutoOptions,
  NetworkAutoResult,
  NetworkStatusResult,
  UnmapNetworkOptions,
  GitDiffOptions,
  GitLogEntry,
  GitRollbackOptions,
  GitRollbackResult,
  GitSnapshotOptions,
  GitSnapshotResult,
  GitStatusResult,
  ExportSnapshot,
  AuditAction,
  AuditEntry,
  AuditFailure,
  AuditQuery,
  AuditQueryResult,
  AuditRecord,
  AuditVerifyResult,
  AuditUnauditedRecord,
  ChangeEntry,
  ChangeSummary,
  HistoryFingerprint,
  HistoryRecord,
  HistorySnapshot,
  VerifyOptions,
  VerifyResult,
  VerifyFailure,
} from './operations';

// 存储与配置（扩展点：新增配置字段时改 configSchema，并在阶段文档记录）
export {
  configSchema,
  defaultConfig,
  loadConfig,
  saveConfig,
  remoteSourceSchema,
  configKeys,
  setConfigValue,
  getConfigValue,
} from './storage/config';
export type { HostsCliConfig, RemoteSource } from './storage/config';
export {
  stateSchema,
  defaultState,
  loadState,
  saveState,
  ttlRecordSchema,
  lastRenderSchema,
} from './storage/state';
export type { HostsCliState, TtlRecord, RenderSource, LastRender } from './storage/state';
export type { DataPaths, DataPathOptions } from './storage/paths';
export { resolveDataDir, resolveDataPaths } from './storage/paths';

// 方案 / 规则栈
export {
  createProfile,
  deleteProfile,
  listProfileIds,
  profileEntriesToHostEntries,
  profileIdFromPath,
  profileIdSchema,
  profilePath,
  profileSchema,
  profileEntrySchema,
  parseProfileSource,
  readProfileSource,
  readProfile,
  readProfiles,
  writeProfile,
  validateProfile,
} from './profiles/store';
export type { Profile, ProfileEntry, ProfileSource, CreateProfileOptions } from './profiles/store';
export { mergeLayers, explainResolution } from './stack/merge';
export type {
  ConflictStrategy,
  ExplainCandidate,
  ExplainResolution,
  LayerInput,
  MergeOptions,
  MergeResult,
} from './stack/merge';

// TTL
export {
  MIN_TTL_MS,
  DEFAULT_TTL_WARN_MS,
  formatRemaining,
  isoAt,
  parseDuration,
} from './ttl/duration';

// 系统能力
export { atomicWriteFile } from './system/atomic-write';
export type { AtomicWriteOptions } from './system/atomic-write';
export {
  createPlatformAdapter,
  currentPlatformId,
  defaultEolFor,
  resolveHostsPath,
} from './system/platform';
export type { PlatformAdapter, PlatformId } from './system/platform';
export { canWriteDirectly, permissionHint } from './system/privilege';
export { dnsFlushCommands, flushDns } from './system/dns-flush';
export type {
  CommandAttempt,
  CommandRunner,
  CommandSpec,
  DnsFlushResult,
} from './system/dns-flush';
export { lockPathFor, withFileLock } from './system/lock';
export type { LockOptions } from './system/lock';
export { DARWIN_HOSTS_PATH, resolveDarwinHostsPath } from './system/darwin';
export { LINUX_HOSTS_PATH, resolveLinuxHostsPath } from './system/linux';
export { resolveWin32HostsPath } from './system/win32';

// diff（dry-run 预览）
export { createUnifiedDiff } from './diff';
export type { UnifiedDiffOptions } from './diff';

// DNS 诊断（阶段 3）
export { doctorHosts, judge } from './diagnostics/doctor';
export type {
  DoctorDeps,
  DoctorOptions,
  DoctorReport,
  DoctorRow,
  DoctorSummary,
  DoctorVerdict,
  DnsAnswers,
  DnsStatus,
} from './diagnostics/doctor';
export {
  parsePowerShellAddresses,
  parseResolvConf,
  parseResolvectl,
  parseScutilDns,
  readDnsServers,
} from './diagnostics/dns-servers';
export type {
  CommandRunner as DiagnosticCommandRunner,
  DnsServerInfo,
  DnsServerSource,
} from './diagnostics/dns-servers';

// 远程订阅（阶段 3）
export {
  addRemoteSource,
  displayUrl,
  listRemoteSources,
  removeRemoteSource,
  updateRemoteSources,
} from './remote/service';
export type {
  AddRemoteOptions,
  RemoteUpdateResult,
  RemoteUpdateSummary,
  RemoteView,
  RemoveRemoteOptions,
  UpdateRemoteOptions,
} from './remote/service';

// 网络环境识别（阶段 4）：只读，测试通过 runner 注入
export { detectNetwork } from './network/detect';
export type {
  NetworkInfo,
  NetworkSource,
  CommandRunner as NetworkCommandRunner,
} from './network/detect';
export { parseAirportNetwork, parseNmcliWifi, parseWifiDevices } from './network/detect';
