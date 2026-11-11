import { basename } from 'node:path';

const DEFAULT_NAME = 'hostscli';

/**
 * 允许按 `argv[1]` 自适应的命令名。只影响 usage 与提示文案，
 * 不参与数据目录、锁、状态文件、包名的解析——那些必须与命令名无关，
 * 否则用别名跑一次就会"找不到之前的配置"。
 */
const KNOWN_NAMES = new Set(['hostscli', 'hosts-cli']);

/** 从入口路径推导命令名；未知入口（如 `node dist/index.js`）回落到默认名。 */
export function binNameFrom(entryPath: string | undefined): string {
  if (!entryPath) return DEFAULT_NAME;
  const base = basename(entryPath).replace(/\.(?:c|m)?js$/i, '');
  return KNOWN_NAMES.has(base) ? base : DEFAULT_NAME;
}

/** 当前进程实际被调用的命令名（全局安装后的 bin 名或直接 node 入口）。 */
export function binName(): string {
  return binNameFrom(process.argv[1]);
}

export { DEFAULT_NAME as DEFAULT_BIN_NAME };
