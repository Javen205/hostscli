import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidInputError,
  LockedError,
  RuleConflictError,
  atomicWriteFile,
  createUnifiedDiff,
  dnsFlushCommands,
  flushDns,
  formatRemaining,
  lockPathFor,
  mergeLayers,
  parseDuration,
  profileIdSchema,
  withFileLock,
} from '../index';
import { lockDirectory, resolveDataPaths } from '../storage/paths';
import { lockPathForDataDir } from '../system/lock';

describe('时长解析（TTL）', () => {
  it('接受 s/m/h/d 与组合，并强制 1 分钟下限', () => {
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('3d')).toBe(259_200_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(() => parseDuration('30s')).toThrow(InvalidInputError);
    expect(() => parseDuration('1.5h')).toThrow(InvalidInputError);
    expect(() => parseDuration('')).toThrow(InvalidInputError);
  });

  it('formatRemaining 输出人类可读倒计时', () => {
    expect(formatRemaining(0)).toBe('0m');
    expect(formatRemaining(90_000)).toBe('1m');
    expect(formatRemaining(3_600_000 * 2 + 60_000 * 5)).toBe('2h 5m');
    expect(formatRemaining(86_400_000 * 3 + 3_600_000 * 4)).toBe('3d 4h');
  });
});

describe('规则栈合并', () => {
  function entry(layerId: string, ip: string, hostnames: string[], enabled = true) {
    return { id: `${layerId}-${ip}`, ip, hostnames, enabled, layerId, source: 'managed' as const };
  }

  it('高优先级覆盖低优先级，并保留来源', () => {
    const result = mergeLayers([
      { id: 'dev', priority: 10, entries: [entry('dev', '10.0.0.12', ['api.example.com'])] },
      { id: 'office', priority: 20, entries: [entry('office', '10.10.1.5', ['api.example.com'])] },
    ]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.ip).toBe('10.10.1.5');
    expect(
      result.candidates.get('api.example.com')?.find((item) => item.layerId === 'office')?.selected,
    ).toBe(true);
    expect(result.candidates.get('api.example.com')?.some((item) => item.shadowed)).toBe(true);
  });

  it('同优先级同名多 IP 默认失败并列出候选', () => {
    expect(() =>
      mergeLayers([
        { id: 'a', priority: 10, entries: [entry('a', '10.0.0.1', ['api.example.com'])] },
        { id: 'b', priority: 10, entries: [entry('b', '10.0.0.2', ['api.example.com'])] },
      ]),
    ).toThrow(RuleConflictError);
  });

  it('first-wins / last-wins 可显式裁决同优先级冲突', () => {
    const layers = [
      { id: 'a', priority: 10, order: 0, entries: [entry('a', '10.0.0.1', ['api.example.com'])] },
      { id: 'b', priority: 10, order: 1, entries: [entry('b', '10.0.0.2', ['api.example.com'])] },
    ];
    expect(mergeLayers(layers, { onConflict: 'first-wins' }).entries[0]?.ip).toBe('10.0.0.1');
    expect(mergeLayers(layers, { onConflict: 'last-wins' }).entries[0]?.ip).toBe('10.0.0.2');
  });

  it('同层同名多 IP 视为规则集自身错误', () => {
    expect(() =>
      mergeLayers([
        {
          id: 'a',
          priority: 10,
          entries: [
            entry('a', '10.0.0.1', ['api.example.com']),
            entry('a', '10.0.0.2', ['api.example.com']),
          ],
        },
      ]),
    ).toThrow(RuleConflictError);
  });

  it('hostname 小写并去尾点；一个条目的多个主机名各自成行', () => {
    const result = mergeLayers([
      {
        id: 'a',
        priority: 10,
        entries: [entry('a', '10.0.0.1', ['API.Example.COM.', 'www.example.com'])],
      },
    ]);

    expect(result.entries.map((item) => item.hostnames[0])).toEqual([
      'api.example.com',
      'www.example.com',
    ]);
  });
});

describe('dry-run diff', () => {
  it('只输出公共前后缀之间的改动', () => {
    const diff = createUnifiedDiff('a\nb\nc\n', 'a\nB\nc\n', {
      labelFrom: 'old',
      labelTo: 'new',
    });
    expect(diff).toContain('--- old');
    expect(diff).toContain('+++ new');
    expect(diff).toContain('-b');
    expect(diff).toContain('+B');
    expect(diff).not.toContain('-a');
  });

  it('相同内容返回空串；超长 diff 省略尾部', () => {
    expect(createUnifiedDiff('same', 'same')).toBe('');
    const before = Array.from({ length: 5000 }, (_, index) => `a-${index}`).join('\n');
    const after = Array.from({ length: 5000 }, (_, index) => `b-${index}`).join('\n');
    const diff = createUnifiedDiff(before, after);
    expect(diff).toContain('省略');
    expect(diff.split('\n').length).toBeLessThan(4100);
  });
});

