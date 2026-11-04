import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from './atomic-write';

export type RuntimeLogLevel = 'info' | 'warn' | 'error';

export interface RuntimeLogEntry {
  at: string;
  level: RuntimeLogLevel;
  /** 产生日志的命令名（来自 HOSTSCLI_COMMAND 或调用方显式传入）。 */
  command: string;
  args?: string[];
  /** 事件名（write-ok / rollback / audit-failure / run-start / export）。 */
  event: string;
  detail?: string;
}

/** 运行日志与审计分离：审计记录写操作事实，运行日志只用于排障。 */
export function runtimeLogPathFor(dataDir: string): string {
  return join(dataDir, 'logs', 'run.jsonl');
}

/**
 * 追加一条运行日志（JSONL，0600）。日志绝不能影响主流程：
 * 任何 IO 失败都吞掉并返回 false，调用方无需处理。
 *
 * `keep` > 0 时按行数轮转：只保留最近 keep 行。轮转用原子写，
 * 避免与另一个 CLI 进程的 append 交错产生半行。
 */
export async function appendRuntimeLog(
  dataDir: string,
  entry: RuntimeLogEntry,
  options: { keep?: number } = {},
): Promise<boolean> {
  try {
    const path = runtimeLogPathFor(dataDir);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    // Windows 上 chmod 语义与 POSIX 不同；失败不影响日志内容。
    await chmod(path, 0o600).catch(() => undefined);

    const keep = options.keep ?? 500;
    if (keep <= 0) return true;
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    if (lines.length <= keep) return true;
    await atomicWriteFile(path, Buffer.from(`${lines.slice(-keep).join('\n')}\n`), {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}
