import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';
import { StorageCorruptError, PermissionError } from '../errors';
import { asWritePermissionError, atomicWriteFile } from '../system/atomic-write';

/**
 * 读取失败时尽量把"谁拥有、我以谁的身份读"写进错误信息。
 *
 * macOS 的 sudo 会保留 HOME，`sudo hostscli ...` 因此会把数据文件写成 root
 * 属主；之后普通用户读这些文件只会得到裸 EACCES（"没有读取权限"），看不出
 * 原因是属主不一致，也不知道该执行什么命令修复。
 */
async function describeReadDenied(filePath: string): Promise<string> {
  const euid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  let details = `当前 euid=${euid}`;
  try {
    const info = await stat(filePath);
    details = `属主 uid=${info.uid} gid=${info.gid}，当前 euid=${euid}`;
  } catch {
    // 文件可能已被删除，只报当前身份。
  }
  return (
    `没有读取权限：${filePath}（${details}）。` +
    `若属主与 euid 不一致（常见于 sudo 运行留下的 root 属主），执行：` +
    `sudo chown -R ${euid}:${gid} ${dirname(filePath)}；否则请检查文件权限位。`
  );
}

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
      throw new PermissionError(filePath, await describeReadDenied(filePath));
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
