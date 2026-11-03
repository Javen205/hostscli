import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addHosts, listUndoHistory, readHistory, setHostsEnabled, undoHosts } from '../index';
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

  it('目标内容被他人改写时拒绝撤销', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['undo.example.com'] });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(env.hostsPath, `${HOSTS}# manual edit\n`);
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
