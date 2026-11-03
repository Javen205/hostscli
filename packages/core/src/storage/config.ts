import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { InvalidInputError } from '../errors';
import { profileIdSchema } from '../profiles/store';
import { parseDuration } from '../ttl/duration';
import { readJsonOrDefault, writeJsonFile } from './json';
import { assertSafeProfilesDir } from './paths';

/**
 * 远程订阅来源（阶段 3 使用）。放在 config 中是因为它是"用户配置"而不是运行态，
 * 缓存内容与 ETag 在 cache/remote 下。
 */
export const remoteSourceSchema = z.object({
  id: profileIdSchema,
  url: z.string().url(),
  enabled: z.boolean().default(true),
  /** 拉取后生成的 profile ID；默认与 id 相同。 */
  profileId: profileIdSchema.optional(),
  /** 首次生成方案时使用的名称与优先级。 */
  name: z.string().optional(),
  priority: z.number().int().optional(),
  lastUpdatedAt: z.string().optional(),
});
export type RemoteSource = z.infer<typeof remoteSourceSchema>;

const defaultsSchema = z
  .object({
    dnsFlush: z.boolean().default(true),
    backupKeep: z.number().int().min(0).max(1000).default(20),
    /** 超过该时长要求二次确认（`--yes` 跳过）。 */
    ttlWarnThreshold: z.string().default('7d'),
    /** 写入后是否用 getaddrinfo 复核托管域名；失败自动回滚并写 audit。 */
    verifyAfterApply: z.boolean().default(false),
    verifyMaxHostnames: z.number().int().min(1).max(100).default(8),
    verifyTimeoutMs: z.number().int().min(200).max(30_000).default(2000),
  })
  .default(() => ({
    dnsFlush: true,
    backupKeep: 20,
    ttlWarnThreshold: '7d',
    verifyAfterApply: false,
    verifyMaxHostnames: 8,
    verifyTimeoutMs: 2000,
  }));

const ttlConfigSchema = z
  .object({
    timerMode: z.enum(['lazy', 'tick', 'timer']).default('lazy'),
    tickInterval: z.string().default('1m'),
  })
  .default(() => ({ timerMode: 'lazy' as const, tickInterval: '1m' }));

const outputSchema = z
  .object({
    format: z.enum(['table', 'json']).default('table'),
    color: z.enum(['auto', 'always', 'never']).default('auto'),
  })
  .default(() => ({ format: 'table' as const, color: 'auto' as const }));

const remoteConfigSchema = z
  .object({
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024)
      .default(1_048_576),
    sources: z.array(remoteSourceSchema).default(() => []),
  })
  .default(() => ({ timeoutMs: 15_000, maxBytes: 1_048_576, sources: [] }));

export const networkMappingSchema = z.object({
  ssid: z.string().min(1),
  /** 切换后启用的层 ID（按数组顺序写入 activeLayers）。 */
  layers: z.array(profileIdSchema).default(() => []),
  name: z.string().optional(),
});
export type NetworkMapping = z.infer<typeof networkMappingSchema>;

const networkConfigSchema = z
  .object({
    /** SSID → 规则层映射；`network auto` 按当前网络应用。 */
    mappings: z.array(networkMappingSchema).default(() => []),
  })
  .default(() => ({ mappings: [] }));

export const configSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** null 表示按平台解析系统 hosts 路径。 */
    hostsPath: z.string().min(1).nullable().default(null),
    defaults: defaultsSchema,
    ttl: ttlConfigSchema,
    profilesDir: z.string().min(1).default('profiles'),
    output: outputSchema,
    remote: remoteConfigSchema,
    network: networkConfigSchema,
  })
  .passthrough();

export type HostsCliConfig = z.infer<typeof configSchema>;

export function defaultConfig(): HostsCliConfig {
  return configSchema.parse({});
}

export async function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostsCliConfig> {
  const fallback = () => defaultConfig();
  const config = await readJsonOrDefault(configPath, configSchema, fallback);

  if (config.hostsPath) {
    config.hostsPath = expandHome(config.hostsPath, env);
  }
  return config;
}

export interface ExpandHomeOptions {
  /** 路径分隔符语义；默认当前平台，测试可显式模拟。 */
  platform?: NodeJS.Platform;
  /** 家目录；默认依次取 env.HOME、env.USERPROFILE、os.homedir()。 */
  home?: string;
}

