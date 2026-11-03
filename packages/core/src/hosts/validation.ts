import { isIP } from 'node:net';
import { InvalidInputError } from '../errors';
import { normalizeHostname } from './models';

export interface EntryInput {
  ip: string;
  hostnames: string[];
  comment?: string;
}

/**
 * C0/C1 控制字符、DEL 与 Unicode 行分隔符。
 * hosts 是逐行格式，任何换行/控制字符都会把单条规则拆成多行，必须在校验入口拒绝。
 */
// eslint-disable-next-line no-control-regex -- 这里就是要拦截控制字符
export const FORBIDDEN_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export function containsForbiddenText(value: string): boolean {
  return FORBIDDEN_TEXT_PATTERN.test(value);
}

function assertSingleLine(value: string, label: string): void {
  if (containsForbiddenText(value)) {
    throw new InvalidInputError(`${label}不能包含换行或其他控制字符。`);
  }
}

/** 校验 IP、主机名与注释；返回去重后的主机名（保留用户输入的原始大小写）。 */
export function validateEntryInput(input: EntryInput): EntryInput {
  const ip = input.ip.trim();
  if (ip === '' || isIP(ip) === 0) {
    throw new InvalidInputError(`无效的 IP 地址：${input.ip}（只接受 IPv4 / IPv6 字面量）。`);
  }

  const unique = new Map<string, string>();
  for (const raw of input.hostnames) {
    assertSingleLine(raw, `主机名 ${JSON.stringify(raw)}`);
    const hostname = raw.trim();
    if (hostname === '' || /\s/.test(hostname) || hostname.includes('#')) {
      throw new InvalidInputError(`无效的主机名：${raw}`);
    }
    const key = normalizeHostname(hostname);
    if (!unique.has(key)) unique.set(key, hostname);
  }

  if (unique.size === 0) {
    throw new InvalidInputError('至少需要一个主机名。');
  }

  if (input.comment !== undefined) {
    assertSingleLine(input.comment, '注释');
  }

  const comment = input.comment?.trim();
  return comment
    ? { ip, hostnames: [...unique.values()], comment }
    : { ip, hostnames: [...unique.values()] };
}
