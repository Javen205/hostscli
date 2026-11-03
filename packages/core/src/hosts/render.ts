import type { HostEntry, HostsDocument, RawLine } from './models';
import { BEGIN_MARKER, DISABLED_ENTRY_PREFIX, END_MARKER } from './models';
import { UTF8_BOM } from './tokenizer';

export interface RenderOptions {
  /** 文档没有托管区块时，是否在文件末尾追加一个空区块。 */
  appendIfMissing?: boolean;
  /**
   * 显式指定托管区块内容。传入时按该列表逐行重建（不再输出禁用注释行）；
   * 不传时按文档解析结果原样镜像，用于无损往返测试与低层工具。
   */
  managedEntries?: Array<Pick<HostEntry, 'ip' | 'hostnames' | 'comment'>>;
}

function locateFence(lines: RawLine[]): { begin: number; end: number } | null {
  let begin = -1;
  let end = -1;

  for (const line of lines) {
    const text = line.text.trimEnd();
    if (text === BEGIN_MARKER && begin === -1) begin = line.index;
    if (text === END_MARKER) end = line.index;
  }

  if (begin === -1 || end === -1) return null;
  return { begin, end };
}

function renderManagedLines(
  document: HostsDocument,
  managedEntries?: RenderOptions['managedEntries'],
): RawLine[] {
  const lines: RawLine[] = [];

  if (managedEntries) {
    for (const entry of managedEntries) {
      for (const hostname of entry.hostnames) {
        const text = `${entry.ip}  ${hostname}${entry.comment ? `  # ${entry.comment}` : ''}`;
        lines.push({ text, eol: document.eol, index: lines.length });
      }
    }
    return lines;
  }

  for (const entry of document.entries) {
    if (entry.source !== 'managed') continue;

    for (const hostname of entry.hostnames) {
      const base = `${entry.ip}  ${hostname}${entry.comment ? `  # ${entry.comment}` : ''}`;
      const text = entry.enabled ? base : `${DISABLED_ENTRY_PREFIX} ${base}`;
      lines.push({ text, eol: document.eol, index: lines.length });
    }
  }

  return lines;
}

function appendManagedBlock(document: HostsDocument, block: RawLine[]): RawLine[] {
  const lines = document.rawLines.map((line) => ({ ...line }));
  const endedWithEol = lines.length > 0 && lines[lines.length - 1]?.eol !== '';

  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last && last.eol === '') last.eol = document.eol;
  }

  let index = lines.length;
  lines.push({ text: BEGIN_MARKER, eol: document.eol, index: index++ });
  for (const line of block) {
    lines.push({ ...line, index: index++ });
  }
  lines.push({ text: END_MARKER, eol: endedWithEol ? document.eol : '', index });

  return lines;
}

function assemble(lines: RawLine[], bom: boolean): Buffer {
  const text = lines.map((line) => `${line.text}${line.eol}`).join('');
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([UTF8_BOM, body]) : body;
}

/**
 * 把 HostsDocument 渲染回字节。
 * 围栏外的行只做原样拼接，绝不重写；围栏内按托管条目重建。
 */
export function renderHosts(document: HostsDocument, options: RenderOptions = {}): Buffer {
  const fence = locateFence(document.rawLines);

  if (!fence) {
    if (!options.appendIfMissing) return assemble(document.rawLines, document.bom);

    const lines = appendManagedBlock(
      document,
      renderManagedLines(document, options.managedEntries),
    );
    return assemble(lines, document.bom);
  }

  const block = renderManagedLines(document, options.managedEntries);
  const lines: RawLine[] = [];

  for (let index = 0; index < fence.begin; index += 1) {
    const line = document.rawLines[index];
    if (line) lines.push(line);
  }

  const beginLine = document.rawLines[fence.begin];
  if (!beginLine) {
    return assemble(document.rawLines, document.bom);
  }

  lines.push({
    text: beginLine.text,
    eol: beginLine.eol === '' ? document.eol : beginLine.eol,
    index: lines.length,
  });

  for (const line of block) {
    lines.push(line);
  }

  for (let index = fence.end; index < document.rawLines.length; index += 1) {
    const line = document.rawLines[index];
    if (line) lines.push(line);
  }

  return assemble(lines, document.bom);
}
