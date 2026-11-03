import { InvalidInputError } from '../errors';

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export const MIN_TTL_MS = 60_000;
export const DEFAULT_TTL_WARN_MS = 7 * 86_400_000;

/**
 * 解析 `30m` / `2h` / `3d`（也接受 `1h30m` 这类组合）。
 * 方案规定最小 1 分钟；超过 7 天由调用方触发确认提示。
 */
export function parseDuration(input: string): number {
  const text = input.trim().toLowerCase();
  if (text === '') throw new InvalidInputError('时长不能为空，例如 30m / 2h / 3d。');

  const pattern = /(\d+)([smhd])/g;
  let total = 0;
  let matched = '';

  for (const match of text.matchAll(pattern)) {
    const amount = Number.parseInt(match[1] ?? '0', 10);
    const unit = match[2] ?? '';
    total += amount * (UNIT_MS[unit] ?? 0);
    matched += match[0];
  }

  if (matched !== text) {
    throw new InvalidInputError(
      `无效的时长：${input}。只支持 s/m/h/d 组合，例如 30m、2h、3d、1h30m。`,
    );
  }
  if (total < MIN_TTL_MS) {
    throw new InvalidInputError(`时长不能小于 1 分钟：${input}`);
  }
  return total;
}

export function parseDurationOrDefault(input: string | undefined, fallback: string): number {
  return parseDuration(input ?? fallback);
}

/** 人类可读的剩余时间，例如 `1h 47m`、`2d 3h`。 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0m';

  const days = Math.floor(ms / UNIT_MS.d!);
  const hours = Math.floor((ms % UNIT_MS.d!) / UNIT_MS.h!);
  const minutes = Math.floor((ms % UNIT_MS.h!) / UNIT_MS.m!);
  const seconds = Math.floor((ms % UNIT_MS.m!) / UNIT_MS.s!);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function isoAt(base: Date, offsetMs: number): string {
  return new Date(base.getTime() + offsetMs).toISOString();
}
