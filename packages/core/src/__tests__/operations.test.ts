import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  DISABLED_ENTRY_PREFIX,
  DuplicateEntryError,
  END_MARKER,
  EntryNotFoundError,
  ExternalEntryError,
  HostsFormatError,
  InvalidInputError,
  PermissionError,
  StorageCorruptError,
  addHosts,
  createHostsBackup,
  createProfileFromCurrent,
  disableFor,
  initHosts,
  listHosts,
  listHostsBackups,
  listProfiles,
  listTtl,
  pauseTtl,
  removeHosts,
  removeProfile,
  restoreHostsBackup,
  restoreTtl,
  resumeTtl,
  setHostsEnabled,
  showConfig,
  showProfile,
  updateConfig,
  updateProfileMeta,
  useProfile,
  saveProfileFromCurrent,
  cancelTtl,
  extendTtl,
  tickTtl,
} from '../index';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function splitOutside(text: string): { prefix: string; suffix: string } {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin === -1 || end === -1) return { prefix: text, suffix: '' };
  return { prefix: text.slice(0, begin), suffix: text.slice(end) };
}

function assertOutsideUnchanged(before: string, after: string): void {
  const original = splitOutside(before);
  const current = splitOutside(after);
  expect(current.prefix).toBe(original.prefix);
  expect(current.suffix).toBe(original.suffix);
  expect(sha256(current.prefix)).toBe(sha256(original.prefix));
  expect(sha256(current.suffix)).toBe(sha256(original.suffix));
}

