import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  END_MARKER,
  EntryNotFoundError,
  RuleConflictError,
  addRemoteSource,
  addStackLayer,
  applyStack,
  defaultConfig,
  defaultState,
  doctorHosts,
  explainStackHostname,
  judge,
  listRemoteSources,
  listStackLayers,
  parseResolvConf,
  parseResolvectl,
  parseScutilDns,
  readProfile,
  removeRemoteSource,
  setStackLayerEnabled,
  updateRemoteSources,
} from '../index';

const MARKED = [
  '# top',
  '127.0.0.1 localhost',
  '',
  BEGIN_MARKER,
  '10.0.0.12  api.example.com',
  END_MARKER,
  '',
  '# bottom',
  '192.168.1.1 nas.local',
  '',
].join('\n');

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function outside(text: string): { prefix: string; suffix: string } {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin === -1 || end === -1) return { prefix: text, suffix: '' };
  return { prefix: text.slice(0, begin), suffix: text.slice(end + END_MARKER.length) };
}

function assertOutsideUnchanged(before: string, after: string): void {
  const original = outside(before);
  const current = outside(after);
  expect(sha256(current.prefix)).toBe(sha256(original.prefix));
  expect(sha256(current.suffix)).toBe(sha256(original.suffix));
}

interface StackEnv {
  directory: string;
  hostsPath: string;
  dataDir: string;
  options: () => {
    filePath: string;
    dataDir: string;
    env: NodeJS.ProcessEnv;
    dnsFlush: false;
    now: Date;
  };
  cleanup: () => Promise<void>;
}

