import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { EntryNotFoundError, InvalidInputError, StorageCorruptError } from '../errors';
import { createEntryId, normalizeHostname } from '../hosts/models';
import type { HostEntry } from '../hosts/models';
import { parseHosts } from '../hosts/parser';
import { containsForbiddenText, validateEntryInput } from '../hosts/validation';
import { readJsonOrDefault, writeJsonFile } from '../storage/json';

/** 方案 ID 同时是文件名，必须限制字符集以防止目录穿越。 */
export const profileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, '方案 ID 只能包含字母、数字、点、下划线与短横线');

const profileHostnameSchema = z
  .string()
  .min(1)
  .refine((value) => !containsForbiddenText(value), '主机名不能包含换行或其他控制字符');

const profileCommentSchema = z
  .string()
  .refine((value) => !containsForbiddenText(value), '注释不能包含换行或其他控制字符');

export const profileEntrySchema = z.object({
  ip: z.string().min(1),
  hostnames: z.array(profileHostnameSchema).min(1),
  comment: profileCommentSchema.optional(),
  enabled: z.boolean().default(true),
  disabledReason: profileCommentSchema.optional(),
});

export type ProfileEntry = z.infer<typeof profileEntrySchema>;

export const profileSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: profileIdSchema,
    name: z.string().min(1),
    priority: z.number().int().default(0),
    entries: z.array(profileEntrySchema).default(() => []),
  })
  .passthrough();

export type Profile = z.infer<typeof profileSchema>;

export interface CreateProfileOptions {
  id: string;
  name?: string;
  priority?: number;
  entries?: ProfileEntry[];
}

export function assertProfileId(id: string): string {
  const result = profileIdSchema.safeParse(id);
  if (!result.success) {
    throw new InvalidInputError(result.error.issues[0]?.message ?? `无效的方案 ID：${id}`);
  }
  return id;
}

export function profilePath(profilesDir: string, id: string): string {
  return join(profilesDir, `${assertProfileId(id)}.json`);
}

/** 语义校验：IP/主机名字面量，且同一层内同名主机不能映射到不同 IP。 */
export function validateProfile(profile: Profile, filePath: string): Profile {
  const seen = new Map<string, string>();

  for (const [index, entry] of profile.entries.entries()) {
    const validated = validateEntryInput(entry);
    entry.ip = validated.ip;
    entry.hostnames = validated.hostnames;
    if (validated.comment !== undefined) entry.comment = validated.comment;
    else delete entry.comment;

    for (const hostname of entry.hostnames) {
      const key = normalizeHostname(hostname);
      const previousIp = seen.get(key);
      if (previousIp !== undefined && previousIp !== entry.ip) {
        throw new InvalidInputError(
          `同一条规则集内 ${hostname} 同时映射到 ${previousIp} 与 ${entry.ip}（第 ${index + 1} 个条目，${filePath}）`,
        );
      }
      seen.set(key, entry.ip);
    }
  }

  return profile;
}

/**
 * 内部可信写入只做唯一性校验：条目来自 readProfile 或 validateEntryInput，
 * 结构已合法；重复主机名映射仍需拦截，否则下次读取会报损坏。
 */
function assertUniqueHostnames(profile: Profile, filePath: string): void {
  const seen = new Map<string, string>();
  for (const [index, entry] of profile.entries.entries()) {
    for (const hostname of entry.hostnames) {
      const key = normalizeHostname(hostname);
      const previousIp = seen.get(key);
      if (previousIp !== undefined && previousIp !== entry.ip) {
        throw new InvalidInputError(
          `同一条规则集内 ${hostname} 同时映射到 ${previousIp} 与 ${entry.ip}（第 ${index + 1} 个条目，${filePath}）`,
        );
      }
      seen.set(key, entry.ip);
    }
  }
}

export async function readProfile(profilesDir: string, id: string): Promise<Profile> {
  const filePath = profilePath(profilesDir, id);
  const profile = await readJsonOrDefault(filePath, profileSchema, () => {
    throw new EntryNotFoundError(`方案不存在：${id}（${filePath}）`);
  });

  if (profile.id !== id) {
    throw new StorageCorruptError(filePath, `方案文件中的 id（${profile.id}）与文件名不一致`);
  }
  return validateProfile(profile, filePath);
}

