import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readJsonOrDefault } from '../storage/json';
import { adoptDataDirOwnership, sudoDataOwner } from '../storage/paths';

describe('sudo 数据目录属主判定', () => {
  const euid = 501;
  const env = { SUDO_UID: String(euid), SUDO_GID: '20' };

  it('非 root、缺 SUDO_UID 或非法值时一律不改属主', () => {
    expect(sudoDataOwner({ dataDir: '/tmp/data', euid: 501, env })).toBeNull();
    expect(sudoDataOwner({ dataDir: '/tmp/data', euid: 0, env: {} })).toBeNull();
    expect(
      sudoDataOwner({ dataDir: '/tmp/data', euid: 0, env: { SUDO_UID: 'abc', SUDO_GID: '20' } }),
    ).toBeNull();
  });

  it('根目录不在调用者家目录内时不改属主', () => {
    expect(
      sudoDataOwner({
        dataDir: '/var/lib/hostscli',
        euid: 0,
        env,
        homeDir: '/Users/javen',
        homeOwnerUid: euid,
      }),
    ).toBeNull();
  });

  it('数据目录位于调用者家目录内时归还给 SUDO_UID', () => {
    expect(
      sudoDataOwner({
        dataDir: '/Users/javen/.hostscli',
        euid: 0,
        env,
        homeDir: '/Users/javen',
        homeOwnerUid: euid,
      }),
    ).toEqual({ uid: euid, gid: 20 });
  });

  it('HOME 属主不是 SUDO_UID（Linux sudo 的 /root）时保持 root', () => {
    expect(
      sudoDataOwner({
        dataDir: '/root/.hostscli',
        euid: 0,
        env,
        homeDir: '/root',
        homeOwnerUid: 0,
      }),
    ).toBeNull();
  });
});

describe('sudo 数据目录属主归还', () => {
  it('owner 为 null 时完全不遍历、不调用 chown', async () => {
    const calls: string[] = [];
    const changed = await adoptDataDirOwnership('/tmp/nowhere', null, {
      ownerOf: async () => ({ uid: 0, gid: 0 }),
      chown: async (path) => {
        calls.push(path);
      },
    });
    expect(changed).toBe(0);
    expect(calls).toEqual([]);
  });

  it('把 root 属主的目录与文件逐个归还，符号链接跳过', async () => {
    if (process.platform === 'win32') return;

    const dir = await mkdtemp(join(tmpdir(), 'hostscli-own-'));
    await mkdir(join(dir, 'backups'));
    await writeFile(join(dir, 'state.json'), '{}\n');
    await writeFile(join(dir, 'backups', 'hosts.bak'), 'x\n');
    const { symlink } = await import('node:fs/promises');
    await symlink(join(dir, 'state.json'), join(dir, 'state.link'));

    const calls: string[] = [];
    try {
      const changed = await adoptDataDirOwnership(
        dir,
        { uid: 501, gid: 20 },
        {
          ownerOf: async () => ({ uid: 0, gid: 0 }),
          chown: async (path) => {
            calls.push(path);
          },
        },
      );
      expect(changed).toBe(4);
      expect(calls.sort()).toEqual(
        [
          dir,
          join(dir, 'state.json'),
          join(dir, 'backups'),
          join(dir, 'backups', 'hosts.bak'),
        ].sort(),
      );
      expect(calls.some((path) => path.endsWith('.link'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('属主已经一致时不重复 chown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hostscli-own-'));
    await writeFile(join(dir, 'state.json'), '{}\n');
    const calls: string[] = [];
    try {
      const changed = await adoptDataDirOwnership(
        dir,
        { uid: 501, gid: 20 },
        {
          ownerOf: async () => ({ uid: 501, gid: 20 }),
          chown: async (path) => {
            calls.push(path);
          },
        },
      );
      expect(changed).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('数据文件读取被拒时的错误信息', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '同时报出属主、当前 euid 与 chown 命令',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hostscli-eacces-'));
      const file = join(dir, 'state.json');
      await writeFile(file, '{"schemaVersion":1}\n');
      await chmod(file, 0o000);
      try {
        const schema = z.object({}).passthrough();
        const error = await readJsonOrDefault(file, schema, () => ({})).catch((reason) => reason);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain(`属主 uid=${process.getuid?.()}`);
        expect(message).toContain(`当前 euid=${process.getuid?.()}`);
        expect(message).toContain('sudo chown -R');
        expect(message).toContain(dir);
      } finally {
        await chmod(file, 0o600).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
