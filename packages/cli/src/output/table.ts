import type {
  DoctorRow,
  DoctorVerdict,
  HostEntry,
  ProfileView,
  StackLayerView,
  TtlView,
} from '@hostscli/core';
import { formatRemaining } from '@hostscli/core/duration';
import Table from 'cli-table3';
import pc from 'picocolors';
import { binName } from '../program-name';

function entryStatus(entry: HostEntry): string {
  if (entry.ttl) return pc.magenta('ttl');
  return entry.enabled ? pc.green('enabled') : pc.yellow('disabled');
}

// 用于计算去色后的可见宽度，这里必须匹配 ESC 控制字符本身。
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
/**
 * cli-table3 在行数很大时（2k 行约数秒，20k 行超过一分钟）会退化成 O(n²)。
 * 超过阈值后改用一次扫描算列宽的纯文本表格，保证大 hosts 文件也能秒级列出。
 */
const SIMPLE_TABLE_THRESHOLD = 500;

function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

function renderPlainTable(head: string[], rows: string[][]): string {
  const widths = head.map((title, index) => {
    let width = visibleLength(title);
    for (const row of rows) {
      width = Math.max(width, visibleLength(row[index] ?? ''));
    }
    return width;
  });

  const formatRow = (cells: string[]): string =>
    cells
      .map((cell, index) => cell + ' '.repeat(Math.max(0, widths[index]! - visibleLength(cell))))
      .join('  ')
      .trimEnd();

  return [formatRow(head), ...rows.map(formatRow)].join('\n');
}

function renderTable(head: string[], rows: string[][]): string {
  if (rows.length > SIMPLE_TABLE_THRESHOLD) return renderPlainTable(head, rows);

  const table = new Table({
    head,
    style: { head: [], border: [] },
    wordWrap: false,
  });
  for (const row of rows) table.push(row);
  return table.toString();
}

export interface EntryTableOptions {
  /** 是否在首列显示展示序号（仅渲染层，不写入 JSON）。 */
  index?: boolean;
}

/**
 * 方案名可能很长。表格不做自动换行，超长会挤压其它列，
 * 因此按可见宽度截断并补省略号，保证列不串行。
 */
function truncate(text: string, max: number): string {
  if (visibleLength(text) <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function renderEntryTable(entries: HostEntry[], options: EntryTableOptions = {}): string {
  if (entries.length === 0) return '（没有可显示的 hosts 条目）';

  const showIndex = options.index ?? false;
  const head = [
    ...(showIndex ? ['#'] : []),
    'IP',
    'HOSTNAMES',
    'PROFILE',
    'STATUS',
    'SOURCE',
    'COMMENT',
  ];
  const rows = entries.map((entry, position) => [
    ...(showIndex ? [String(position + 1)] : []),
    entry.ip,
    entry.hostnames.join(', '),
    // 非托管行不属于任何方案，显式用 '-' 区分，避免误导成 default 方案。
    entry.source === 'managed' ? truncate(entry.layerId, 24) : pc.dim('-'),
    entryStatus(entry),
    entry.source,
    entry.comment ?? '',
  ]);
  return renderTable(head, rows);
}

export function renderTtlTable(views: TtlView[]): string {
  if (views.length === 0) return '（没有 TTL 记录）';

  const rows = views.map((view) => {
    const status = view.record.paused
      ? 'paused'
      : view.record.status === 'pending'
        ? `pending(${view.record.pendingReason ?? 'write-failed'})`
        : 'active';
    return [
      view.hostnames.join(', '),
      view.ip ?? '-',
      view.record.paused
        ? `paused ${formatRemaining(view.remainingMs)}`
        : formatRemaining(view.remainingMs),
      status,
      view.record.reason ?? '',
    ];
  });
  return renderTable(['DOMAIN', 'IP', 'REMAINING', 'STATUS', 'REASON'], rows);
}

export function renderProfileTable(views: ProfileView[]): string {
  if (views.length === 0) return `（没有方案，可用 ${binName()} profile create 创建）`;

  const rows = views.map((view) => [
    view.profile.id,
    view.profile.name,
    String(view.profile.priority),
    String(view.entryCount),
    view.active ? pc.green('yes') : '',
  ]);
  return renderTable(['ID', 'NAME', 'PRIORITY', 'ENTRIES', 'ACTIVE'], rows);
}

export function renderStackLayerTable(views: StackLayerView[]): string {
  if (views.length === 0) {
    return `（没有规则层，可用 ${binName()} stack layer add <id> --file <path> 添加）`;
  }

  const rows = views.map((view) => [
    view.profile.id,
    view.profile.name,
    String(view.profile.priority),
    String(view.entryCount),
    String(view.disabledCount),
    String(view.ttlCount),
    view.active ? pc.green('yes') : pc.dim('no'),
  ]);
  return renderTable(['ID', 'NAME', 'PRIORITY', 'ENTRIES', 'DISABLED', 'TTL', 'ACTIVE'], rows);
}

const VERDICT_COLOR: Record<DoctorVerdict, (value: string) => string> = {
  'hosts-effective': pc.green,
  normal: pc.green,
  indistinguishable: pc.yellow,
  'not-effective': pc.red,
  nxdomain: pc.red,
  unreachable: pc.magenta,
  'double-failure': pc.red,
};

function formatAnswers(answers: DoctorRow['systemDns']): string {
  const addresses = [...answers.a, ...answers.aaaa];
  if (addresses.length > 0) return addresses.join(', ');
  if (answers.status === 'not-found') return pc.dim('not-found');
  if (answers.status === 'error') return pc.red('error');
  return pc.dim('none');
}

export function renderDoctorTable(rows: DoctorRow[]): string {
  if (rows.length === 0) return '（没有需要诊断的域名）';

  const table = new Table({
    head: ['DOMAIN', 'RULE', 'SYSTEM DNS', 'ACTUAL', 'VERDICT'],
    style: { head: [], border: [] },
    wordWrap: true,
  });

  for (const row of rows) {
    table.push([
      row.hostname,
      row.expected.join(', ') || pc.dim('-'),
      formatAnswers(row.systemDns),
      formatAnswers(row.actual),
      VERDICT_COLOR[row.verdict](row.verdict),
    ]);
  }

  let output = table.toString();
  const details = rows.filter((row) => row.note || row.action);
  if (details.length > 0) {
    output += '\n';
    for (const row of rows) {
      if (!row.note && !row.action) continue;
      output += `${pc.dim(row.hostname)}: ${row.note ?? ''}${row.note ? ' ' : ''}${pc.dim(row.action)}\n`;
    }
  }
  return output.trimEnd();
}