export async function profileExists(profilesDir: string, id: string): Promise<boolean> {
  try {
    await readProfile(profilesDir, id);
    return true;
  } catch (error) {
    if (error instanceof EntryNotFoundError) return false;
    throw error;
  }
}

export async function listProfileIds(profilesDir: string): Promise<string[]> {
  const entries = await readdir(profilesDir).catch(() => [] as string[]);
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => profileIdSchema.safeParse(id).success)
    .sort();
}

export async function readProfiles(profilesDir: string): Promise<Profile[]> {
  const ids = await listProfileIds(profilesDir);
  return Promise.all(ids.map((id) => readProfile(profilesDir, id)));
}

export interface WriteProfileOptions {
  createOnly?: boolean;
  /**
   * 仅限 core 内部使用：调用方已持有经过读取校验或 validateEntryInput 的条目。
   * 跳过 zod 深解析与逐条正则校验，只保留重复主机名检查；
   * 外部输入（远程订阅、用户提供的规则文件）仍应走默认的严格校验。
   */
  trusted?: boolean;
}

/** 把方案 zod 校验失败翻译成 InvalidInput，避免 CLI 直接暴露 Zod 原文。 */
function parseProfileSchema(value: unknown, filePath: string): Profile {
  const result = profileSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new InvalidInputError(
      `方案 ${filePath} 的字段 ${issue?.path.join('.') || '(root)'} 不合法。`,
    );
  }
  return result.data;
}

export async function writeProfile(
  profilesDir: string,
  profile: Profile,
  options: WriteProfileOptions = {},
): Promise<Profile> {
  assertProfileId(profile.id);
  const filePath = profilePath(profilesDir, profile.id);
  const normalized = options.trusted
    ? (assertUniqueHostnames(profile, filePath), profile)
    : validateProfile(parseProfileSchema(profile, filePath), filePath);

  if (options.createOnly && (await profileExists(profilesDir, profile.id))) {
    throw new InvalidInputError(`方案已存在：${profile.id}`);
  }

  await mkdir(profilesDir, { recursive: true, mode: 0o700 });
  // profile 的条目数组可能上万条，紧凑 JSON 在写入热路径上明显更省 CPU。
  await writeJsonFile(filePath, normalized, { pretty: false });
  return normalized;
}

export async function createProfile(
  profilesDir: string,
  options: CreateProfileOptions,
): Promise<Profile> {
  const profile: Profile = {
    schemaVersion: 1,
    id: assertProfileId(options.id),
    name: options.name ?? options.id,
    priority: options.priority ?? 0,
    entries: options.entries ?? [],
  };
  return writeProfile(profilesDir, profile, { createOnly: true });
}

export async function deleteProfile(profilesDir: string, id: string): Promise<void> {
  const filePath = profilePath(profilesDir, id);
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new EntryNotFoundError(`方案不存在：${id}`);
    }
    throw error;
  }
}

export interface ProfileSource {
  id?: string;
  name?: string;
  priority?: number;
  entries: ProfileEntry[];
}

const profileSourceSchema = z
  .object({
    id: profileIdSchema.optional(),
    name: z.string().min(1).optional(),
    priority: z.number().int().optional(),
    entries: z.array(profileEntrySchema).min(1),
  })
  .passthrough();

/** 把 zod 校验失败翻译成面向用户的 InvalidInput 文案，不透出原始 Zod 文本。 */
function describeEntrySchemaError(error: z.ZodError, label: string): string {
  const issue = error.issues[0];
  const path = issue?.path ?? [];
  const entryIndex = typeof path[0] === 'number' ? path[0] + 1 : null;
  const field = path.find((segment): segment is string => typeof segment === 'string');

  if (entryIndex === null) {
    return `层文件 ${label} 的 entries 必须是非空数组。`;
  }
  if (field === undefined) {
    return `层文件 ${label} 第 ${entryIndex} 个条目必须是对象。`;
  }
  const reason =
    field === 'comment' || field === 'disabledReason'
      ? `${field} 必须是单行字符串，不能包含换行或其他控制字符`
      : field === 'hostnames'
        ? 'hostnames 必须是非空主机名数组，且不能包含换行或其他控制字符'
        : field === 'ip'
          ? 'ip 必须是非空字符串'
          : `${field} 字段不合法`;
  return `层文件 ${label} 第 ${entryIndex} 个条目的 ${reason}。`;
}

