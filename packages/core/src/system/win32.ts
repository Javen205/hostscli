import { win32 } from 'node:path';

export function resolveWin32HostsPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return win32.join(systemRoot, 'System32', 'drivers', 'etc', 'hosts');
}