/**
 * 仅展开开头的 `~`；不做变量替换，避免把路径语义搞复杂。
 * 用目标平台的 path 实现重新拼接，避免在 Windows 上产生 `\` 与 `/` 混合的路径。
 */
export function expandHome(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ExpandHomeOptions = {},
): string {
  if (!input.startsWith('~')) return input;

  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const next = input[1];
  // 仅 `~` 自身或紧跟分隔符时才展开；`~foo` 这类用户目录语法不支持，原样返回。
  if (input.length > 1 && next !== '/' && !(isWindows && next === '\\')) return input;

  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const rest = input.slice(1).replace(/^[\\/]+/, '');
  if (rest === '') return home;

  const segments = rest.split(/[\\/]+/).filter((segment) => segment !== '');
  const pathImpl = isWindows ? win32 : posix;
  return pathImpl.join(home, ...segments);
}

export async function saveConfig(configPath: string, config: HostsCliConfig): Promise<void> {
  await writeJsonFile(configPath, configSchema.parse(config));
}

const BOOLEAN_KEYS = new Set(['defaults.dnsFlush', 'defaults.verifyAfterApply']);
const NUMBER_KEYS = new Set([
  'defaults.backupKeep',
  'defaults.verifyMaxHostnames',
  'defaults.verifyTimeoutMs',
  'remote.timeoutMs',
  'remote.maxBytes',
]);
const STRING_KEYS = new Set([
  'hostsPath',
  'profilesDir',
  'defaults.ttlWarnThreshold',
  'ttl.tickInterval',
]);
const ENUM_KEYS: Record<string, string[]> = {
  'ttl.timerMode': ['lazy', 'tick', 'timer'],
  'output.format': ['table', 'json'],
  'output.color': ['auto', 'always', 'never'],
};

export function configKeys(): string[] {
  return [...BOOLEAN_KEYS, ...NUMBER_KEYS, ...STRING_KEYS, ...Object.keys(ENUM_KEYS)].sort();
}

export function getConfigValue(config: HostsCliConfig, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (value !== null && typeof value === 'object') {
      return (value as Record<string, unknown>)[part];
    }
    return undefined;
  }, config);
}

export function setConfigValue(
  config: HostsCliConfig,
  key: string,
  rawValue: string,
): HostsCliConfig {
  const next = structuredClone(config) as HostsCliConfig;
  const path = key.split('.');

  const assign = (value: unknown): void => {
    let cursor = next as unknown as Record<string, unknown>;
    for (const part of path.slice(0, -1)) {
      const child = cursor[part];
      if (child === null || typeof child !== 'object') {
        throw new InvalidInputError(`配置项不存在：${key}`);
      }
      cursor = child as Record<string, unknown>;
    }
    cursor[path[path.length - 1] as string] = value;
  };

  if (BOOLEAN_KEYS.has(key)) {
    if (rawValue !== 'true' && rawValue !== 'false') {
      throw new InvalidInputError(`${key} 只接受 true / false。`);
    }
    assign(rawValue === 'true');
  } else if (NUMBER_KEYS.has(key)) {
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 0) {
      throw new InvalidInputError(`${key} 只接受非负整数。`);
    }
    assign(value);
  } else if (STRING_KEYS.has(key)) {
    if (rawValue === '' && key !== 'hostsPath') {
      throw new InvalidInputError(`${key} 不能为空。`);
    }
    if (key === 'defaults.ttlWarnThreshold' || key === 'ttl.tickInterval') {
      parseDuration(rawValue);
    }
    if (key === 'profilesDir') {
      assertSafeProfilesDir(rawValue);
    }
    assign(rawValue === '' ? null : rawValue);
  } else if (ENUM_KEYS[key]) {
    if (!ENUM_KEYS[key]?.includes(rawValue)) {
      throw new InvalidInputError(`${key} 只接受：${ENUM_KEYS[key]?.join(' / ')}。`);
    }
    assign(rawValue);
  } else {
    throw new InvalidInputError(`未知配置项：${key}。可用项：${configKeys().join(', ')}`);
  }

  return configSchema.parse(next);
}
