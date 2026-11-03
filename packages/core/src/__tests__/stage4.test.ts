import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  END_MARKER,
  HostsCliError,
  addStackLayer,
  appendAudit,
  applyStack,
  detectNetwork,
  exportSnapshot,
  gitDiff,
  gitInit,
  gitLog,
  gitRollback,
  gitSnapshot,
  gitStatusOf,
  listNetworkMappings,
  mapNetwork,
  networkAuto,
  networkStatus,
  parseAirportNetwork,
  parseNmcliWifi,
  parseWifiDevices,
  readAudit,
  readProfile,
  snapshotToJson,
  unmapNetwork,
  verifyManagedEntries,
} from '../index';
import type { NetworkInfo } from '../index';

const HOSTS = [
  '# keep this byte-for-byte',
  '127.0.0.1 localhost',
  '',
  BEGIN_MARKER,
  '10.0.0.12 api.example.com',
  END_MARKER,
  '',
  '192.168.1.1 nas.local',
  '',
].join('\n');

interface Env {
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

async function makeEnv(initial = HOSTS): Promise<Env> {
  const directory = await mkdtemp(join(tmpdir(), 'hostscli-stage4-'));
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

async function addLayer(env: Env, id: string, ip: string, priority = 10): Promise<void> {
  const source = join(env.directory, `${id}.hosts`);
  await writeFile(source, `${ip} api.example.com\n`);
  await addStackLayer({
    ...env.options(),
    id,
    file: source,
    priority,
    force: true,
  });
}

describe('阶段 4：写入后解析验证', () => {
  it('按主机名去重、限制抽查数量，并把不匹配的解析记为失败', async () => {
    const entries = [
      {
        id: 'e1',
        ip: '10.0.0.1',
        hostnames: ['a.example.com', 'b.example.com'],
        enabled: true,
        source: 'managed' as const,
        layerId: 'l1',
      },
      {
        id: 'e2',
        ip: '10.0.0.2',
        hostnames: ['b.example.com'],
        enabled: true,
        source: 'managed' as const,
        layerId: 'l1',
      },
    ];

    const result = await verifyManagedEntries(
      entries,
      { maxHostnames: 1, timeoutMs: 100 },
      {
        lookup: async (hostname) =>
          hostname === 'a.example.com'
            ? [{ address: '10.0.0.1', family: 4 }]
            : [{ address: '10.9.9.9', family: 4 }],
      },
    );

    expect(result.checked).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.ok).toBe(true);

    const failed = await verifyManagedEntries(
      entries,
      { maxHostnames: 2, timeoutMs: 100 },
      { lookup: async () => [{ address: '10.9.9.9', family: 4 }] },
    );
    expect(failed.ok).toBe(false);
    expect(failed.failures[0]?.hostname).toBe('a.example.com');
    expect(failed.failures[0]?.expected).toBe('10.0.0.1');
    expect(failed.failures[0]?.actual).toEqual(['10.9.9.9']);
  });

  it('验证失败时回滚 hosts、保留围栏外内容并写入 audit', async () => {
    const env = await makeEnv();
    try {
      await addLayer(env, 'office', '10.10.10.5');
      const before = await readFile(env.hostsPath, 'utf8');

      await expect(
        applyStack({
          ...env.options(),
          verify: true,
          verifyLookup: async () => [{ address: '203.0.113.9', family: 4 }],
        }),
      ).rejects.toBeInstanceOf(HostsCliError);

      expect(await readFile(env.hostsPath, 'utf8')).toBe(before);
      const audit = await readAudit(join(env.dataDir, 'audit.log'), 10);
      expect(audit.at(-1)?.action).toBe('verify-rollback');
      expect(audit.at(-1)?.ok).toBe(false);
      expect(audit.at(-1)?.failures?.[0]?.hostname).toBe('api.example.com');
    } finally {
      await env.cleanup();
    }
  });

  it('验证通过后写入成功并记录 verify-ok', async () => {
    const env = await makeEnv();
    try {
      await addLayer(env, 'office', '10.10.10.5');
      const result = await applyStack({
        ...env.options(),
        verify: true,
        verifyLookup: async () => [{ address: '10.10.10.5', family: 4 }],
      });
      expect(result.changed).toBe(true);

      const text = await readFile(env.hostsPath, 'utf8');
      expect(text).toMatch(/10\.10\.10\.5\s+api\.example\.com/);
      expect(text.startsWith('# keep this byte-for-byte\n127.0.0.1 localhost\n')).toBe(true);
      expect(text).toContain('192.168.1.1 nas.local');

      const audit = await readAudit(join(env.dataDir, 'audit.log'), 10);
      expect(audit.at(-1)?.action).toBe('verify-ok');
      expect(audit.at(-1)?.checked).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  it('audit 读取会跳过损坏行，且限制条数参数有校验', async () => {
    const env = await makeEnv();
    try {
      const auditPath = join(env.dataDir, 'audit.log');
      await appendAudit(auditPath, {
        at: '2026-11-02T00:00:00.000Z',
        action: 'verify-ok',
        ok: true,
        hostsPath: env.hostsPath,
      });
      await appendAudit(auditPath, {
        at: '2026-11-02T00:00:01.000Z',
        action: 'write-rollback',
        ok: false,
        hostsPath: env.hostsPath,
      });
      const raw = await readFile(auditPath, 'utf8');
      await writeFile(auditPath, `${raw}{not-json}\n`);

      const entries = await readAudit(auditPath, 2);
      expect(entries.map((entry) => entry.action)).toEqual(['verify-ok', 'write-rollback']);
      // Windows 的 POSIX mode 位不可靠。
      if (process.platform !== 'win32') {
        expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await env.cleanup();
    }
  });
});

describe('阶段 4：网络环境识别与切换', () => {
  it('解析 macOS / Linux 网络命令输出', () => {
    const ports = [
      'Hardware Port: Ethernet',
      'Device: en1',
      '',
      'Hardware Port: Wi-Fi',
      'Device: en0',
    ].join('\n');
    expect(parseWifiDevices(ports)).toEqual(['en0']);
    expect(parseAirportNetwork('Current Wi-Fi Network: Office-5G\n')).toBe('Office-5G');
    expect(parseAirportNetwork('You are not associated with an AirPort network.\n')).toBeNull();
    expect(parseNmcliWifi('no:Home\nyes:Office-5G\n')).toBe('Office-5G');
    // nmcli 用反斜杠转义 SSID 中的冒号。
    expect(parseNmcliWifi('yes:Office\\:5G\n')).toBe('Office:5G');
  });

  it('通过注入 runner 识别当前 SSID；Windows 明确标记不支持', async () => {
    const darwin = await detectNetwork('darwin', async (command, args) => {
      if (command === 'networksetup' && args[0] === '-listallhardwareports') {
        return 'Hardware Port: Wi-Fi\nDevice: en0\n';
      }
      if (args[0] === '-getairportnetwork') return 'Current Wi-Fi Network: Office-5G\n';
      return '';
    });
    expect(darwin).toMatchObject({ supported: true, ssid: 'Office-5G', source: 'networksetup' });

    const linux = await detectNetwork('linux', async (command) => {
      if (command === 'iwgetid') throw new Error('missing');
      return 'yes:Office-5G\n';
    });
    expect(linux).toMatchObject({ supported: true, ssid: 'Office-5G', source: 'nmcli' });

    const win = await detectNetwork('win32');
    expect(win.supported).toBe(false);
    expect(win.source).toBe('unsupported');
  });

  it('映射 CRUD；auto 默认 dry-run，--apply 后才写入 hosts', async () => {
    const env = await makeEnv();
    try {
      await addLayer(env, 'office', '10.10.10.5');
      await mapNetwork({ ...env.options(), ssid: 'Office-5G', layers: ['office'] });

      const status = await networkStatus({
        ...env.options(),
        detect: async () => ({
          supported: true,
          ssid: 'Office-5G',
          platform: 'darwin',
          source: 'networksetup',
        }),
      });
      expect(status.mapping?.layers).toEqual(['office']);

      const before = await readFile(env.hostsPath, 'utf8');
      const preview = await networkAuto({
        ...env.options(),
        dryRun: true,
        detect: async () => ({
          supported: true,
          ssid: 'Office-5G',
          platform: 'darwin',
          source: 'networksetup',
        }),
      });
      expect(preview.dryRun).toBe(true);
      expect(preview.mutation).toBeNull();
      expect(await readFile(env.hostsPath, 'utf8')).toBe(before);

      const applied = await networkAuto({
        ...env.options(),
        detect: async () => ({
          supported: true,
          ssid: 'Office-5G',
          platform: 'darwin',
          source: 'networksetup',
        }),
      });
      expect(applied.mutation?.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toMatch(/10\.10\.10\.5\s+api\.example\.com/);

      await unmapNetwork({ ...env.options(), ssid: 'Office-5G' });
      const after = await networkStatus({
        ...env.options(),
        detect: async () => ({
          supported: true,
          ssid: 'Office-5G',
          platform: 'darwin',
          source: 'networksetup',
        }),
      });
      expect(after.mapping).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  it('非法层 ID 直接拒绝且不落盘；空映射给出清空警告', async () => {
    const env = await makeEnv();
    try {
      await expect(
        mapNetwork({ ...env.options(), ssid: 'Office-5G', layers: ['../evil'] }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await listNetworkMappings(env.options())).mappings).toHaveLength(0);

      const empty = await mapNetwork({ ...env.options(), ssid: 'Home', layers: [] });
      expect(empty.warnings.some((warning) => warning.includes('清空'))).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('未配置映射时 auto 给出可执行的下一步提示', async () => {
    const env = await makeEnv();
    try {
      const info: NetworkInfo = {
        supported: true,
        ssid: 'Home',
        platform: 'darwin',
        source: 'networksetup',
      };
      await expect(
        networkAuto({ ...env.options(), detect: async () => info }),
      ).rejects.toBeInstanceOf(HostsCliError);
    } finally {
      await env.cleanup();
    }
  });
});

describe('阶段 4：数据目录 git 快照', () => {
  it('init / snapshot / log / diff / rollback 全流程，回滚后重建 hosts', async () => {
    const env = await makeEnv();
    try {
      await addLayer(env, 'office', '10.10.10.5', 10);
      const initialized = await gitInit(env.options());
      expect(initialized.initialized).toBe(true);
      expect(initialized.gitDir.endsWith('.git')).toBe(true);

      const snapshot = await gitSnapshot({ ...env.options(), message: 'before change' });
      expect(snapshot.created).toBe(true);
      expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);

      await addLayer(env, 'office', '10.20.20.5', 10);
      const dirty = await gitStatusOf(env.options());
      expect(dirty.dirty).toBe(true);

      const diff = await gitDiff({
        ...env.options(),
        rev: (snapshot.commit as string).slice(0, 7),
      });
      expect(diff.diff).toContain('10.20.20.5');

      const rolled = await gitRollback({
        ...env.options(),
        rev: (snapshot.commit as string).slice(0, 7),
      });
      expect(rolled.restored).toBe(snapshot.commit);
      expect(rolled.mutation?.changed).toBe(true);
      // 回滚前有一个未快照变更，必须先自动保存为保护快照，避免历史里找不回。
      expect(rolled.safetyCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(rolled.warnings.some((warning) => warning.includes('保护快照'))).toBe(true);

      const profile = await readProfile(join(env.dataDir, 'profiles'), 'office');
      expect(profile.entries[0]?.ip).toBe('10.10.10.5');
      const hostsText = await readFile(env.hostsPath, 'utf8');
      expect(hostsText).toMatch(/10\.10\.10\.5\s+api\.example\.com/);
      expect(hostsText).not.toContain('10.20.20.5');
      expect(hostsText.startsWith('# keep this byte-for-byte\n')).toBe(true);

      // git 不记录权限位，回滚后必须由程序收紧到 0600。
      // Windows 的 POSIX mode 位不可靠，跳过该断言。
      if (process.platform !== 'win32') {
        for (const path of [
          join(env.dataDir, 'state.json'),
          join(env.dataDir, 'profiles', 'office.json'),
        ]) {
          expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
      }

      const log = await gitLog({ ...env.options(), limit: 5 });
      expect(log.entries).toHaveLength(3);
      expect(log.entries[0]?.subject).toContain('rollback to');
      expect(log.entries[1]?.subject).toContain('auto snapshot before rollback');
      expect(log.entries[2]?.subject).toBe('before change');
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  it('没有快照时 diff / rollback 返回可操作的 INVALID_INPUT', async () => {
    const env = await makeEnv();
    try {
      await gitInit(env.options());
      await expect(gitDiff(env.options())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        gitRollback({ ...env.options(), rev: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      await env.cleanup();
    }
  });

  it('拒绝非法的版本参数，避免 git 参数注入', async () => {
    const env = await makeEnv();
    try {
      await expect(gitRollback({ ...env.options(), rev: '--all' })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(gitDiff({ ...env.options(), rev: 'HEAD~1' })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    } finally {
      await env.cleanup();
    }
  });

  it('已存在但没有标记的 .git 目录会被拒绝', async () => {
    const env = await makeEnv();
    try {
      const gitDir = join(env.dataDir, '.git');
      await mkdir(gitDir, { recursive: true });
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

      await expect(gitInit(env.options())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      await env.cleanup();
    }
  });
});

describe('阶段 4：数据导出', () => {
  it('导出 config / state / profiles，JSON 可解析且不含 audit/cache', async () => {
    const env = await makeEnv();
    try {
      await addLayer(env, 'office', '10.10.10.5', 20);
      const snapshot = await exportSnapshot(env.options());

      expect(snapshot.schemaVersion).toBe(1);
      expect(snapshot.hostsPath).toBe(env.hostsPath);
      expect(snapshot.platform.length).toBeGreaterThan(0);
      expect(snapshot.profiles.map((profile) => profile.id)).toEqual(['office']);
      expect(snapshot.state.activeLayers).toEqual(['office']);
      expect(snapshot.config.network.mappings).toEqual([]);

      const text = snapshotToJson(snapshot);
      expect(text.endsWith('\n')).toBe(true);
      expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, hostsPath: env.hostsPath });
      expect(text).not.toContain('audit');
      expect(text).not.toContain('backups');
    } finally {
      await env.cleanup();
    }
  });
});
