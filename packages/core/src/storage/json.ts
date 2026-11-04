import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';
import { StorageCorruptError, PermissionError } from '../errors';
import { asWritePermissionError, atomicWriteFile } from '../system/atomic-write';

/**
 * 读取并校验 JSON 文件。文件不存在时返回 `fallback`；存在但损坏时拒绝继续，
 * 绝不静默覆盖用户数据。
 */
export async function readJsonOrDefault<T>(
  filePath: string,
  schema: ZodType<T>,
  fallback: () => T,
  onRaw?: (value: unknown) => void,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new PermissionError(filePath, `没有读取权限：${filePath}`);
    }
    if (code === 'ENOENT') return fallback();
    throw new StorageCorruptError(filePath, `无法读取配置文件（${code ?? '未知错误'}）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageCorruptError(filePath, 'JSON 语法错误，请修复或删除该文件后重试');
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.join('.') || '(root)';
    throw new StorageCorruptError(
      filePath,
      `字段 ${location} 校验失败：${issue?.message ?? '未知错误'}`,
    );
  }

  onRaw?.(parsed);
  return result.data;
}

/**
 * 原子写 JSON（0600），目录 0700。
 *
 * `pretty: false` 用于 profile 这类条目数组可能很大的文件：内容仍是合法 JSON，
 * 但省掉 2 空格缩进带来的大量字符串拼接。config/state 保持人类可读的缩进格式。
 */
export async function writeJsonFile(
  filePath: string,
  value: unknown,
  options: { pretty?: boolean } = {},
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const text =
      options.pretty === false
        ? `${JSON.stringify(value)}\n`
        : `${JSON.stringify(value, null, 2)}\n`;
    await atomicWriteFile(filePath, Buffer.from(text, 'utf8'), { mode: 0o600 });
  } catch (error) {
    throw asWritePermissionError(filePath, error);
  }
}
