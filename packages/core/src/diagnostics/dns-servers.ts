import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DnsServerSource = 'scutil' | 'resolv-conf' | 'resolvectl' | 'powershell' | 'none';

export interface DnsServerInfo {
  servers: string[];
  source: DnsServerSource;
  warning?: string;
}

export interface CommandRunner {
  (command: string, args: string[]): Promise<string>;
}

const LOOPBACK_STUBS = new Set(['127.0.0.1', '127.0.0.53', '::1']);

/** 去掉 IPv6 的 zone id（`fe80::1%en0` → `fe80::1`），否则无法用于查询。 */
export function stripZone(address: string): string {
  const index = address.indexOf('%');
  return index === -1 ? address : address.slice(0, index);
}

function normalizeServers(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const address = stripZone(value.trim().replace(/^\[|\]$/g, ''));
    if (!address || isIP(address) === 0) continue;
    if (!result.includes(address)) result.push(address);
  }
  return result;
}

/** `scutil --dns` 输出里所有 `nameserver[N] : 1.2.3.4`。 */
export function parseScutilDns(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\S+)\s*$/gm)) {
    if (match[1]) values.push(match[1]);
  }
  return normalizeServers(values);
}

/** `/etc/resolv.conf` 的 `nameserver` 行。 */
export function parseResolvConf(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/^\s*nameserver\s+(\S+)/gm)) {
    if (match[1]) values.push(match[1]);
  }
  return normalizeServers(values);
}

/** `resolvectl status` 的 `DNS Servers:` / `Current DNS Server:` 行。 */
export function parseResolvectl(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/^\s*(?:DNS Servers|Current DNS Server)\s*:\s*(.+)$/gm)) {
    for (const part of (match[1] ?? '').split(/[\s,]+/)) {
      if (part) values.push(part);
    }
  }
  return normalizeServers(values);
}

/** PowerShell `Get-DnsClientServerAddress` 的逐行输出。 */
export function parsePowerShellAddresses(text: string): string[] {
  return normalizeServers(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .flatMap((line) => line.split(/[\s,]+/)),
  );
}

const defaultRunner: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

async function readResolvConf(): Promise<string[]> {
  try {
    return parseResolvConf(await readFile('/etc/resolv.conf', 'utf8'));
  } catch {
    return [];
  }
}

/**
 * 读取系统 DNS 服务器列表（只读）。按平台使用方案 2.5 指定的来源：
 * macOS `scutil --dns`、Linux `/etc/resolv.conf` + `resolvectl`、Windows PowerShell。
 *
 * 注意：这里只发现服务器，不修改任何系统 DNS 配置，也不做 DoH/DoT 探测。
 */
export async function readDnsServers(
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultRunner,
): Promise<DnsServerInfo> {
  try {
    switch (platform) {
      case 'darwin': {
        const servers = parseScutilDns(await runner('scutil', ['--dns']));
        return servers.length > 0
          ? { servers, source: 'scutil' }
          : { servers: [], source: 'none', warning: 'scutil --dns 未返回可用 nameserver。' };
      }
      case 'linux': {
        const fileServers = await readResolvConf();
        const nonStub = fileServers.filter((server) => !LOOPBACK_STUBS.has(server));
        if (nonStub.length > 0) return { servers: nonStub, source: 'resolv-conf' };

        // systemd-resolved 场景：/etc/resolv.conf 只有 127.0.0.53 桩地址。
        try {
          const status = parseResolvectl(await runner('resolvectl', ['status', '--no-pager']));
          const upstream = status.filter((server) => !LOOPBACK_STUBS.has(server));
          if (upstream.length > 0) return { servers: upstream, source: 'resolvectl' };
        } catch {
          // resolvectl 不存在时继续回退。
        }

        return fileServers.length > 0
          ? {
              servers: fileServers,
              source: 'resolv-conf',
              warning: '只发现本机 stub DNS（127.0.0.53），查询结果可能受 systemd-resolved 影响。',
            }
          : { servers: [], source: 'none', warning: '/etc/resolv.conf 中没有 nameserver。' };
      }
      case 'win32': {
        const output = await runner('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-DnsClientServerAddress | Select-Object -ExpandProperty ServerAddresses)',
        ]);
        const servers = parsePowerShellAddresses(output);
        return servers.length > 0
          ? { servers, source: 'powershell' }
          : { servers: [], source: 'none', warning: 'PowerShell 未返回 DNS 服务器地址。' };
      }
      default:
        return { servers: [], source: 'none', warning: `不支持的平台：${platform}` };
    }
  } catch (error) {
    return {
      servers: [],
      source: 'none',
      warning: `读取系统 DNS 服务器失败：${(error as Error).message}`,
    };
  }
}
