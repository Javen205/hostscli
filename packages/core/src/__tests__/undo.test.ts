import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addHosts,
  createProfileFromCurrent,
  disableFor,
  listRuns,
  listTtl,
  listUndoHistory,
  readHistory,
  readAudit,
  setHostsEnabled,
  undoHosts,
  VerificationError,
} from '../index';
import { HOSTS, makeEnv } from './batch1-helpers';

describe('undo：意图级撤销', () => {
  it('撤销最近一次写入，hosts/state/profile 一并回退，且 undo 本身可再撤销', async () => {
    const env = await makeEnv();
    try {
      const result = await addHosts({
        ...env.options(),
        ip: '10.0.0.13',
        hostnames: ['undo.example.com'],
      });
      expect(result.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('undo.example.com');

      const history = await readHistory(env.dataDir);
      expect(history).toHaveLength(1);
      expect(history[0]?.kind).toBe('write');

      const undone = await undoHosts(env.options());
      expect(undone.steps).toBe(1);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);

      const afterUndo = await readHistory(env.dataDir);
      expect(afterUndo.at(-1)?.kind).toBe('undo');
      expect(afterUndo.at(-1)?.consumes).toEqual([history[0]?.id]);

      // 再撤销一条：回放 undo 的"写入前"快照 = redo 刚才的写入。
      const redone = await undoHosts(env.options());
      expect(redone.steps).toBe(1);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('undo.example.com');
    } finally {
      await env.cleanup();
    }
  });

  it('--steps 2 逆序回放，hosts 回到两次写入之前', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['one.example.com'] });
      await addHosts({ ...env.options(), ip: '10.0.0.14', hostnames: ['two.example.com'] });

      const undone = await undoHosts({ ...env.options(), steps: 2 });
      expect(undone.records).toHaveLength(2);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);
    } finally {
      await env.cleanup();
    }
  });

  it('--steps N 回退区间内每个记录独有的方案文件（不只最旧一条）', async () => {
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'p2', fromCurrent: false });
      await createProfileFromCurrent({ ...env.options(), id: 'p3', fromCurrent: false });
      const profilesDir = join(env.dataDir, 'profiles');
      expect(await readFile(join(profilesDir, 'p2.json'), 'utf8')).toContain('"p2"');
      expect(await readFile(join(profilesDir, 'p3.json'), 'utf8')).toContain('"p3"');

      await undoHosts({ ...env.options(), steps: 2 });

      await expect(readFile(join(profilesDir, 'p2.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(profilesDir, 'p3.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);
    } finally {
      await env.cleanup();
    }
  });

  it('--steps 2 同时回退 hosts 写入与方案创建（混合区间）', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['mixed.example.com'] });
      await createProfileFromCurrent({ ...env.options(), id: 'mixed-profile', fromCurrent: false });

      await undoHosts({ ...env.options(), steps: 2 });

      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);
      await expect(
        readFile(join(env.dataDir, 'profiles', 'mixed-profile.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await env.cleanup();
    }
  });

  it('快照被篡改时以 CONFLICT 拒绝，且不写入 hosts', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['tamper.example.com'] });
      const record = (await readHistory(env.dataDir)).at(-1);
      expect(record).toBeDefined();
      const snapshotPath = join(env.dataDir, 'history', record!.id, 'hosts');
      const before = await readFile(env.hostsPath, 'utf8');
      await writeFile(snapshotPath, `${before}# tampered${EOL}`);

      await expect(undoHosts(env.options())).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await readFile(env.hostsPath, 'utf8')).toBe(before);
    } finally {
      await env.cleanup();
    }
  });

  it('快照文件缺失时以 CONFLICT 拒绝', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['missing.example.com'] });
      const record = (await readHistory(env.dataDir)).at(-1);
      const snapshotPath = join(env.dataDir, 'history', record!.id, 'hosts');
      await unlink(snapshotPath);

      await expect(undoHosts(env.options())).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await readFile(env.hostsPath, 'utf8')).toContain('missing.example.com');
    } finally {
      await env.cleanup();
    }
  });

  it('hostsPath 与记录不一致时拒绝撤销（即使内容相同）', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['path.example.com'] });
      const otherHosts = join(env.directory, 'other-hosts');
      await copyFile(env.hostsPath, otherHosts);

      await expect(undoHosts({ ...env.options(), filePath: otherHosts })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(await readFile(env.hostsPath, 'utf8')).toContain('path.example.com');
      expect(await readFile(otherHosts, 'utf8')).toBe(await readFile(env.hostsPath, 'utf8'));
    } finally {
      await env.cleanup();
    }
  });

  it('撤销不复活 pid 已死的 run 租约，并清理会话方案文件', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.15', hostnames: ['keep.example.com'] });
      const statePath = join(env.dataDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      const sessionLayer = 'session-dead';
      state.activeLayers = [...(state.activeLayers as string[]), sessionLayer];
      state.sessions = [
        {
          sessionId: sessionLayer,
          layerId: sessionLayer,
          pid: 999999,
          ip: '10.0.0.99',
          hostnames: ['runx.example'],
          command: ['sleep', '4'],
          startedAt: '2026-11-02T00:00:00.000Z',
          heartbeatAt: '2026-11-02T00:00:00.000Z',
        },
      ];
      await writeFile(statePath, JSON.stringify(state));
      await mkdir(join(env.dataDir, 'profiles'), { recursive: true });
      await writeFile(
        join(env.dataDir, 'profiles', `${sessionLayer}.json`),
        JSON.stringify({
          schemaVersion: 1,
          id: sessionLayer,
          name: 'run 临时会话',
          priority: 99,
          entries: [{ ip: '10.0.0.99', hostnames: ['runx.example'], enabled: true }],
          ephemeral: true,
        }),
      );

      await addHosts({
        ...env.options(),
        ip: '10.0.0.14',
        hostnames: ['during.example.com'],
        layerId: 'default',
      });
      expect(await readFile(env.hostsPath, 'utf8')).toContain('runx.example');

      const undone = await undoHosts(env.options());
      expect(undone.warnings.join('\n')).toContain('已退出的 run 会话');
      expect(await readFile(env.hostsPath, 'utf8')).not.toContain('runx.example');

      const runs = await listRuns(env.options());
      expect(runs.sessions).toHaveLength(0);
      await expect(
        readFile(join(env.dataDir, 'profiles', `${sessionLayer}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const restored = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      expect(restored.sessions).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  it('撤销已结算的 TTL 后，连续两次 list 幂等且不再重新计时', async () => {
    const env = await makeEnv();
    try {
      await disableFor({
        ...env.options(),
        hostnames: ['api.example.com'],
        for: '30m',
      });

      const afterExpiry = new Date('2026-11-02T00:45:00.000Z');
      await listTtl({ ...env.options(), now: afterExpiry });
      const undone = await undoHosts({ ...env.options(), now: afterExpiry });
      expect(undone.warnings.join('\n')).toContain('已到期 TTL');

      const statePath = join(env.dataDir, 'state.json');
      const first = await readFile(statePath);
      await listTtl({ ...env.options(), now: afterExpiry });
      const second = await readFile(statePath);
      await listTtl({ ...env.options(), now: afterExpiry });
      expect(second.equals(first)).toBe(true);

      const state = JSON.parse(first.toString('utf8')) as { ttl: unknown[] };
      expect(state.ttl).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  it('undo --verify 失败会写 verify-rollback 审计事件', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['verify-undo.example.com'] });

      await expect(
        undoHosts({
          ...env.options(),
          verify: true,
          verifyLookup: async () => [{ address: '10.0.0.1', family: 4 }],
        }),
      ).rejects.toBeInstanceOf(VerificationError);

      const entries = await readAudit(join(env.dataDir, 'audit.log'), 20);
      const rollback = entries.find(
        (entry) => entry.action === 'verify-rollback' && entry.command === 'undo',
      );
      expect(rollback).toBeDefined();
      expect(rollback?.ok).toBe(false);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('verify-undo.example.com');
    } finally {
      await env.cleanup();
    }
  });

  it('目标内容被他人改写时拒绝撤销', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['undo.example.com'] });
      await writeFile(env.hostsPath, `${HOSTS}# manual edit${EOL}`);
      await expect(undoHosts(env.options())).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      await env.cleanup();
    }
  });

  it('--dry-run 只计算差异不写盘；无历史与 steps 超限各自报错', async () => {
    const env = await makeEnv();
    try {
      await expect(undoHosts(env.options())).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' });

      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['undo.example.com'] });
      const before = await readFile(env.hostsPath, 'utf8');
      const observed = await undoHosts({ ...env.options(), dryRun: true });
      expect(observed.dryRun).toBe(true);
      expect(observed.diff).toContain('undo.example.com');
      expect(await readFile(env.hostsPath, 'utf8')).toBe(before);

      await expect(undoHosts({ ...env.options(), steps: 5 })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    } finally {
      await env.cleanup();
    }
  });

  it('禁用写入会同时改动 hosts 与方案，undo 恢复两处', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['multi.example.com'] });
      await setHostsEnabled({ ...env.options(), hostnames: ['multi.example.com'], enabled: false });
      expect(await readFile(env.hostsPath, 'utf8')).not.toContain('multi.example.com');

      const undone = await undoHosts(env.options());
      expect(undone.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('multi.example.com');
      const profile = JSON.parse(
        await readFile(join(env.dataDir, 'profiles', 'default.json'), 'utf8'),
      ) as {
        entries: Array<{ hostnames: string[]; enabled: boolean }>;
      };
      expect(
        profile.entries.some(
          (entry) => entry.hostnames.includes('multi.example.com') && entry.enabled,
        ),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('会列出可撤销历史，数量受 limit 限制', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['a.example.com'] });
      await addHosts({ ...env.options(), ip: '10.0.0.14', hostnames: ['b.example.com'] });
      const listed = await listUndoHistory({ ...env.options(), limit: 1 });
      expect(listed.records).toHaveLength(1);
      expect(
        listed.records[0]?.summary.added.some((entry) => entry.hostnames.includes('b.example.com')),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
});
