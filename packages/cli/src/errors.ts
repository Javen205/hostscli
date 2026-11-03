import type { HostsCliErrorCode } from '@hostscli/core';

/**
 * 稳定退出码（对外契约）：
 * 0 成功；1 业务失败；2 用法/参数；3 规则冲突；4 权限；
 * 5 校验失败；6 网络/DNS；7 文件格式/编码/存储损坏；8 用户取消。
 */
export const EXIT_CODES: Record<HostsCliErrorCode, number> = {
  INVALID_INPUT: 2,
  UNSUPPORTED_PLATFORM: 2,
  UNSUPPORTED_ENCODING: 7,
  HOSTS_FORMAT: 7,
  PERMISSION: 4,
  DUPLICATE_ENTRY: 2,
  ENTRY_NOT_FOUND: 1,
  EXTERNAL_ENTRY: 1,
  VERIFICATION: 5,
  STORAGE_CORRUPT: 7,
  LOCKED: 1,
  CONFLICT: 3,
  NETWORK: 6,
  CANCELLED: 8,
};

/** 运行时按鸭子类型读取 code，避免为错误映射静态加载整个 core。 */
export function exitCodeFor(error: unknown): number {
  const code = (error as { code?: string } | null)?.code;
  if (code && code in EXIT_CODES) return EXIT_CODES[code as HostsCliErrorCode];
  return 1;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
