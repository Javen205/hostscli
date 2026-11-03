export type HostsCliErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_ENCODING'
  | 'HOSTS_FORMAT'
  | 'PERMISSION'
  | 'DUPLICATE_ENTRY'
  | 'ENTRY_NOT_FOUND'
  | 'EXTERNAL_ENTRY'
  | 'VERIFICATION'
  | 'STORAGE_CORRUPT'
  | 'LOCKED'
  | 'CONFLICT'
  | 'NETWORK'
  | 'CANCELLED';

export interface HostsCliErrorOptions {
  cause?: unknown;
}

/** core 对外暴露的统一错误类型；退出码由 CLI 层映射。 */
export class HostsCliError extends Error {
  readonly code: HostsCliErrorCode;

  constructor(code: HostsCliErrorCode, message: string, options: HostsCliErrorOptions = {}) {
    super(message, options);
    this.name = 'HostsCliError';
    this.code = code;
  }
}

export class InvalidInputError extends HostsCliError {
  constructor(message: string) {
    super('INVALID_INPUT', message);
    this.name = 'InvalidInputError';
  }
}

export class UnsupportedPlatformError extends HostsCliError {
  constructor(platform: string) {
    super('UNSUPPORTED_PLATFORM', `不支持的平台：${platform}（当前支持 darwin / linux / win32）`);
    this.name = 'UnsupportedPlatformError';
  }
}

export class UnsupportedEncodingError extends HostsCliError {
  constructor(message: string) {
    super('UNSUPPORTED_ENCODING', message);
    this.name = 'UnsupportedEncodingError';
  }
}

export class HostsFormatError extends HostsCliError {
  constructor(message: string) {
    super('HOSTS_FORMAT', message);
    this.name = 'HostsFormatError';
  }
}

export class PermissionError extends HostsCliError {
  readonly path: string;

  constructor(path: string, message: string) {
    super('PERMISSION', message);
    this.name = 'PermissionError';
    this.path = path;
  }
}

export class DuplicateEntryError extends HostsCliError {
  constructor(message: string) {
    super('DUPLICATE_ENTRY', message);
    this.name = 'DuplicateEntryError';
  }
}

export class EntryNotFoundError extends HostsCliError {
  constructor(message: string) {
    super('ENTRY_NOT_FOUND', message);
    this.name = 'EntryNotFoundError';
  }
}

export class ExternalEntryError extends HostsCliError {
  constructor(message: string) {
    super('EXTERNAL_ENTRY', message);
    this.name = 'ExternalEntryError';
  }
}

export class VerificationError extends HostsCliError {
  constructor(message: string) {
    super('VERIFICATION', message);
    this.name = 'VerificationError';
  }
}

/** 配置文件 / 状态文件损坏，拒绝继续（不静默重建）。 */
export class StorageCorruptError extends HostsCliError {
  readonly path: string;

  constructor(path: string, message: string) {
    super('STORAGE_CORRUPT', `${message}（${path}）`);
    this.name = 'StorageCorruptError';
    this.path = path;
  }
}

/** 另一个实例正在操作同一份工作区。 */
export class LockedError extends HostsCliError {
  constructor(message: string) {
    super('LOCKED', message);
    this.name = 'LockedError';
  }
}

export interface ConflictCandidate {
  layerId: string;
  priority: number;
  ip: string;
  hostname: string;
}

/** 规则栈同优先级同名多 IP 冲突。 */
export class RuleConflictError extends HostsCliError {
  readonly candidates: ConflictCandidate[];

  constructor(hostname: string, candidates: ConflictCandidate[]) {
    const detail = candidates
      .map((candidate) => `${candidate.layerId}(priority ${candidate.priority}) -> ${candidate.ip}`)
      .join('；');
    super(
      'CONFLICT',
      `主机名 ${hostname} 在同一优先级存在多个 IP：${detail}。` +
        ' 可使用 --on-conflict first-wins / last-wins 明确裁决。',
    );
    this.name = 'RuleConflictError';
    this.candidates = candidates;
  }
}

/** 网络 / DNS 查询错误（doctor、远程订阅）。 */
export class NetworkError extends HostsCliError {
  constructor(message: string) {
    super('NETWORK', message);
    this.name = 'NetworkError';
  }
}

/** 用户取消确认（例如超过 7 天的 TTL）。 */
export class CancelledError extends HostsCliError {
  constructor(message: string) {
    super('CANCELLED', message);
    this.name = 'CancelledError';
  }
}
