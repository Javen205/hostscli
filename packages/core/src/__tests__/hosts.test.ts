import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  DISABLED_ENTRY_PREFIX,
  END_MARKER,
  parseHosts,
  renderHosts,
  resolveHostsPath,
  tokenize,
  hostsDocumentSchema,
  UnsupportedEncodingError,
  HostsFormatError,
  UnsupportedPlatformError,
} from '../index';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const MANAGED_DOCUMENT = [
  '# 顶部注释',
  '127.0.0.1 localhost',
  '',
  BEGIN_MARKER,
  '10.0.0.12  api.example.com',
  '10.0.0.12  www.example.com',
  `${DISABLED_ENTRY_PREFIX} 10.0.0.9  old.example.com`,
  END_MARKER,
  '',
  '# 底部注释',
  '192.168.1.1 nas.local',
  '',
].join('\n');

describe('tokenizer / parser', () => {
  it('识别围栏、托管条目、禁用条目与外部条目', () => {
    const document = parseHosts(Buffer.from(MANAGED_DOCUMENT));

    expect(document.managedRange).toEqual({ start: 4, end: 6 });
    expect(document.bom).toBe(false);
    expect(document.eol).toBe('\n');

    const managed = document.entries.filter((entry) => entry.source === 'managed');
    const external = document.entries.filter((entry) => entry.source === 'external');

    expect(managed.map((entry) => entry.hostnames[0])).toEqual([
      'api.example.com',
      'www.example.com',
      'old.example.com',
    ]);
    expect(managed.map((entry) => entry.enabled)).toEqual([true, true, false]);
    expect(external.map((entry) => entry.ip)).toEqual(['127.0.0.1', '192.168.1.1']);
    expect(external[0]?.origin).toEqual({ raw: '127.0.0.1 localhost', line: 1 });
  });

  it('一条外部记录可包含多个主机名', () => {
    const document = parseHosts(Buffer.from('10.0.0.2  a.example.com b.example.com\n'));
    const entry = document.entries[0];

    expect(entry?.hostnames).toEqual(['a.example.com', 'b.example.com']);
    expect(entry?.source).toBe('external');
  });

  it('保留 CRLF、混合行尾与 BOM', () => {
    const crlf = Buffer.from('# a\r\n127.0.0.1  localhost\r\n');
    const document = parseHosts(crlf);

    expect(document.eol).toBe('\r\n');
    expect(renderHosts(document).equals(crlf)).toBe(true);

    const bomSource = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('127.0.0.1  localhost\n'),
    ]);
    const bomDocument = parseHosts(bomSource);

    expect(bomDocument.bom).toBe(true);
    expect(renderHosts(bomDocument).equals(bomSource)).toBe(true);
  });

  it('没有围栏的文件解析后渲染结果逐字节不变', () => {
    const source = Buffer.from('# 用户内容\n127.0.0.1 localhost\n\n10.0.0.1 legacy\n');
    const document = parseHosts(source);

    expect(renderHosts(document).equals(source)).toBe(true);
    expect(sha256(renderHosts(document))).toBe(sha256(source));
  });

  it('规范化托管区块的解析 → 渲染是幂等的', () => {
    const source = Buffer.from(MANAGED_DOCUMENT);
    const document = parseHosts(source);

    expect(renderHosts(document).equals(source)).toBe(true);
  });

  it('解析结果符合 zod 文档 schema', () => {
    const document = parseHosts(Buffer.from(MANAGED_DOCUMENT));
    const parsed = hostsDocumentSchema.safeParse(document);

    expect(parsed.success).toBe(true);
  });

  it('拒绝 UTF-16 与 NUL 字节，不做猜测转换', () => {
    expect(() => tokenize(Buffer.from([0xff, 0xfe, 0x31, 0x00]))).toThrow(UnsupportedEncodingError);
    expect(() => tokenize(Buffer.from([0x31, 0x00, 0x00, 0x00]))).toThrow(UnsupportedEncodingError);
  });

  it('围栏结构损坏时给出可定位的错误', () => {
    const missingEnd = Buffer.from(`127.0.0.1 localhost\n${BEGIN_MARKER}\n10.0.0.1 a\n`);
    expect(() => parseHosts(missingEnd)).toThrow(HostsFormatError);

    const missingBegin = Buffer.from(`127.0.0.1 localhost\n${END_MARKER}\n`);
    expect(() => parseHosts(missingBegin)).toThrow(HostsFormatError);

    const duplicated = Buffer.from(
      `${BEGIN_MARKER}\n10.0.0.1 a\n${END_MARKER}\n${BEGIN_MARKER}\n10.0.0.2 b\n${END_MARKER}\n`,
    );
    expect(() => parseHosts(duplicated)).toThrow(HostsFormatError);
  });
});

describe('platform paths', () => {
  it('macOS / Linux 使用 /etc/hosts', () => {
    expect(resolveHostsPath('darwin', {})).toBe('/etc/hosts');
    expect(resolveHostsPath('linux', {})).toBe('/etc/hosts');
  });

  it('Windows 使用 SystemRoot 拼接，缺少环境变量时回退到 C:\\Windows', () => {
    expect(resolveHostsPath('win32', { SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\drivers\\etc\\hosts',
    );
    expect(resolveHostsPath('win32', { windir: 'E:\\Windows' })).toBe(
      'E:\\Windows\\System32\\drivers\\etc\\hosts',
    );
    expect(resolveHostsPath('win32', {})).toBe('C:\\Windows\\System32\\drivers\\etc\\hosts');
  });

  it('不支持的平台明确报错', () => {
    expect(() => resolveHostsPath('aix', {})).toThrow(UnsupportedPlatformError);
  });
});
