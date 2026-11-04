import { isIP } from 'node:net';
import {
  BEGIN_MARKER,
  DEFAULT_LAYER_ID,
  DISABLED_ENTRY_PREFIX,
  END_MARKER,
  createEntryId,
} from './models';
import type { HostEntry, HostsDocument, RawLine } from './models';
import { tokenize } from './tokenizer';
import { HostsFormatError } from '../errors';

export interface ParseOptions {
  layerId?: string;
  platformDefaultEol?: string;
}

interface FenceLocation {
  begin: number;
  end: number;
}

function locateFence(lines: RawLine[]): FenceLocation | null {
  const begins: number[] = [];
  const ends: number[] = [];

  for (const line of lines) {
    const text = line.text.trimEnd();
    if (text === BEGIN_MARKER) begins.push(line.index);
    if (text === END_MARKER) ends.push(line.index);
  }

  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1) {
    throw new HostsFormatError(
      `托管区块围栏必须恰好各出现一次（找到起始 ${begins.length} 个、结束 ${ends.length} 个）。`,
    );
  }

  const begin = begins[0];
  const end = ends[0];
  if (begin === undefined || end === undefined || end <= begin) {
    throw new HostsFormatError('托管区块围栏顺序损坏：结束围栏必须位于起始围栏之后。');
  }

  return { begin, end };
}

function parseEntryLine(
  lineText: string,
  lineIndex: number,
  layerId: string,
  source: HostEntry['source'],
  enabled: boolean,
): HostEntry | null {
  const commentIndex = lineText.indexOf('#');
  const content = commentIndex === -1 ? lineText : lineText.slice(0, commentIndex);
  const comment = commentIndex === -1 ? undefined : lineText.slice(commentIndex + 1).trim();
  const tokens = content.trim().split(/\s+/).filter(Boolean);

  if (tokens.length < 2) return null;

  const ip = tokens[0];
  if (!ip || isIP(ip) === 0) return null;

  const hostnames = tokens.slice(1);
  if (hostnames.length === 0) return null;

  const entry: HostEntry = {
    id: createEntryId(layerId, ip, hostnames),
    ip,
    hostnames,
    enabled,
    layerId,
    source,
  };

  if (comment) entry.comment = comment;
  if (source === 'external') entry.origin = { raw: lineText, line: lineIndex };

  return entry;
}

function parseManagedLine(text: string, lineIndex: number, layerId: string): HostEntry | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(DISABLED_ENTRY_PREFIX)) {
    const rest = trimmed.slice(DISABLED_ENTRY_PREFIX.length).trimStart();
    return parseEntryLine(rest, lineIndex, layerId, 'managed', false);
  }

  if (trimmed.startsWith('#')) return null;
  return parseEntryLine(text, lineIndex, layerId, 'managed', true);
}

function parseExternalLine(text: string, lineIndex: number, layerId: string): HostEntry | null {
  if (!text.trim() || text.trimStart().startsWith('#')) return null;
  return parseEntryLine(text, lineIndex, layerId, 'external', true);
}

export function parseHosts(raw: Buffer, options: ParseOptions = {}): HostsDocument {
  const layerId = options.layerId ?? DEFAULT_LAYER_ID;
  const { bom, lines, eol } = tokenize(raw, options.platformDefaultEol);
  const fence = locateFence(lines);
  const entries: HostEntry[] = [];

  // 围栏内按 managed 解析（禁用前缀保留为 enabled=false），围栏外一律 external。
  // 索引是半开区间：managedRange 转为 1-based 行号给用户看，解析时仍用 0-based。
  for (const line of lines) {
    const inManagedBlock = fence !== null && line.index > fence.begin && line.index < fence.end;

    if (inManagedBlock) {
      const entry = parseManagedLine(line.text, line.index, layerId);
      if (entry) entries.push(entry);
      continue;
    }

    if (fence && (line.index === fence.begin || line.index === fence.end)) continue;

    const entry = parseExternalLine(line.text, line.index, layerId);
    if (entry) entries.push(entry);
  }

  const document: HostsDocument = {
    rawLines: lines,
    eol,
    bom,
    managedRange: fence ? { start: fence.begin + 1, end: fence.end - 1 } : null,
    entries,
  };

  // 解析阶段用显式校验（IP/主机名/token 形状），不在这里深拷贝整份文档。
  // zod schema 由 models.ts 导出，用于 JSON 状态/配置边界与测试断言。
  return document;
}