async function readText(path: string): Promise<string> {
  return (await readFile(path)).toString('utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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

const PLAIN_DOCUMENT = '# 用户内容\n127.0.0.1 localhost\n::1 localhost\n\n10.0.0.1 legacy\n';

const T0 = new Date('2026-11-02T00:00:00.000Z');

describe('CRUD 与非托管区不变量', () => {
  let directory: string;
  let hostsPath: string;
  let dataDir: string;
  let backupDir: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostscli-test-'));
    hostsPath = join(directory, 'hosts');
    dataDir = join(directory, 'data');
    backupDir = join(directory, 'backups');
  });

  afterEach(async () => {
    await chmod(hostsPath, 0o644).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  function options(now?: Date): {
    filePath: string;
    dataDir: string;
    backupDir: string;
    env: NodeJS.ProcessEnv;
    dnsFlush: false;
    now?: Date;
  } {
    return {
      filePath: hostsPath,
      dataDir,
      backupDir,
      env: { ...process.env, HOME: directory },
      dnsFlush: false,
      ...(now ? { now } : {}),
    };
  }

  it('list 区分托管 / 非托管、启用 / 禁用，并显示生效层', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);

    const snapshot = await listHosts(options());

    const managed = snapshot.entries.filter((entry) => entry.source === 'managed');
    const external = snapshot.entries.filter((entry) => entry.source === 'external');
    // 阶段 1 的禁用注释会被导入为禁用条目，因此托管来源有 3 条（含 1 条禁用）。
    expect(managed).toHaveLength(3);
    expect(managed.filter((entry) => !entry.enabled)).toHaveLength(1);
    expect(external).toHaveLength(2);
    expect(snapshot.activeLayers).toEqual(['default']);
    expect(snapshot.summary.managed).toBe(2);
  });

  it('add 追加托管区块，原文件字节保持不变，并生成备份', async () => {
    const source = Buffer.from(PLAIN_DOCUMENT);
    await writeFile(hostsPath, source);

    const result = await addHosts({
      ...options(),
      ip: '10.0.0.12',
      hostnames: ['api.example.com', 'www.example.com'],
      comment: '联调',
    });

    const after = await readFile(hostsPath);
    expect(after.subarray(0, source.length).equals(source)).toBe(true);

    const text = after.toString('utf8');
    expect(text).toContain(`${BEGIN_MARKER}\n`);
    expect(text).toContain('10.0.0.12  api.example.com  # 联调');
    expect(text).toContain(`${END_MARKER}\n`);
    expect(result.changed).toBe(true);
    expect(result.affected).toHaveLength(1);

    if (!result.backupPath) throw new Error('预期生成备份文件');
    expect((await readFile(result.backupPath)).equals(source)).toBe(true);
  });

  it('add 可以创建不存在的 hosts 文件', async () => {
    const result = await addHosts({
      ...options(),
      ip: '127.0.0.1',
      hostnames: ['local.example.com'],
    });

    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeNull();
    expect((await readText(hostsPath)).startsWith(BEGIN_MARKER)).toBe(true);
  });

  it('两个不同 dataDir 并发写同一 hosts 时两条规则都保留', async () => {
    await writeFile(hostsPath, PLAIN_DOCUMENT);
    const otherDataDir = join(directory, 'data-b');

    await Promise.all([
      addHosts({
        ...options(),
        dataDir,
        ip: '10.0.0.1',
        hostnames: ['from-a.test'],
      }),
      addHosts({
        ...options(),
        dataDir: otherDataDir,
        ip: '10.0.0.2',
        hostnames: ['from-b.test'],
      }),
    ]);

    const text = await readText(hostsPath);
    expect(text).toContain('10.0.0.1  from-a.test');
    expect(text).toContain('10.0.0.2  from-b.test');
  });

  it('add 检测重复项且不修改文件', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);
    const before = await readFile(hostsPath);

    await expect(
      addHosts({ ...options(), ip: '10.0.0.12', hostnames: ['api.example.com'] }),
    ).rejects.toBeInstanceOf(DuplicateEntryError);
    await expect(
      addHosts({ ...options(), ip: '10.0.0.13', hostnames: ['api.example.com'] }),
    ).rejects.toBeInstanceOf(DuplicateEntryError);

    expect((await readFile(hostsPath)).equals(before)).toBe(true);
  });

  it('remove 只改托管区，围栏外内容逐字节不变', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);

    const result = await removeHosts({ ...options(), hostnames: ['api.example.com'] });
    expect(result.warnings.some((warning) => warning.includes('同时影响'))).toBe(false);

    const text = await readText(hostsPath);
    assertOutsideUnchanged(MANAGED_DOCUMENT, text);
    expect(text).not.toContain('api.example.com');
    expect(text).toContain('www.example.com');
    expect(text).toContain('nas.local');
  });

  it('记录级操作会提示同条记录里的其他主机名', async () => {
    await writeFile(hostsPath, PLAIN_DOCUMENT);
    await addHosts({
      ...options(),
      ip: '10.0.0.12',
      hostnames: ['api.example.com', 'www.example.com'],
    });

    const result = await removeHosts({ ...options(), hostnames: ['api.example.com'] });
    expect(result.warnings.some((warning) => warning.includes('www.example.com'))).toBe(true);
    expect(await readText(hostsPath)).not.toContain('www.example.com');
  });

  it('remove 已禁用条目会修改方案数据并报告 changed=true', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);
    await setHostsEnabled({ ...options(), hostnames: ['api.example.com'], enabled: false });
    const before = await readFile(hostsPath);

    const result = await removeHosts({ ...options(), hostnames: ['api.example.com'] });
    expect(result.changed).toBe(true);
    expect(result.affected).toHaveLength(1);
    // hosts 字节不变（该条目本来就不在托管区），但方案里已经没有它。
    expect((await readFile(hostsPath)).equals(before)).toBe(true);
    const snapshot = await listHosts(options());
    expect(snapshot.entries.some((entry) => entry.hostnames.includes('api.example.com'))).toBe(
      false,
    );
  });

  it('remove 对非托管行只读，拒绝并保持文件不变', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);
    const before = await readFile(hostsPath);

    await expect(removeHosts({ ...options(), hostnames: ['nas.local'] })).rejects.toBeInstanceOf(
      ExternalEntryError,
    );

    expect((await readFile(hostsPath)).equals(before)).toBe(true);
  });

  it('disable 让条目退出托管区块（阶段 2 语义），enable 可恢复', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);

    const disabled = await setHostsEnabled({
      ...options(),
      hostnames: ['api.example.com'],
      enabled: false,
    });
    expect(disabled.changed).toBe(true);

    const text = await readText(hostsPath);
    assertOutsideUnchanged(MANAGED_DOCUMENT, text);
    expect(text).not.toContain('api.example.com');
    expect(text).toContain('www.example.com');

    const snapshot = await listHosts(options());
    const apiEntry = snapshot.entries.find((entry) => entry.hostnames.includes('api.example.com'));
    expect(apiEntry?.enabled).toBe(false);
    expect(snapshot.summary.disabled).toBeGreaterThanOrEqual(1);

    const reEnabled = await setHostsEnabled({
      ...options(),
      hostnames: ['api.example.com'],
      enabled: true,
    });
    expect(reEnabled.changed).toBe(true);
    expect(await readText(hostsPath)).toContain('10.0.0.12  api.example.com');
  });

  it('对已处于目标状态的条目返回 changed=false 且不写盘', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);
    await setHostsEnabled({ ...options(), hostnames: ['api.example.com'], enabled: false });
    const before = await readFile(hostsPath);

    const result = await setHostsEnabled({
      ...options(),
      hostnames: ['api.example.com'],
      enabled: false,
    });

    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(result.diff).toBe('');
    expect((await readFile(hostsPath)).equals(before)).toBe(true);
  });

  it('enable / disable 对非托管条目明确报错', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);

    await expect(
      setHostsEnabled({ ...options(), hostnames: ['nas.local'], enabled: false }),
    ).rejects.toBeInstanceOf(ExternalEntryError);
  });

  it('CRLF 文件的新增行使用 CRLF，且保持前缀字节', async () => {
    const source = '# a\r\n127.0.0.1 localhost\r\n';
    await writeFile(hostsPath, source);

    await addHosts({ ...options(), ip: '10.0.0.12', hostnames: ['api.example.com'] });

    const text = await readText(hostsPath);
    expect(text.startsWith(source)).toBe(true);
    expect(text).toContain(`${BEGIN_MARKER}\r\n`);
    expect(text).toContain('10.0.0.12  api.example.com\r\n');
  });

  it('保留 UTF-8 BOM', async () => {
    const body = Buffer.from('127.0.0.1 localhost\n');
    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
    await writeFile(hostsPath, source);

    await addHosts({ ...options(), ip: '10.0.0.12', hostnames: ['api.example.com'] });

    const after = await readFile(hostsPath);
    expect(after.subarray(0, source.length).equals(source)).toBe(true);
    expect(after[0]).toBe(0xef);
  });

  it('没有结尾换行的文件也能安全追加区块', async () => {
    const source = '127.0.0.1 localhost';
    await writeFile(hostsPath, source);

    await addHosts({ ...options(), ip: '10.0.0.12', hostnames: ['api.example.com'] });

    const text = await readText(hostsPath);
    expect(text.startsWith(source)).toBe(true);
    expect(text).toContain(`${source}\n${BEGIN_MARKER}`);
  });

  it('只读文件返回权限错误且不写入', async () => {
    // Windows 的 chmod 与 W_OK 语义不等于 POSIX；该分支由 CI 冒烟单独观察。
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const source = Buffer.from(PLAIN_DOCUMENT);
    await writeFile(hostsPath, source);
    await chmod(hostsPath, 0o444);

    await expect(
      addHosts({ ...options(), ip: '10.0.0.12', hostnames: ['api.example.com'] }),
    ).rejects.toBeInstanceOf(PermissionError);

    expect((await readFile(hostsPath)).equals(source)).toBe(true);
  });

  it('hosts 文件不存在时 list 报格式错误', async () => {
    await expect(listHosts(options())).rejects.toBeInstanceOf(HostsFormatError);
  });

  it('--dry-run 不写文件、不生成备份', async () => {
    const source = Buffer.from(PLAIN_DOCUMENT);
    await writeFile(hostsPath, source);

    const result = await addHosts({
      ...options(),
      ip: '10.0.0.12',
      hostnames: ['api.example.com'],
      dryRun: true,
    });

    expect(result.changed).toBe(true);
    expect(result.diff).toContain('+10.0.0.12  api.example.com');
    expect(result.backupPath).toBeNull();
    expect((await readFile(hostsPath)).equals(source)).toBe(true);
    expect(await exists(backupDir)).toBe(false);
  });

  it('init 插入空托管区块，重复执行幂等', async () => {
    const source = Buffer.from(PLAIN_DOCUMENT);
    await writeFile(hostsPath, source);

    const result = await initHosts(options());
    expect(result.changed).toBe(true);
    const after = await readFile(hostsPath);
    expect(after.subarray(0, source.length).equals(source)).toBe(true);
    expect(after.toString('utf8')).toContain(END_MARKER);

    const second = await initHosts(options());
    expect(second.changed).toBe(false);
    expect((await readFile(hostsPath)).equals(after)).toBe(true);
  });

  it('backup 可手动创建，restore 可按指定备份恢复且重复执行幂等', async () => {
    const source = Buffer.from(PLAIN_DOCUMENT);
    await writeFile(hostsPath, source);

    const backupPath = await createHostsBackup(options());
    expect((await readFile(backupPath)).equals(source)).toBe(true);

    await addHosts({ ...options(), ip: '10.0.0.12', hostnames: ['api.example.com'] });
    expect((await readFile(hostsPath)).equals(source)).toBe(false);

    const restored = await restoreHostsBackup({ ...options(), backupFile: backupPath });
    expect(restored.changed).toBe(true);
    expect(restored.restoredFrom).toBe(backupPath);
    expect((await readFile(hostsPath)).equals(source)).toBe(true);

    const second = await restoreHostsBackup({ ...options(), backupFile: backupPath });
    expect(second.changed).toBe(false);
  });

  it('restore 默认恢复最新备份，且备份按 mtime 排序', async () => {
    const first = `${PLAIN_DOCUMENT}# first\n`;
    const second = `${PLAIN_DOCUMENT}# second\n`;
    await writeFile(hostsPath, first);
    await createHostsBackup(options());
    await writeFile(hostsPath, second);
    await createHostsBackup(options());
    await writeFile(hostsPath, `${PLAIN_DOCUMENT}# current\n`);

    const { files } = await listHostsBackups(options());
    expect(files.length).toBeGreaterThanOrEqual(2);

    const restored = await restoreHostsBackup(options());
    expect(restored.changed).toBe(true);
    expect(restored.restoredFrom).toBe(files[0]);
    expect(await readText(hostsPath)).toBe(second);
  });

  it('截断/未闭合围栏的备份会被拒绝，hosts 保持原状', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);
    const backupPath = await createHostsBackup(options());
    const valid = await readText(backupPath);
    const cut = valid.indexOf(END_MARKER);
    expect(cut).toBeGreaterThan(-1);
    await writeFile(backupPath, valid.slice(0, cut));

    await writeFile(hostsPath, `${PLAIN_DOCUMENT}# changed\n`);
    const before = await readFile(hostsPath);

    await expect(
      restoreHostsBackup({ ...options(), backupFile: backupPath }),
    ).rejects.toMatchObject({ code: 'HOSTS_FORMAT' });
    expect((await readFile(hostsPath)).equals(before)).toBe(true);
  });

  it('restore 写后状态落盘失败时回滚 hosts', async () => {
    // Windows 不支持用 POSIX mode 制造只写失败；容器内默认 root 也会绕过 0500。
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    await writeFile(hostsPath, PLAIN_DOCUMENT);
    const backupPath = await createHostsBackup(options());
    const current = `${PLAIN_DOCUMENT}10.0.0.99 current.test\n`;
    await writeFile(hostsPath, current);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(dataDir, 0o500);

    try {
      await expect(
        restoreHostsBackup({ ...options(), backupFile: backupPath }),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await chmod(dataDir, 0o700);
    }
    expect((await readFile(hostsPath)).equals(Buffer.from(current))).toBe(true);
  });

  it('备份文件原子写入，不残留临时文件', async () => {
    await writeFile(hostsPath, MANAGED_DOCUMENT);
    await createHostsBackup(options());
    const names = await readdir(backupDir);
    expect(names.filter((name) => name.includes('.hostscli-'))).toEqual([]);
  });
});