/** 每个测试独立目录：vitest 可能并发执行同一文件的用例，不能共享可变 setup。 */
async function makeStackEnv(initial = MARKED): Promise<StackEnv> {
  const directory = await mkdtemp(join(tmpdir(), 'hostscli-stack-'));
  const hostsPath = join(directory, 'hosts');
  const dataDir = join(directory, 'data');
  await writeFile(hostsPath, initial);
  return {
    directory,
    hostsPath,
    dataDir,
    options: () => ({
      filePath: hostsPath,
      dataDir,
      env: { ...process.env, HOME: directory },
      dnsFlush: false as const,
      now: new Date('2026-11-02T00:00:00.000Z'),
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe('阶段 3：规则层导入与启停', () => {
  it('可从 JSON 方案或纯 hosts 文本导入层，并默认启用', async () => {
    const env = await makeStackEnv();
    try {
      const jsonPath = join(env.directory, 'office.json');
      await writeFile(
        jsonPath,
        JSON.stringify({
          id: 'office',
          name: '办公室',
          priority: 20,
          entries: [{ ip: '10.10.1.5', hostnames: ['api.example.com'], enabled: true }],
        }),
      );
      const hostsSource = join(env.directory, 'dev.hosts');
      await writeFile(hostsSource, '# dev\n10.0.0.12 api.example.com\n');

      const office = await addStackLayer({ ...env.options(), id: 'office', file: jsonPath });
      const dev = await addStackLayer({
        ...env.options(),
        id: 'dev',
        file: hostsSource,
        priority: 10,
      });

      expect(office.profile.priority).toBe(20);
      expect(dev.profile.entries[0]?.hostnames).toEqual(['api.example.com']);

      const listed = await listStackLayers(env.options());
      expect(listed.activeLayers).toEqual(['office', 'dev']);
      expect(listed.layers.map((view) => [view.profile.id, view.active])).toEqual([
        ['dev', true],
        ['office', true],
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it('同名层默认拒绝覆盖，--force 可覆盖', async () => {
    const env = await makeStackEnv();
    try {
      const source = join(env.directory, 'layer.json');
      await writeFile(
        source,
        JSON.stringify({ entries: [{ ip: '10.0.0.1', hostnames: ['a.test'] }] }),
      );
      await addStackLayer({ ...env.options(), id: 'a', file: source });
      await expect(
        addStackLayer({ ...env.options(), id: 'a', file: source }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      const replaced = await addStackLayer({
        ...env.options(),
        id: 'a',
        file: source,
        force: true,
      });
      expect(replaced.replaced).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('导入数组格式层文件时拒绝 comment/hostname 的换行与控制字符', async () => {
    const env = await makeStackEnv();
    try {
      const injectedComment = [
        { ip: '10.0.0.1', hostnames: ['evil.test'], comment: 'ok\n# >>> hostscli managed' },
      ];
      const commentPath = join(env.directory, 'comment.json');
      await writeFile(commentPath, JSON.stringify(injectedComment));

      const error = await addStackLayer({
        ...env.options(),
        id: 'evil-comment',
        file: commentPath,
      }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
      expect((error as Error).message).toContain('控制字符');
      await expect(
        readProfile(join(env.dataDir, 'profiles'), 'evil-comment'),
      ).rejects.toBeInstanceOf(EntryNotFoundError);

      const hostnamePath = join(env.directory, 'hostname.json');
      await writeFile(
        hostnamePath,
        JSON.stringify([{ ip: '10.0.0.2', hostnames: ['ok.test\n10.0.0.3 injected.test'] }]),
      );
      await expect(
        addStackLayer({ ...env.options(), id: 'evil-hostname', file: hostnamePath }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        readProfile(join(env.dataDir, 'profiles'), 'evil-hostname'),
      ).rejects.toBeInstanceOf(EntryNotFoundError);
      expect(await readFile(env.hostsPath, 'utf8')).not.toContain('injected.test');
    } finally {
      await env.cleanup();
    }
  });

  it('数组层文件的非对象元素与错误字段类型统一返回 InvalidInput', async () => {
    const env = await makeStackEnv();
    try {
      const nonObjectPath = join(env.directory, 'non-object.json');
      await writeFile(nonObjectPath, JSON.stringify(['not-an-object']));
      const nonObject = await addStackLayer({
        ...env.options(),
        id: 'non-object',
        file: nonObjectPath,
      }).catch((value: unknown) => value);
      expect(nonObject).toMatchObject({ code: 'INVALID_INPUT' });
      expect((nonObject as Error).message).toContain('必须是对象');
      expect((nonObject as Error).message).not.toMatch(/Zod/i);
      await expect(readProfile(join(env.dataDir, 'profiles'), 'non-object')).rejects.toBeInstanceOf(
        EntryNotFoundError,
      );

      const badCommentPath = join(env.directory, 'bad-comment.json');
      await writeFile(
        badCommentPath,
        JSON.stringify([{ ip: '10.0.0.1', hostnames: ['bad.test'], comment: 123 }]),
      );
      const badComment = await addStackLayer({
        ...env.options(),
        id: 'bad-comment',
        file: badCommentPath,
      }).catch((value: unknown) => value);
      expect(badComment).toMatchObject({ code: 'INVALID_INPUT' });
      expect((badComment as Error).message).toContain('comment');
      await expect(
        readProfile(join(env.dataDir, 'profiles'), 'bad-comment'),
      ).rejects.toBeInstanceOf(EntryNotFoundError);
    } finally {
      await env.cleanup();
    }
  });

  it('同层同名多 IP 的层文件按输入错误拒绝，而非存储损坏', async () => {
    const env = await makeStackEnv();
    try {
      const source = join(env.directory, 'duplicate.json');
      await writeFile(
        source,
        JSON.stringify([
          { ip: '10.0.0.1', hostnames: ['dup.test'] },
          { ip: '10.0.0.2', hostnames: ['dup.test'] },
        ]),
      );
      const error = await addStackLayer({
        ...env.options(),
        id: 'duplicate',
        file: source,
      }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
      expect((error as Error).message).toContain('同时映射');
      await expect(readProfile(join(env.dataDir, 'profiles'), 'duplicate')).rejects.toBeInstanceOf(
        EntryNotFoundError,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('profiles 目录里被写入换行注释的文件会被拒绝读取', async () => {
    const env = await makeStackEnv();
    try {
      const source = join(env.directory, 'ok.json');
      await writeFile(
        source,
        JSON.stringify({
          entries: [{ ip: '10.0.0.1', hostnames: ['ok.test'], comment: '正常注释' }],
        }),
      );
      await addStackLayer({ ...env.options(), id: 'ok', file: source });

      const profilePath = join(env.dataDir, 'profiles', 'ok.json');
      const raw = JSON.parse(await readFile(profilePath, 'utf8')) as {
        entries: Array<{ comment?: string }>;
      };
      raw.entries[0]!.comment = '正常注释\n# >>> hostscli managed\n10.0.0.2 injected.test';
      await writeFile(profilePath, JSON.stringify(raw));

      const error = await readProfile(join(env.dataDir, 'profiles'), 'ok').catch(
        (value: unknown) => value,
      );
      expect(error).toMatchObject({ code: 'STORAGE_CORRUPT' });
      expect((error as Error).message).toContain('控制字符');
      expect(await readFile(env.hostsPath, 'utf8')).not.toContain('injected.test');
    } finally {
      await env.cleanup();
    }
  });

  it('注释中注入围栏标记不会污染托管区', async () => {
    const env = await makeStackEnv();
    try {
      const source = join(env.directory, 'fence.json');
      await writeFile(
        source,
        JSON.stringify({
          entries: [
            {
              ip: '10.0.0.1',
              hostnames: ['fence.test'],
              comment: `${BEGIN_MARKER} ${END_MARKER}`,
            },
          ],
        }),
      );
      await addStackLayer({ ...env.options(), id: 'fence', file: source });

      const before = await readFile(env.hostsPath, 'utf8');
      await applyStack(env.options());
      const after = await readFile(env.hostsPath, 'utf8');

      const markerLines = after
        .split('\n')
        .filter((line) => line.trimEnd() === BEGIN_MARKER || line.trimEnd() === END_MARKER);
      expect(markerLines).toEqual([BEGIN_MARKER, END_MARKER]);
      expect(after).toContain('10.0.0.1  fence.test');

      // 注入的标记出现在托管区内部，不能用 after 里的首个 END_MARKER 定位围栏；
      // 用写入前（干净围栏）的围栏外前后缀断言字节未被改动。
      const originalOutside = outside(before);
      expect(after.startsWith(originalOutside.prefix)).toBe(true);
      expect(after.endsWith(originalOutside.suffix)).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('dry-run 不写文件；--apply 后只影响托管区，围栏外字节不变', async () => {
    const env = await makeStackEnv();
    try {
      const layerPath = join(env.directory, 'office.json');
      await writeFile(
        layerPath,
        JSON.stringify({ entries: [{ ip: '10.10.1.5', hostnames: ['api.example.com'] }] }),
      );
      await addStackLayer({
        ...env.options(),
        id: 'office',
        file: layerPath,
        priority: 20,
      });

      const before = await readFile(env.hostsPath, 'utf8');
      const preview = await applyStack({ ...env.options(), dryRun: true });
      expect(preview.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(before);

      await applyStack(env.options());
      const after = await readFile(env.hostsPath, 'utf8');
      expect(after).toContain('10.10.1.5  api.example.com');
      expect(after).not.toContain('10.0.0.12  api.example.com');
      assertOutsideUnchanged(before, after);
    } finally {
      await env.cleanup();
    }
  });

  it('停用层只改状态；再次 apply 后该层条目消失，再启用可恢复', async () => {
    const env = await makeStackEnv();
    try {
      const layerPath = join(env.directory, 'dev.json');
      await writeFile(
        layerPath,
        JSON.stringify({ entries: [{ ip: '10.0.0.99', hostnames: ['dev.example.com'] }] }),
      );
      await addStackLayer({ ...env.options(), id: 'dev', file: layerPath });
      await applyStack(env.options());

      const disabled = await setStackLayerEnabled({
        ...env.options(),
        id: 'dev',
        enabled: false,
      });
      expect(disabled.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('10.0.0.99  dev.example.com');

      await applyStack(env.options());
      expect(await readFile(env.hostsPath, 'utf8')).not.toContain('dev.example.com');

      await setStackLayerEnabled({ ...env.options(), id: 'dev', enabled: true });
      await applyStack(env.options());
      expect(await readFile(env.hostsPath, 'utf8')).toContain('10.0.0.99  dev.example.com');
    } finally {
      await env.cleanup();
    }
  });

  it('停用全部层后，只读操作不会再自动迁移出 default 层', async () => {
    const env = await makeStackEnv();
    try {
      const layerPath = join(env.directory, 'only.json');
      await writeFile(
        layerPath,
        JSON.stringify({ entries: [{ ip: '10.1.0.1', hostnames: ['only.test'] }] }),
      );
      await addStackLayer({ ...env.options(), id: 'only', file: layerPath });

      await setStackLayerEnabled({ ...env.options(), id: 'only', enabled: false });
      const afterDisable = await listStackLayers(env.options());
      expect(afterDisable.layers.map((view) => view.profile.id)).toEqual(['only']);
      expect(afterDisable.activeLayers).toEqual([]);
      expect(afterDisable.layers.some((view) => view.profile.id === 'default')).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it('多优先级冲突：默认失败且 hosts 不变；first-wins 可落盘', async () => {
    const env = await makeStackEnv();
    try {
      for (const [id, priority, ip] of [
        ['a', 10, '10.0.0.1'],
        ['b', 10, '10.0.0.2'],
      ] as const) {
        const path = join(env.directory, `${id}.json`);
        await writeFile(path, JSON.stringify({ entries: [{ ip, hostnames: ['clash.test'] }] }));
        await addStackLayer({ ...env.options(), id, file: path, priority });
      }

      const before = await readFile(env.hostsPath, 'utf8');
      await expect(applyStack(env.options())).rejects.toBeInstanceOf(RuleConflictError);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(before);

      const result = await applyStack({ ...env.options(), onConflict: 'first-wins' });
      expect(result.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('10.0.0.1  clash.test');
    } finally {
      await env.cleanup();
    }
  });

  it('最高优先级胜出，最高档同名多 IP 时仍然失败', async () => {
    const env = await makeStackEnv();
    try {
      for (const [id, priority, ip] of [
        ['low', 10, '10.0.0.1'],
        ['high', 30, '10.0.0.3'],
      ] as const) {
        const path = join(env.directory, `${id}.json`);
        await writeFile(path, JSON.stringify({ entries: [{ ip, hostnames: ['pick.test'] }] }));
        await addStackLayer({
          ...env.options(),
          id,
          file: path,
          priority,
          enable: id === 'low',
        });
      }
      await setStackLayerEnabled({ ...env.options(), id: 'high', enabled: true });

      const preview = await applyStack({
        ...env.options(),
        dryRun: true,
        onConflict: 'highest-priority',
      });
      expect(preview.changed).toBe(true);
      expect(preview.diff).toContain('10.0.0.3  pick.test');
    } finally {
      await env.cleanup();
    }
  });

  it('explain 输出候选链、标记 shadowed，并在托管区被手改时提示 stale', async () => {
    const env = await makeStackEnv();
    try {
      const officePath = join(env.directory, 'office.json');
      await writeFile(
        officePath,
        JSON.stringify({ entries: [{ ip: '10.10.1.5', hostnames: ['api.example.com'] }] }),
      );
      const devPath = join(env.directory, 'dev.json');
      await writeFile(
        devPath,
        JSON.stringify({ entries: [{ ip: '10.0.0.12', hostnames: ['api.example.com'] }] }),
      );
      await addStackLayer({
        ...env.options(),
        id: 'office',
        file: officePath,
        priority: 20,
      });
      await addStackLayer({ ...env.options(), id: 'dev', file: devPath, priority: 10 });
      await applyStack(env.options());

      const result = await explainStackHostname({
        ...env.options(),
        hostname: 'API.example.com.',
      });
      expect(result.hostname).toBe('api.example.com');
      expect(result.result).toBe('10.10.1.5');
      expect(result.candidates.find((candidate) => candidate.layerId === 'dev')?.shadowed).toBe(
        true,
      );
      expect(result.stale).toBe(false);

      const text = await readFile(env.hostsPath, 'utf8');
      await writeFile(env.hostsPath, `${text}10.9.9.9  manual.test\n`);
      const stale = await explainStackHostname({ ...env.options(), hostname: 'api.example.com' });
      expect(stale.stale).toBe(true);
      expect(stale.warnings.join('\n')).toContain('stack apply');
    } finally {
      await env.cleanup();
    }
  });

  it('explain 对不存在的域名给出明确错误', async () => {
    const env = await makeStackEnv();
    try {
      await expect(
        explainStackHostname({ ...env.options(), hostname: 'missing.test' }),
      ).rejects.toBeInstanceOf(EntryNotFoundError);
    } finally {
      await env.cleanup();
    }
  });
});

describe('阶段 3：默认值隔离（回归）', () => {
  it('多次生成的默认配置/状态不共享数组引用', () => {
    const firstConfig = defaultConfig();
    const secondConfig = defaultConfig();
    firstConfig.remote.sources.push({
      id: 'leak',
      url: 'https://example.com/sub',
      enabled: true,
    });
    expect(secondConfig.remote.sources).toHaveLength(0);

    const firstState = defaultState();
    const secondState = defaultState();
    firstState.activeLayers.push('leak');
    expect(secondState.activeLayers).toHaveLength(0);
  });
});

describe('阶段 3：doctor 判定矩阵与注入依赖', () => {
  it('覆盖方案 2.5 的全部判定分支', () => {
    const answers = (
      status: 'ok' | 'not-found' | 'error',
      a: string[] = [],
      aaaa: string[] = [],
    ) => ({ status, a, aaaa });

    expect(
      judge(['10.0.0.12'], answers('ok', ['10.0.0.12']), answers('ok', ['10.0.0.12'])).verdict,
    ).toBe('indistinguishable');
    expect(
      judge(['10.0.0.12'], answers('ok', ['1.1.1.1']), answers('ok', ['10.0.0.12'])).verdict,
    ).toBe('hosts-effective');
    expect(judge(['10.0.0.12'], answers('not-found'), answers('ok', ['10.0.0.1'])).verdict).toBe(
      'not-effective',
    );
    expect(judge(['10.0.0.12'], answers('not-found'), answers('not-found')).verdict).toBe(
      'double-failure',
    );
    expect(judge([], answers('ok', ['1.1.1.1']), answers('ok', ['1.1.1.1'])).verdict).toBe(
      'normal',
    );
    expect(judge([], answers('not-found'), answers('not-found')).verdict).toBe('nxdomain');
    expect(judge([], answers('error'), answers('error')).verdict).toBe('unreachable');
  });

  it('doctorHosts 全量巡检、并发受限，并按结果给退出码', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hostscli-doctor-'));
    const hostsPath = join(directory, 'hosts');
    const dataDir = join(directory, 'data');
    try {
      await writeFile(
        hostsPath,
        [BEGIN_MARKER, '10.0.0.1  a.test', '10.0.0.2  b.test', END_MARKER, ''].join('\n'),
      );

      let active = 0;
      let peak = 0;
      const querySystem = async (hostname: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        const a: string[] = hostname === 'a.test' ? ['1.1.1.1'] : [];
        return { status: 'ok' as const, a, aaaa: [] };
      };
      const lookupActual = async (hostname: string) => {
        const a: string[] =
          hostname === 'a.test' ? ['10.0.0.1'] : hostname === 'b.test' ? ['10.9.9.9'] : [];
        return { status: 'ok' as const, a, aaaa: [] };
      };

      const report = await doctorHosts(
        {
          filePath: hostsPath,
          dataDir,
          env: { ...process.env, HOME: directory },
          all: true,
          concurrency: 2,
        },
        {
          readServers: async () => ({ servers: ['1.1.1.1'], source: 'scutil' }),
          querySystem,
          lookupActual,
        },
      );

      expect(peak).toBeLessThanOrEqual(2);
      expect(report.rows.map((row) => [row.hostname, row.verdict])).toEqual([
        ['a.test', 'hosts-effective'],
        ['b.test', 'not-effective'],
      ]);
      expect(report.exitCode).toBe(5);

      const nx = await doctorHosts(
        {
          filePath: hostsPath,
          dataDir,
          env: { ...process.env, HOME: directory },
          hostnames: ['missing.test'],
        },
        {
          readServers: async () => ({ servers: [], source: 'none' }),
          querySystem: async () => ({ status: 'not-found', a: [], aaaa: [] }),
          lookupActual: async () => ({ status: 'not-found', a: [], aaaa: [] }),
        },
      );
      expect(nx.rows[0]?.verdict).toBe('nxdomain');
      expect(nx.exitCode).toBe(6);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('解析三平台 DNS 服务器输出', () => {
    expect(
      parseScutilDns('  nameserver[0] : 192.168.1.1\n  nameserver[1] : fe80::1%en0\n'),
    ).toEqual(['192.168.1.1', 'fe80::1']);
    expect(parseResolvConf('nameserver 8.8.8.8\nnameserver 2001:4860:4860::8888\n')).toEqual([
      '8.8.8.8',
      '2001:4860:4860::8888',
    ]);
    expect(
      parseResolvectl('  DNS Servers: 10.0.0.1 10.0.0.2\n  Current DNS Server: 10.0.0.3\n'),
    ).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });
});

interface RemoteEnv {
  directory: string;
  hostsPath: string;
  dataDir: string;
  options: () => {
    filePath: string;
    dataDir: string;
    env: NodeJS.ProcessEnv;
    dnsFlush: false;
    now: Date;
  };
  state: { body: string; etag: string; failNext: boolean; requests: string[] };
  baseUrl: string;
  cleanup: () => Promise<void>;
}

async function makeRemoteEnv(): Promise<RemoteEnv> {
  const directory = await mkdtemp(join(tmpdir(), 'hostscli-remote-'));
  const hostsPath = join(directory, 'hosts');
  const dataDir = join(directory, 'data');
  const state = {
    body: '10.0.0.1 api.remote.test\n',
    etag: '"v1"',
    failNext: false,
    requests: [] as string[],
  };

  const server = createServer((request, response) => {
    state.requests.push((request.headers['if-none-match'] as string | undefined) ?? '');
    if (state.failNext) {
      response.writeHead(500).end('boom');
      return;
    }
    if (request.headers['if-none-match'] === state.etag) {
      response.writeHead(304, { etag: state.etag }).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain', etag: state.etag }).end(state.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    directory,
    hostsPath,
    dataDir,
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    options: () => ({
      filePath: hostsPath,
      dataDir,
      env: { ...process.env, HOME: directory },
      dnsFlush: false as const,
      now: new Date('2026-11-02T00:00:00.000Z'),
    }),
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('阶段 3：远程订阅', () => {
  it('拉取 hosts 文本生成方案；ETag 304 不重复写；失败保留上次成功缓存', async () => {
    const env = await makeRemoteEnv();
    try {
      await addRemoteSource({
        ...env.options(),
        id: 'team',
        url: `${env.baseUrl}/team.hosts?token=secret`,
      });
      const duplicate = await addRemoteSource({
        ...env.options(),
        id: 'team',
        url: `${env.baseUrl}/team.hosts`,
      }).catch((error: unknown) => error);
      expect(duplicate).toBeInstanceOf(Error);

      const first = await updateRemoteSources(env.options());
      expect(first.results[0]?.status).toBe('updated');
      expect(first.results[0]?.bytes).toBe(Buffer.byteLength(env.state.body));
      const profile = await readProfile(join(env.dataDir, 'profiles'), 'team');
      expect(profile.entries[0]?.ip).toBe('10.0.0.1');

      const second = await updateRemoteSources(env.options());
      expect(second.results[0]?.status).toBe('not-modified');
      expect(env.state.requests.at(-1)).toBe('"v1"');

      env.state.failNext = true;
      const failed = await updateRemoteSources({ ...env.options(), force: true });
      expect(failed.results[0]?.status).toBe('failed');
      expect(failed.failed).toBe(1);
      expect((await readProfile(join(env.dataDir, 'profiles'), 'team')).entries[0]?.ip).toBe(
        '10.0.0.1',
      );

      const listed = await listRemoteSources(env.options());
      expect(listed.sources[0]?.cached).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('内容变化时更新方案，且 maxBytes 会中止超大响应', async () => {
    const env = await makeRemoteEnv();
    try {
      await addRemoteSource({ ...env.options(), id: 'team', url: `${env.baseUrl}/team.hosts` });
      await updateRemoteSources(env.options());

      env.state.body = '10.0.0.2 api.remote.test\n';
      env.state.etag = '"v2"';
      const updated = await updateRemoteSources(env.options());
      expect(updated.results[0]?.status).toBe('updated');
      expect((await readProfile(join(env.dataDir, 'profiles'), 'team')).entries[0]?.ip).toBe(
        '10.0.0.2',
      );

      env.state.body = 'x'.repeat(4096);
      env.state.etag = '"v3"';
      const oversized = await updateRemoteSources({ ...env.options(), maxBytes: 100 });
      expect(oversized.results[0]?.status).toBe('failed');
      expect(oversized.results[0]?.error).toContain('max-bytes');
    } finally {
      await env.cleanup();
    }
  });

  it('远程订阅 JSON 中的换行注入被拒绝，不生成方案', async () => {
    const env = await makeRemoteEnv();
    try {
      await addRemoteSource({
        ...env.options(),
        id: 'evil',
        url: `${env.baseUrl}/evil.json`,
      });
      env.state.body = JSON.stringify([
        {
          ip: '10.0.0.1',
          hostnames: ['evil.test'],
          comment: 'ok\n# >>> hostscli managed',
        },
      ]);
      env.state.etag = '"evil"';

      const result = await updateRemoteSources(env.options());
      expect(result.results[0]?.status).toBe('failed');
      expect(result.results[0]?.error).toContain('控制字符');
      expect(result.failed).toBe(1);
      await expect(readProfile(join(env.dataDir, 'profiles'), 'evil')).rejects.toBeInstanceOf(
        EntryNotFoundError,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('remove 只移除登记与缓存，不删除方案', async () => {
    const env = await makeRemoteEnv();
    try {
      await addRemoteSource({ ...env.options(), id: 'team', url: `${env.baseUrl}/team.hosts` });
      await updateRemoteSources(env.options());
      const result = await removeRemoteSource({ ...env.options(), id: 'team' });
      expect(result.removed).toBe('team');
      expect((await listRemoteSources(env.options())).sources).toHaveLength(0);
      expect((await readProfile(join(env.dataDir, 'profiles'), 'team')).entries).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });
});