describe('DNS 刷新命令选择', () => {
  it('三平台命令与预期一致', () => {
    expect(dnsFlushCommands('darwin')).toEqual([
      [{ command: 'dscacheutil', args: ['-flushcache'] }],
      [{ command: 'killall', args: ['-HUP', 'mDNSResponder'] }],
    ]);
    expect(dnsFlushCommands('linux')).toEqual([
      [{ command: 'resolvectl', args: ['flush-caches'] }],
      [{ command: 'systemd-resolve', args: ['--flush-caches'] }],
      [{ command: 'nscd', args: ['-i', 'hosts'] }],
    ]);
    expect(dnsFlushCommands('win32')).toEqual([[{ command: 'ipconfig', args: ['/flushdns'] }]]);
  });

  it('注入 runner 后可验证失败不抛异常、Linux 成功后停止回退', async () => {
    const calls: string[] = [];
    const result = await flushDns('linux', {
      runner: async (spec) => {
        calls.push(spec.command);
        throw new Error('not found');
      },
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual(['resolvectl', 'systemd-resolve', 'nscd']);

    const calls2: string[] = [];
    const ok = await flushDns('linux', {
      runner: async (spec) => {
        calls2.push(spec.command);
      },
    });
    expect(ok.ok).toBe(true);
    expect(calls2).toEqual(['resolvectl']);
  });
});

describe('跨进程锁', () => {
  let directory: string;
  let lockPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostscli-lock-'));
    lockPath = lockPathFor(join(directory, 'hosts'), join(directory, 'data'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('并发获取同一把锁时后来者超时失败', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markAcquired: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });

    const first = withFileLock(lockPath, async () => {
      markAcquired();
      await held;
    });

    // 必须等第一个锁真正建立后再竞争，否则第二个可能先拿到锁。
    await acquired;

    await expect(
      withFileLock(lockPath, async () => undefined, { timeoutMs: 50, retryMs: 10 }),
    ).rejects.toBeInstanceOf(LockedError);

    release();
    await first;

    await expect(withFileLock(lockPath, async () => undefined)).resolves.toBeUndefined();
  });

  it('可清理 PID 已不存在且已过期的陈旧锁', async () => {
    const directoryForLock = join(tmpdir(), 'hostscli-locks');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(directoryForLock, { recursive: true }),
    );
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, startedAt: '2000-01-01T00:00:00.000Z' }),
    );
    const past = new Date(Date.now() - 120_000);
    await utimes(lockPath, past, past);

    await expect(
      withFileLock(lockPath, async () => undefined, { staleMs: 60_000 }),
    ).resolves.toBeUndefined();
  });

  it('锁键只由 hostsPath 决定，不同 dataDir 共用同一把锁', () => {
    const hostsPath = join(directory, 'hosts');
    expect(lockPathFor(hostsPath, join(directory, 'data-a'))).toBe(
      lockPathFor(hostsPath, join(directory, 'data-b')),
    );
    expect(lockPathFor(hostsPath, join(directory, 'data-a'))).not.toBe(
      lockPathFor(join(directory, 'other-hosts'), join(directory, 'data-a')),
    );
  });

  it('符号链接别名与路径写法归一化到同一把锁', async () => {
    if (process.platform === 'win32') return;

    const real = join(directory, 'real');
    const alias = join(directory, 'alias');
    await mkdir(real, { recursive: true });
    await symlink(real, alias, 'dir');

    // macOS 的 /tmp→/private/tmp、Linux 的 /var→/private/var 属于同类别名。
    expect(lockPathFor(join(alias, 'hosts'))).toBe(lockPathFor(join(real, 'hosts')));
    expect(lockPathForDataDir(alias)).toBe(lockPathForDataDir(real));
    expect(lockPathForDataDir(`${real}/`)).toBe(lockPathForDataDir(real));
  });

  it('profilesDir 必须是数据目录内的相对路径', () => {
    expect(() => resolveDataPaths({ dataDir: directory, profilesDir: '../escape' })).toThrow(
      InvalidInputError,
    );
    expect(() =>
      resolveDataPaths({ dataDir: directory, profilesDir: join(directory, 'outside') }),
    ).toThrow(InvalidInputError);
    expect(resolveDataPaths({ dataDir: directory, profilesDir: 'profiles/team' }).profilesDir).toBe(
      join(directory, 'profiles', 'team'),
    );
  });

  it('锁目录在 POSIX 上固定为 /tmp/hostscli-locks', () => {
    if (process.platform !== 'win32') {
      expect(lockDirectory()).toBe('/tmp/hostscli-locks');
    }
  });
});

describe('原子写', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostscli-atomic-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('写入后内容完整、保留原文件权限，且不残留临时文件', async () => {
    const target = join(directory, 'hosts');
    await writeFile(target, 'old');
    await chmod(target, 0o640);
    await atomicWriteFile(target, Buffer.from('new-content'));
    await atomicWriteFile(target, Buffer.from('new-content-2'));

    expect(await readFile(target, 'utf8')).toBe('new-content-2');
    // 原子替换必须保留原文件权限位，而不是按 umask 重新计算。
    // Windows 的 POSIX mode 位不可靠，改为由 CI 的只读属性冒烟覆盖。
    if (process.platform !== 'win32') {
      expect((await stat(target)).mode & 0o777).toBe(0o640);
    }
    const names = await readdir(directory);
    expect(names.filter((name) => name.includes('.hostscli-'))).toEqual([]);
  });
});

describe('方案 ID 校验', () => {
  it('拒绝目录穿越与非法字符', () => {
    expect(profileIdSchema.safeParse('../evil').success).toBe(false);
    expect(profileIdSchema.safeParse('a/b').success).toBe(false);
    expect(profileIdSchema.safeParse('dev.1').success).toBe(true);
  });
});
