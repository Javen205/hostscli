export interface UnifiedDiffOptions {
  labelFrom?: string;
  labelTo?: string;
  /** 防止超大文件在终端刷屏；超出部分以省略行表示。 */
  maxLines?: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 生成 unified diff。实现只把"公共前后缀之间"的改动合并成一个 hunk：
 * 对 hosts 形态（通常只改托管区块）足够准确，且不需要 O(N*M) 的 LCS。
 * 输出不含上下文行（0 context），便于 `--dry-run` 快速预览。
 */
export function createUnifiedDiff(
  previous: string,
  next: string,
  options: UnifiedDiffOptions = {},
): string {
  if (previous === next) return '';

  const before = splitLines(previous);
  const after = splitLines(next);
  const maxLines = options.maxLines ?? 4000;

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  if (removed.length === 0 && added.length === 0) return '';

  const fromLabel = options.labelFrom ?? 'before';
  const toLabel = options.labelTo ?? 'after';
  const startLine = prefix + 1;
  const lines = [
    `--- ${fromLabel}`,
    `+++ ${toLabel}`,
    `@@ -${startLine},${removed.length} +${startLine},${added.length} @@`,
  ];

  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept.push(`… 省略 ${lines.length - maxLines} 行 diff`);
    return `${kept.join('\n')}\n`;
  }

  return `${lines.join('\n')}\n`;
}
