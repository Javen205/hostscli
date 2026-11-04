import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { MutationResult, WorkspaceOptions } from '@hostscli/core';

export interface CommonOptions {
  file?: string;
  dataDir?: string;
  json?: boolean;
  dryRun?: boolean;
  skipDnsFlush?: boolean;
  layer?: string;
  onConflict?: string;
  yes?: boolean;
  verify?: boolean;
}

export interface FileOption {
  file?: string;
}

export function addWorkspaceOptions(
  command: Command,
  extras: {
    json?: boolean;
    dryRun?: boolean;
    layer?: boolean;
    onConflict?: boolean;
    verify?: boolean;
  } = {},
): Command {
  command
    .option('--file <path>', '指定 hosts 文件路径（默认按平台解析）')
    .option('--data-dir <path>', '指定数据目录（默认 ~/.hostscli，可用 HOSSCLI_HOME 覆盖）')
    .option('--skip-dns-flush', '写回后不刷新 DNS 缓存');
  if (extras.json) command.option('--json', '以 JSON 输出（便于脚本消费）');
  if (extras.dryRun) command.option('--dry-run', '只输出 unified diff，不写文件');
  if (extras.layer) command.option('--layer <id>', '指定规则层（多层栈时必须）');
  if (extras.verify) {
    command.option(
      '--verify',
      '写入后抽查托管域名解析，失败自动回滚并记录 audit（也可用 defaults.verifyAfterApply 默认开启）',
    );
  }
  if (extras.onConflict) {
    command.option(
      '--on-conflict <strategy>',
      '同优先级冲突裁决：fail（默认）/ highest-priority / first-wins / last-wins',
      'fail',
    );
  }
  return command;
}

export function addDataDirOption(command: Command, extras: { json?: boolean } = {}): Command {
  command.option('--data-dir <path>', '指定数据目录（默认 ~/.hostscli，可用 HOSSCLI_HOME 覆盖）');
  if (extras.json) command.option('--json', '以 JSON 输出（便于脚本消费）');
  return command;
}

export function addFileOption(command: Command): Command {
  return command.option('--file <path>', '指定 hosts 文件路径（默认按平台解析）');
}

export function workspaceOptions(options: CommonOptions): WorkspaceOptions {
  return {
    ...(options.file !== undefined ? { filePath: options.file } : {}),
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.skipDnsFlush ? { dnsFlush: false } : {}),
    ...(options.verify ? { verify: true } : {}),
    onWarning: (message) => process.stderr.write(pc.yellow(`警告：${message}\n`)),
  };
}

export function conflictStrategy(
  options: CommonOptions,
): 'fail' | 'highest-priority' | 'first-wins' | 'last-wins' {
  const value = options.onConflict ?? 'fail';
  if (
    value === 'fail' ||
    value === 'highest-priority' ||
    value === 'first-wins' ||
    value === 'last-wins'
  ) {
    return value;
  }
  throw Object.assign(
    new Error(`未知冲突策略：${value}（可用 fail / highest-priority / first-wins / last-wins）`),
    { code: 'INVALID_INPUT' },
  );
}

/** 懒加载 core，避免 `--help` / `--version` 冷启动时加载解析与校验模块。 */
export async function resolveTargetPath(
  options: FileOption & { dataDir?: string },
): Promise<string> {
  if (options.file) return options.file;
  const [{ loadConfig }, { resolveDataPaths }, { resolveHostsPath }] = await Promise.all([
    import('@hostscli/core'),
    import('@hostscli/core/storage'),
    import('@hostscli/core/system'),
  ]);
  // 提示路径必须与真正写入的路径一致：config.hostsPath 优先于平台默认值。
  const paths = resolveDataPaths({ dataDir: options.dataDir });
  const config = await loadConfig(paths.configPath);
  return config.hostsPath ?? resolveHostsPath();
}

/**
 * commander 选项解析器：拒绝 NaN / 小数 / 带后缀的整数值。
 * 不能用 Number.parseInt：它会把 `12abc` 截成 12、把 `abc` 变成 NaN，
 * 调用方再按 NaN 做静默回退，用户就会以为参数已生效。
 */
export function parseIntOption(
  label: string,
  range: { min?: number; max?: number } = {},
): (value: string) => number {
  return (value: string): number => {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw Object.assign(new Error(`${label} 必须是整数，收到：${value}`), {
        code: 'INVALID_INPUT',
      });
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
      throw Object.assign(new Error(`${label} 超出安全整数范围，收到：${value}`), {
        code: 'INVALID_INPUT',
      });
    }
    const { min, max } = range;
    if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
      const bounds =
        min !== undefined && max !== undefined
          ? `${min}–${max}`
          : min !== undefined
            ? `不小于 ${min}`
            : `不大于 ${max}`;
      throw Object.assign(new Error(`${label} 必须在 ${bounds} 之间，收到：${value}`), {
        code: 'INVALID_INPUT',
      });
    }
    return parsed;
  };
}

/** commander 选项解析器：优先级为任意安全整数（可正可负）。 */
export function parsePriorityOption(value: string): number {
  return parseIntOption('--priority')(value);
}

/** commander 选项解析器：拒绝空名称（含纯空白）。 */
export function parseNameOption(value: string): string {
  if (value.trim() === '') {
    throw Object.assign(new Error('--name 不能为空。'), { code: 'INVALID_INPUT' });
  }
  return value;
}

export function warnSystemHosts(filePath: string, options: FileOption, action: string): void {
  if (options.file) return;
  process.stderr.write(
    pc.yellow(`提示：即将${action}系统 hosts 文件 ${filePath}，需要相应的写权限。\n`),
  );
}

export function printWarnings(warnings: string[] | undefined): void {
  for (const warning of warnings ?? []) {
    process.stderr.write(pc.yellow(`警告：${warning}\n`));
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function mutationPayload(result: MutationResult): Record<string, unknown> {
  return {
    changed: result.changed,
    backupPath: result.backupPath,
    planHash: result.planHash,
    affected: result.affected,
    diff: result.diff,
    dnsFlush: result.dnsFlush,
    warnings: result.warnings,
  };
}

export function printMutation(
  result: MutationResult,
  options: CommonOptions,
  messages: { success: string; unchanged: string },
): void {
  if (options.json) {
    printJson(mutationPayload(result));
    return;
  }

  if (!result.changed) {
    process.stdout.write(pc.dim(`${messages.unchanged}\n`));
  } else if (options.dryRun) {
    process.stdout.write(result.diff);
  } else {
    process.stdout.write(`${messages.success}\n`);
  }

  if (result.backupPath) process.stdout.write(pc.dim(`备份：${result.backupPath}\n`));
  printWarnings(result.warnings);
}

export async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    readline.close();
  }
}
