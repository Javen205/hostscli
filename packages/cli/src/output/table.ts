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

function entryStatus(entry: HostEntry): string {
  if (entry.ttl) return pc.magenta('ttl');
  return entry.enabled ? pc.green('enabled') : pc.yellow('disabled');
}

export function renderEntryTable(entries: HostEntry[]): string {
  if (entries.length === 0) return '（没有可显示的 hosts 条目）';

  const table = new Table({
    head: ['IP', 'HOSTNAMES', 'STATUS', 'SOURCE', 'COMMENT'],
    style: { head: [], border: [] },
    wordWrap: false,
  });

  for (const entry of entries) {
    table.push([
      entry.ip,
      entry.hostnames.join(', '),
      entryStatus(entry),
      entry.source,
      entry.comment ?? '',
    ]);
  }

  return table.toString();
}

export function renderTtlTable(views: TtlView[]): string {
  if (views.length === 0) return '（没有 TTL 记录）';

  const table = new Table({
    head: ['DOMAIN', 'IP', 'REMAINING', 'STATUS', 'REASON'],
    style: { head: [], border: [] },
    wordWrap: false,
  });

  for (const view of views) {
    const status = view.record.paused
      ? 'paused'
      : view.record.status === 'pending'
        ? `pending(${view.record.pendingReason ?? 'write-failed'})`
        : 'active';
    table.push([
      view.hostnames.join(', '),
      view.ip ?? '-',
      view.record.paused
        ? `paused ${formatRemaining(view.remainingMs)}`
        : formatRemaining(view.remainingMs),
      status,
      view.record.reason ?? '',
    ]);
  }

  return table.toString();
}

export function renderProfileTable(views: ProfileView[]): string {
  if (views.length === 0) return '（没有方案，可用 hostscli profile create 创建）';

  const table = new Table({
    head: ['ID', 'NAME', 'PRIORITY', 'ENTRIES', 'ACTIVE'],
    style: { head: [], border: [] },
    wordWrap: false,
  });

  for (const view of views) {
    table.push([
      view.profile.id,
      view.profile.name,
      String(view.profile.priority),
      String(view.entryCount),
      view.active ? pc.green('yes') : '',
    ]);
  }

  return table.toString();
}

export function renderStackLayerTable(views: StackLayerView[]): string {
  if (views.length === 0) {
    return '（没有规则层，可用 hostscli stack layer add <id> --file <path> 添加）';
  }

  const table = new Table({
    head: ['ID', 'NAME', 'PRIORITY', 'ENTRIES', 'DISABLED', 'TTL', 'ACTIVE'],
    style: { head: [], border: [] },
    wordWrap: false,
  });

  for (const view of views) {
    table.push([
      view.profile.id,
      view.profile.name,
      String(view.profile.priority),
      String(view.entryCount),
      String(view.disabledCount),
      String(view.ttlCount),
      view.active ? pc.green('yes') : pc.dim('no'),
    ]);
  }

  return table.toString();
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
