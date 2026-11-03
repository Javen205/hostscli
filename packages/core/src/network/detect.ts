import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type NetworkSource = 'networksetup' | 'iwgetid' | 'nmcli' | 'unsupported';

export interface NetworkInfo {
  supported: boolean;
  ssid: string | null;
  platform: NodeJS.Platform;
  source: NetworkSource;
  detail?: string;
}

export interface CommandRunner {
  (command: string, args: string[]): Promise<string>;
}

const defaultRunner: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

/** 从 `networksetup -listallhardwareports` 提取 Wi-Fi 设备名（en0 / en1）。 */
export function parseWifiDevices(text: string): string[] {
  const devices: string[] = [];
  let isWifi = false;
  for (const line of text.split(/\r?\n/)) {
    const port = line.match(/Hardware Port:\s*(.+)$/);
    if (port) {
      isWifi = /Wi-?Fi|AirPort/i.test(port[1] ?? '');
      continue;
    }
    if (!isWifi) continue;
    const device = line.match(/Device:\s*(\S+)/);
    if (device?.[1]) {
      devices.push(device[1]);
      isWifi = false;
    }
  }
  return devices;
}

/** `networksetup -getairportnetwork en0` 的输出。 */
export function parseAirportNetwork(text: string): string | null {
  const match = text.match(/Current (?:Wi-Fi|AirPort) Network:\s*(.+)$/m);
  const ssid = match?.[1]?.trim();
  if (!ssid || /not associated/i.test(ssid)) return null;
  return ssid;
}

/** nmcli 用 `\:` 转义 SSID 中的冒号，这里按未转义冒号切分。 */
function splitNmcliLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\' && index + 1 < line.length) {
      current += line[index + 1];
      index += 1;
    } else if (char === ':') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** `nmcli -t -f ACTIVE,SSID dev wifi` 的 `yes:SSID` 行。 */
export function parseNmcliWifi(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const [active, ...rest] = splitNmcliLine(line);
    const ssid = rest.join(':').trim();
    if (active === 'yes' && ssid) return ssid;
  }
  return null;
}

async function detectMac(runner: CommandRunner): Promise<NetworkInfo> {
  let devices: string[] = [];
  try {
    devices = parseWifiDevices(await runner('networksetup', ['-listallhardwareports']));
  } catch {
    // 退回到常见设备名。
  }
  if (devices.length === 0) devices = ['en0'];

  let detail: string | undefined;
  for (const device of devices) {
    try {
      const ssid = parseAirportNetwork(
        await runner('networksetup', ['-getairportnetwork', device]),
      );
      if (ssid) return { supported: true, ssid, platform: 'darwin', source: 'networksetup' };
      detail = `设备 ${device} 未连接 Wi-Fi。`;
    } catch (error) {
      detail = `读取 ${device} 失败：${(error as Error).message}`;
    }
  }
  return {
    supported: true,
    ssid: null,
    platform: 'darwin',
    source: 'networksetup',
    ...(detail ? { detail } : {}),
  };
}

async function detectLinux(runner: CommandRunner): Promise<NetworkInfo> {
  try {
    const ssid = (await runner('iwgetid', ['-r'])).trim();
    if (ssid) return { supported: true, ssid, platform: 'linux', source: 'iwgetid' };
  } catch {
    // iwgetid 不存在或没有无线网卡，继续尝试 nmcli。
  }

  try {
    const ssid = parseNmcliWifi(await runner('nmcli', ['-t', '-f', 'ACTIVE,SSID', 'dev', 'wifi']));
    if (ssid) return { supported: true, ssid, platform: 'linux', source: 'nmcli' };
    return {
      supported: true,
      ssid: null,
      platform: 'linux',
      source: 'nmcli',
      detail: 'nmcli 未报告活动 Wi-Fi。',
    };
  } catch (error) {
    return {
      supported: false,
      ssid: null,
      platform: 'linux',
      source: 'unsupported',
      detail: `未找到 iwgetid / nmcli：${(error as Error).message}`,
    };
  }
}

/**
 * 识别当前 Wi-Fi 网络（只读）。macOS 用 networksetup，Linux 用 iwgetid/nmcli；
 * Windows 本阶段不支持，明确返回 unsupported，而不是猜测。
 */
export async function detectNetwork(
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultRunner,
): Promise<NetworkInfo> {
  switch (platform) {
    case 'darwin':
      return detectMac(runner);
    case 'linux':
      return detectLinux(runner);
    case 'win32':
      return {
        supported: false,
        ssid: null,
        platform: 'win32',
        source: 'unsupported',
        detail: 'Windows 暂不支持网络环境自动切换（方案阶段 4 只承诺 macOS/Linux）。',
      };
    default:
      return {
        supported: false,
        ssid: null,
        platform,
        source: 'unsupported',
        detail: `不支持的平台：${platform}`,
      };
  }
}
