import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlatformId } from './platform';

const execFileAsync = promisify(execFile);

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface CommandAttempt extends CommandSpec {
  ok: boolean;
  detail?: string;
}

export interface DnsFlushResult {
  ok: boolean;
  attempts: CommandAttempt[];
  detail?: string;
}

export type CommandRunner = (spec: CommandSpec) => Promise<void>;

async function defaultRunner(spec: CommandSpec): Promise<void> {
  await execFileAsync(spec.command, spec.args, {
    timeout: 5000,
    windowsHide: true,
  });
}

/**
 * 三平台 DNS 缓存刷新命令。只调用系统命令，不修改 DNS 配置。
 * macOS 需要两条命令；Linux 按发行版依次回退。
 */
export function dnsFlushCommands(platform: PlatformId): CommandSpec[][] {
  switch (platform) {
    case 'darwin':
      return [
        [{ command: 'dscacheutil', args: ['-flushcache'] }],
        [{ command: 'killall', args: ['-HUP', 'mDNSResponder'] }],
      ];
    case 'linux':
      return [
        [{ command: 'resolvectl', args: ['flush-caches'] }],
        [{ command: 'systemd-resolve', args: ['--flush-caches'] }],
        [{ command: 'nscd', args: ['-i', 'hosts'] }],
      ];
    case 'win32':
      return [[{ command: 'ipconfig', args: ['/flushdns'] }]];
  }
}

/**
 * 刷新 DNS 缓存。失败只返回结构化结果，绝不阻断已成功的 hosts 写入。
 * 测试通过 `runner` 注入，避免真的执行系统命令。
 */
export async function flushDns(
  platform: PlatformId,
  options: { runner?: CommandRunner } = {},
): Promise<DnsFlushResult> {
  const runner = options.runner ?? defaultRunner;
  const groups = dnsFlushCommands(platform);
  const attempts: CommandAttempt[] = [];

  // macOS 两组命令都要尝试；Linux 顺序回退，成功即停止。
  for (const group of groups) {
    let groupOk = false;
    for (const spec of group) {
      try {
        await runner(spec);
        attempts.push({ ...spec, ok: true });
        groupOk = true;
      } catch (error) {
        attempts.push({ ...spec, ok: false, detail: (error as Error).message });
      }
    }
    if (groupOk && platform === 'linux') break;
  }

  const ok = attempts.some((attempt) => attempt.ok);
  const failures = attempts.filter((attempt) => !attempt.ok);

  return {
    ok,
    attempts,
    detail: ok
      ? undefined
      : `DNS 缓存刷新失败：${failures.map((attempt) => attempt.command).join(', ') || '无可用命令'}`,
  };
}