/**
 * 解析“层文件”：既接受方案 JSON（`{id,name,priority,entries}`），
 * 也接受纯 hosts 文本（每行 `IP hostname...`，`#` 注释忽略）。
 * 纯文本形式便于直接引用团队共享的 hosts 片段或远程订阅内容。
 *
 * 扩展点：以后若支持 YAML，只需在这里增加分支，后续校验与导入逻辑复用。
 */
export async function readProfileSource(filePath: string): Promise<ProfileSource> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new InvalidInputError(`无法读取层文件 ${filePath}（${code ?? '未知错误'}）。`);
  }
  return parseProfileSource(raw, filePath);
}

/** 从原始字节解析层内容；远程订阅复用同一实现，保证格式语义一致。 */
export function parseProfileSource(raw: Buffer, label: string): ProfileSource {
  const text = raw
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trim();
  if (text === '') throw new InvalidInputError(`层内容为空：${label}`);

  let entries: ProfileEntry[];
  let meta: Omit<ProfileSource, 'entries'> = {};

  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InvalidInputError(`层文件 JSON 语法错误：${label}`);
    }

    if (Array.isArray(parsed)) {
      const result = z.array(profileEntrySchema).min(1).safeParse(parsed);
      if (!result.success) {
        throw new InvalidInputError(describeEntrySchemaError(result.error, label));
      }
      entries = result.data;
    } else {
      const result = profileSourceSchema.safeParse(parsed);
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new InvalidInputError(
          `层文件 ${label} 的字段 ${issue?.path.join('.') || '(root)'} 不合法。`,
        );
      }
      entries = result.data.entries;
      meta = {
        ...(result.data.id !== undefined ? { id: result.data.id } : {}),
        ...(result.data.name !== undefined ? { name: result.data.name } : {}),
        ...(result.data.priority !== undefined ? { priority: result.data.priority } : {}),
      };
    }
  } else {
    const document = parseHosts(raw, { platformDefaultEol: '\n' });
    entries = document.entries
      .filter((entry) => entry.source === 'external')
      .map((entry) => ({
        ip: entry.ip,
        hostnames: entry.hostnames,
        enabled: true,
        ...(entry.comment ? { comment: entry.comment } : {}),
      }));
    if (entries.length === 0) {
      throw new InvalidInputError(`层内容里没有可用的 hosts 记录：${label}`);
    }
  }

  // 与方案文件同一套语义校验：IP/主机名合法、同层同名只能有一个 IP。
  const checked = validateProfile(
    {
      schemaVersion: 1,
      id: 'imported',
      name: 'imported',
      priority: 0,
      entries,
    },
    label,
  );

  return {
    ...meta,
    entries: checked.entries.map((entry) => {
      const value: ProfileEntry = {
        ip: entry.ip,
        hostnames: entry.hostnames,
        enabled: entry.enabled,
      };
      if (entry.comment) value.comment = entry.comment;
      if (entry.disabledReason) value.disabledReason = entry.disabledReason;
      return value;
    }),
  };
}

/** 由文件路径推导层 ID（去掉 `.json` / `.hosts` / `.txt` 后缀）。 */
export function profileIdFromPath(filePath: string): string {
  const name = basename(filePath).replace(/\.(json|hosts|txt)$/i, '');
  return name;
}

/** 把方案条目转换为统一的 HostEntry，供合并与列表使用。 */
export function profileEntriesToHostEntries(profile: Profile): HostEntry[] {
  return profile.entries.map((entry) => {
    const hostEntry: HostEntry = {
      id: createEntryId(profile.id, entry.ip, entry.hostnames),
      ip: entry.ip,
      hostnames: entry.hostnames,
      enabled: entry.enabled,
      layerId: profile.id,
      source: 'managed',
    };
    if (entry.comment) hostEntry.comment = entry.comment;
    return hostEntry;
  });
}
