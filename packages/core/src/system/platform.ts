import { readFile } from 'node:fs/promises';
import { UnsupportedPlatformError } from '../errors';
import { atomicWriteFile } from './atomic-write';
import { resolveDarwinHostsPath } from './darwin';
import { resolveLinuxHostsPath } from './linux';
import { canWriteDirectly } from './privilege';
import { resolveWin32HostsPath } from './win32';

export type PlatformId = 'darwin' | 'linux' | 'win32';

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly hostsPath: string;
  /** 读取原始字节，不解析、不改行尾。 */
  readRaw(): Promise<Buffer>;
  /** 当前进程是否具备直接写入权限。 */
  canWriteDirectly(): Promise<boolean>;
  /** 原子写（调用方需已确认权限）。 */
  atomicWrite(content: Buffer): Promise<void>;
}

class BasePlatformAdapter implements PlatformAdapter {
  constructor(
    readonly id: PlatformId,
    readonly hostsPath: string,
  ) {}

  readRaw(): Promise<Buffer> {
    return readFile(this.hostsPath);
  }

  canWriteDirectly(): Promise<boolean> {
    return canWriteDirectly(this.hostsPath);
  }

  atomicWrite(content: Buffer): Promise<void> {
    return atomicWriteFile(this.hostsPath, content);
  }
}

/** 校验并返回当前平台标识；不支持时抛出。 */
export function currentPlatformId(platform: NodeJS.Platform = process.platform): PlatformId {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  throw new UnsupportedPlatformError(platform);
}

/** 按平台解析默认 hosts 文件路径。 */
export function resolveHostsPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  switch (platform) {
    case 'darwin':
      return resolveDarwinHostsPath();
    case 'linux':
      return resolveLinuxHostsPath();
    case 'win32':
      return resolveWin32HostsPath(env);
    default:
      throw new UnsupportedPlatformError(platform);
  }
}

/** 新建文件时使用的默认行尾符。 */
export function defaultEolFor(platform: PlatformId): string {
  return platform === 'win32' ? '\r\n' : '\n';
}

export function createPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PlatformAdapter {
  const hostsPath = resolveHostsPath(platform, env);
  const id = platform as PlatformId;
  return new BasePlatformAdapter(id, hostsPath);
}
