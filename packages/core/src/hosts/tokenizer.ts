import type { RawLine } from './models';
import { UnsupportedEncodingError } from '../errors';

export interface TokenizeResult {
  /** 文件是否以 UTF-8 BOM 开头。 */
  bom: boolean;
  /** 逐行切分结果，保留每行原始文本与行尾符。 */
  lines: RawLine[];
  /** 文件主流行尾符，用于新增行。 */
  eol: string;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function splitLines(text: string): RawLine[] {
  const lines: RawLine[] = [];
  const eolPattern = /\r\n|\n|\r/g;
  let lastIndex = 0;
  let index = 0;

  for (const match of text.matchAll(eolPattern)) {
    const matchIndex = match.index ?? 0;
    lines.push({
      text: text.slice(lastIndex, matchIndex),
      eol: match[0],
      index,
    });
    index += 1;
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < text.length) {
    lines.push({ text: text.slice(lastIndex), eol: '', index });
  }

  return lines;
}

function detectDominantEol(lines: RawLine[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (!line.eol) continue;
    counts.set(line.eol, (counts.get(line.eol) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [eol, count] of counts) {
    if (count > bestCount) {
      best = eol;
      bestCount = count;
    }
  }

  return best ?? fallback;
}

/**
 * 把原始字节切成保留行尾符的行。
 * 不做任何规范化；遇到无法无损处理的编码直接报错。
 */
export function tokenize(raw: Buffer, platformDefaultEol = '\n'): TokenizeResult {
  const hasUtf16Bom =
    raw.length >= 2 &&
    ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff));
  if (hasUtf16Bom) {
    throw new UnsupportedEncodingError(
      'hosts 文件是 UTF-16 编码，hostscli 不支持自动转换；请先将其另存为 UTF-8。',
    );
  }

  let bom = false;
  let body = raw;
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    bom = true;
    body = raw.subarray(UTF8_BOM.length);
  }

  if (body.includes(0)) {
    throw new UnsupportedEncodingError(
      'hosts 文件包含 NUL 字节，可能是 UTF-16/UTF-32 或二进制内容；hostscli 不支持自动转换。',
    );
  }

  const text = body.toString('utf8');
  if (text.includes('\uFFFD')) {
    throw new UnsupportedEncodingError(
      'hosts 文件包含无法按 UTF-8 解码的字节；hostscli 不会猜测编码，请先修复文件编码。',
    );
  }

  const lines = splitLines(text);
  return { bom, lines, eol: detectDominantEol(lines, platformDefaultEol) };
}

export { UTF8_BOM };