describe('方案（profile）与切换', () => {
  let directory: string;
  let hostsPath: string;
  let dataDir: string;
  let backupDir: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostscli-profile-'));
    hostsPath = join(directory, 'hosts');
    dataDir = join(directory, 'data');
    backupDir = join(directory, 'backups');
    await writeFile(hostsPath, MANAGED_DOCUMENT);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function options(now?: Date): {
    filePath: string;
    dataDir: string;
    backupDir: string;
    dnsFlush: false;
    now?: Date;
  } {
    return {
      filePath: hostsPath,
      dataDir,
      backupDir,
      dnsFlush: false,
      ...(now ? { now } : {}),
    };
  }

  it('create --from-current → use → add --layer → 切回 default', async () => {
    await addHosts({ ...options(), ip: '10.0.0.50', hostnames: ['local.example.com'] });

    const dev = await createProfileFromCurrent({ ...options(), id: 'dev', fromCurrent: true });
    expect(dev.entries).toHaveLength(3);

    const used = await useProfile({ ...options(), id: 'dev' });
    expect(used.changed).toBe(false);
    expect((await listProfiles(options())).activeLayers).toEqual(['dev']);
    expect((await listHosts(options())).activeLayers).toEqual(['dev']);

    await addHosts({
      ...options(),
      ip: '10.0.0.60',
      hostnames: ['only-dev.example.com'],
      layerId: 'dev',
    });
    expect(await readText(hostsPath)).toContain('only-dev.example.com');

    await useProfile({ ...options(), id: 'default' });
    expect(await readText(hostsPath)).not.toContain('only-dev.example.com');
    expect((await listProfiles(options())).activeLayers).toEqual(['default']);
  });

  it('use 幂等：重复切换不写盘也不产生备份', async () => {
    await createProfileFromCurrent({ ...options(), id: 'default', fromCurrent: true });
    await useProfile({ ...options(), id: 'default' });
    await useProfile({ ...options(), id: 'default' });
    const before = await readFile(hostsPath);

    const second = await useProfile({ ...options(), id: 'default' });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect((await readFile(hostsPath)).equals(before)).toBe(true);
  });

  it('save 把当前托管区块写回生效方案', async () => {
    await createProfileFromCurrent({ ...options(), id: 'default', fromCurrent: true });
    await useProfile({ ...options(), id: 'default' });
    await addHosts({ ...options(), ip: '10.0.0.70', hostnames: ['saved.example.com'] });

    const saved = await saveProfileFromCurrent({ ...options(), id: 'default' });
    expect(saved.entries.some((entry) => entry.hostnames.includes('saved.example.com'))).toBe(true);
  });

  it('profile save 默认保留被 TTL 隐藏的条目，--prune 才删除', async () => {
    await createProfileFromCurrent({ ...options(), id: 'default', fromCurrent: true });
    await disableFor({ ...options(), hostnames: ['api.example.com'], for: '1m' });

    const saved = await saveProfileFromCurrent({ ...options(), id: 'default' });
    expect(saved.entries).toHaveLength(3);
    expect(saved.entries.some((entry) => entry.hostnames.includes('api.example.com'))).toBe(true);

    const pruned = await saveProfileFromCurrent({ ...options(), id: 'default', prune: true });
    expect(pruned.entries).toHaveLength(1);
    expect(pruned.entries.some((entry) => entry.hostnames.includes('api.example.com'))).toBe(false);
  });

  it('update 元信息会按新优先级重建；active 方案不可删除，非 active 可删除', async () => {
    await createProfileFromCurrent({ ...options(), id: 'default', fromCurrent: true });
    await useProfile({ ...options(), id: 'default' });
    const dev = await createProfileFromCurrent({ ...options(), id: 'dev', fromCurrent: true });
    expect(dev.entries).toHaveLength(2);

    const updated = await updateProfileMeta('default', { priority: 5 }, options());
    expect(updated.priority).toBe(5);

    await expect(removeProfile('default', options())).rejects.toBeInstanceOf(InvalidInputError);
    await removeProfile('dev', options());
    await expect(showProfile('dev', options())).rejects.toBeInstanceOf(EntryNotFoundError);
  });

  it('update 拒绝空名称与 NaN 优先级，且不落盘', async () => {
    await createProfileFromCurrent({ ...options(), id: 'default', fromCurrent: true });
    const profilePath = join(dataDir, 'profiles', 'default.json');
    const before = await readFile(profilePath);

    await expect(updateProfileMeta('default', { name: '   ' }, options())).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      updateProfileMeta('default', { priority: Number.NaN }, options()),
    ).rejects.toBeInstanceOf(InvalidInputError);

    expect((await readFile(profilePath)).equals(before)).toBe(true);
  });

  it('拒绝目录穿越式方案 ID', async () => {
    await expect(createProfileFromCurrent({ ...options(), id: '../evil' })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});

describe('单条 TTL', () => {
  let directory: string;
  let hostsPath: string;
  let dataDir: string;
  let backupDir: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostscli-ttl-'));
    hostsPath = join(directory, 'hosts');
    dataDir = join(directory, 'data');
    backupDir = join(directory, 'backups');
    await writeFile(hostsPath, MANAGED_DOCUMENT);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function options(now?: Date): {
    filePath: string;
    dataDir: string;
    backupDir: string;
    dnsFlush: false;
    now?: Date;
  } {
    return {
      filePath: hostsPath,
      dataDir,
      backupDir,
      dnsFlush: false,
      ...(now ? { now } : {}),
    };
  }

  it('到期后由下一次命令惰性恢复（验收 1）', async () => {
    await disableFor({
      ...options(T0),
      hostnames: ['api.example.com'],
      for: '1m',
      reason: '联调',
    });

    const disabled = await readText(hostsPath);
    assertOutsideUnchanged(MANAGED_DOCUMENT, disabled);
    expect(disabled).not.toContain('api.example.com');

    const beforeDue = await listTtl(options(new Date(T0.getTime() + 30_000)));
    expect(beforeDue.records).toHaveLength(1);
    expect(beforeDue.records[0]?.remainingMs).toBe(30_000);

    const snapshot = await listHosts(options(new Date(T0.getTime() + 120_000)));
    expect(snapshot.entries.some((entry) => entry.hostnames.includes('api.example.com'))).toBe(
      true,
    );

    const after = await listTtl(options(new Date(T0.getTime() + 120_000)));
    expect(after.records).toHaveLength(0);
    expect(await readText(hostsPath)).toContain('10.0.0.12  api.example.com');
  });

  it('ttl disable 后再 add 另一条规则，到期结算仍能恢复', async () => {
    await disableFor({
      ...options(T0),
      hostnames: ['api.example.com'],
      for: '1h',
    });
    await addHosts({
      ...options(T0),
      ip: '10.0.0.50',
      hostnames: ['another.test'],
    });

    const due = new Date(T0.getTime() + 3_600_000);
    const restored = await listHosts(options(due));

    expect(restored.entries.some((entry) => entry.hostnames.includes('api.example.com'))).toBe(
      true,
    );
    expect(await readText(hostsPath)).toContain('10.0.0.12  api.example.com');
    expect((await listTtl(options(due))).records).toHaveLength(0);
  });

  it('disable --for 多主机名整体拒绝，不会只对第一条生效', async () => {
    await expect(
      disableFor({
        ...options(T0),
        hostnames: ['api.example.com', 'www.example.com'],
        for: '1m',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect((await listTtl(options(T0))).records).toHaveLength(0);
    const text = await readText(hostsPath);
    expect(text).toContain('10.0.0.12  api.example.com');
    expect(text).toContain('10.0.0.12  www.example.com');
  });

  it('list 正常路径只读；TTL 到期时会惰性结算并写回', async () => {
    const idle = await readFile(hostsPath);
    await listHosts(options(T0));
    expect((await readFile(hostsPath)).equals(idle)).toBe(true);

    await disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '1m' });
    const beforeDue = await readFile(hostsPath);
    await listHosts(options(new Date(T0.getTime() + 60_000)));

    // 文档不再声称 list 是纯只读：到期 TTL 会经 prepare → reconcileTtls 写回。
    expect((await readFile(hostsPath)).equals(beforeDue)).toBe(false);
    expect(await readText(hostsPath)).toContain('10.0.0.12  api.example.com');
    expect((await listTtl(options(new Date(T0.getTime() + 60_000)))).records).toHaveLength(0);
  });

  it('pause 后跨过 expiresAt 不恢复，resume 后按剩余时间继续（验收 2）', async () => {
    await disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '1m' });

    const paused = await pauseTtl({
      ...options(new Date(T0.getTime() + 30_000)),
      hostname: 'api.example.com',
    });
    expect(paused.paused).toBe(true);
    expect(paused.remainingMs).toBe(30_000);

    const stillDisabled = await listHosts(options(new Date(T0.getTime() + 120_000)));
    expect(
      stillDisabled.entries.some(
        (entry) => entry.hostnames.includes('api.example.com') && entry.enabled,
      ),
    ).toBe(false);
    const list = await listTtl(options(new Date(T0.getTime() + 120_000)));
    expect(list.records[0]?.record.paused).toBe(true);

    const resumed = await resumeTtl({
      ...options(new Date(T0.getTime() + 120_000)),
      hostname: 'api.example.com',
    });
    expect(resumed.paused).toBe(false);

    const restored = await listHosts(options(new Date(T0.getTime() + 160_000)));
    expect(restored.entries.some((entry) => entry.hostnames.includes('api.example.com'))).toBe(
      true,
    );
  });

  it('extend 重置到期时间', async () => {
    await disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '1m' });

    const extended = await extendTtl({
      ...options(new Date(T0.getTime() + 30_000)),
      hostname: 'api.example.com',
      duration: '2h',
    });
    expect(Date.parse(extended.expiresAt)).toBe(T0.getTime() + 30_000 + 2 * 3_600_000);

    const midway = await listHosts(options(new Date(T0.getTime() + 180_000)));
    expect(
      midway.entries.some((entry) => entry.hostnames.includes('api.example.com') && entry.enabled),
    ).toBe(false);

    const later = await listHosts(options(new Date(T0.getTime() + 3 * 3_600_000)));
    expect(later.entries.some((entry) => entry.hostnames.includes('api.example.com'))).toBe(true);
  });

  it('restore 立即恢复；cancel 转为普通禁用（验收状态机）', async () => {
    await disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '1m' });

    const restored = await restoreTtl({
      ...options(new Date(T0.getTime() + 10_000)),
      hostname: 'api.example.com',
    });
    expect(restored.changed).toBe(true);
    expect(await readText(hostsPath)).toContain('10.0.0.12  api.example.com');

    await disableFor({ ...options(T0), hostnames: ['www.example.com'], for: '1m' });
    const cancelled = await cancelTtl({
      ...options(new Date(T0.getTime() + 10_000)),
      hostname: 'www.example.com',
    });
    expect(cancelled.changed).toBe(false);
    expect(await readText(hostsPath)).not.toContain('www.example.com');
    expect((await listTtl(options(new Date(T0.getTime() + 10_000)))).records).toHaveLength(0);
    expect(
      (await listHosts(options(new Date(T0.getTime() + 10_000)))).summary.disabled,
    ).toBeGreaterThan(0);
  });

  it('托管区被外部修改时转为 pending，ttl resolve 可强制恢复', async () => {
    await disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '1m' });

    const withExternal = `${await readText(hostsPath)}\n# 外部新增\n10.1.1.1 external.example.com\n`;
    await writeFile(hostsPath, withExternal);

    const snapshot = await listHosts(options(new Date(T0.getTime() + 120_000)));
    expect(
      snapshot.entries.some(
        (entry) => entry.hostnames.includes('api.example.com') && entry.enabled,
      ),
    ).toBe(false);
    expect(snapshot.warnings.some((warning) => warning.includes('ttl resolve'))).toBe(true);

    const pending = await listTtl(options(new Date(T0.getTime() + 120_000)));
    expect(pending.records[0]?.record.status).toBe('pending');

    await restoreTtl({ ...options(new Date(T0.getTime() + 120_000)), hostname: 'api.example.com' });
    const text = await readText(hostsPath);
    expect(text).toContain('10.0.0.12  api.example.com');
    expect(text).toContain('external.example.com');
  });

  it('ttl tick 可独立结算到期记录', async () => {
    await disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '1m' });
    const result = await tickTtl(options(new Date(T0.getTime() + 120_000)));
    expect(result.restored).toHaveLength(1);
    expect(await readText(hostsPath)).toContain('10.0.0.12  api.example.com');
  });

  it('disable --for 对非托管行报错且文件不变，dry-run 不写盘', async () => {
    const before = await readFile(hostsPath);

    await expect(
      disableFor({ ...options(T0), hostnames: ['nas.local'], for: '1m' }),
    ).rejects.toBeInstanceOf(ExternalEntryError);
    expect((await readFile(hostsPath)).equals(before)).toBe(true);

    const preview = await disableFor({
      ...options(T0),
      hostnames: ['api.example.com'],
      for: '1m',
      dryRun: true,
    });
    expect(preview.changed).toBe(true);
    expect(preview.backupPath).toBeNull();
    expect((await readFile(hostsPath)).equals(before)).toBe(true);
    expect((await listTtl(options(T0))).records).toHaveLength(0);
  });

  it('超过阈值且未确认时拒绝执行', async () => {
    await expect(
      disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '8d' }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    await disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '8d', yes: true });
    expect((await listTtl(options(T0))).records).toHaveLength(1);
  });

  it('已有 TTL 的条目再次设置会提示使用 extend / restore', async () => {
    await disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '1m' });
    await expect(
      disableFor({ ...options(T0), hostnames: ['api.example.com'], for: '2m' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('存储与配置健壮性', () => {
  let directory: string;
  let hostsPath: string;
  let dataDir: string;
  let backupDir: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostscli-storage-'));
    hostsPath = join(directory, 'hosts');
    dataDir = join(directory, 'data');
    backupDir = join(directory, 'backups');
    await writeFile(hostsPath, PLAIN_DOCUMENT);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function options(): {
    filePath: string;
    dataDir: string;
    backupDir: string;
    env: NodeJS.ProcessEnv;
    dnsFlush: false;
  } {
    return {
      filePath: hostsPath,
      dataDir,
      backupDir,
      env: { ...process.env, HOME: directory },
      dnsFlush: false,
    };
  }

  it('state.json 损坏时拒绝继续，不覆盖文件', async () => {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dataDir, { recursive: true }));
    await writeFile(join(dataDir, 'state.json'), '{ broken');

    await expect(listHosts(options())).rejects.toBeInstanceOf(StorageCorruptError);
    expect(await readText(hostsPath)).toBe(PLAIN_DOCUMENT);
  });

  it('config.json 损坏时拒绝继续', async () => {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dataDir, { recursive: true }));
    await writeFile(join(dataDir, 'config.json'), '{ broken');

    await expect(showConfig(options())).rejects.toBeInstanceOf(StorageCorruptError);
  });

  it('config set / show 可读写，非法值被拒绝', async () => {
    const updated = await updateConfig('defaults.backupKeep', '5', options());
    expect(updated.config.defaults.backupKeep).toBe(5);

    const shown = await showConfig(options());
    expect(shown.config.defaults.backupKeep).toBe(5);

    await expect(updateConfig('defaults.dnsFlush', 'nope', options())).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(updateConfig('ttl.tickInterval', '30s', options())).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('config 支持 hostsPath 与 ~ 展开', async () => {
    await updateConfig('hostsPath', '~/custom-hosts', options());
    const shown = await showConfig(options());
    expect(shown.config.hostsPath).toBe(join(directory, 'custom-hosts'));
  });
});
