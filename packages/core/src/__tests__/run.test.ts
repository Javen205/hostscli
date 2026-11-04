import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishRun, gcRuns, listRuns, readAudit, startRun, undoHosts } from '../index';
import { HOSTS, makeEnv, readStateFile } from './batch1-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run：会话级临时条目', () => {
  it('会话期间条目生效，结束后自动移除且可重复调用', async () => {
    const env = await makeEnv();
    try {
      const started = await startRun({
        ...env.options(),
        hostname: 'run.example.com',
        ip: '10.0.0.99',
        command: ['true'],
      });
      expect(started.session.sessionId).toMatch(/^session-/);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('10.0.0.99  run.example.com');

      const listed = await listRuns(env.options());
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]?.alive).toBe(true);

      const finished = await finishRun(started.session.sessionId, env.options());
      expect(finished.removed).toBe(true);
      expect(finished.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);

      const again = await finishRun(started.session.sessionId, env.options());
      expect(again.removed).toBe(false);
      expect((await listRuns(env.options())).sessions).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });

  it('并发多个 run 互不覆盖，结束一个不影响另一个', async () => {
    const env = await makeEnv();
    try {
      const first = await startRun({
        ...env.options(),
        hostname: 'a.run.example.com',
        ip: '10.0.0.98',
        command: ['true'],
      });
      const second = await startRun({
        ...env.options(),
        hostname: 'b.run.example.com',
        ip: '10.0.0.97',
        command: ['true'],
      });
      const text = await readFile(env.hostsPath, 'utf8');
      expect(text).toContain('a.run.example.com');
      expect(text).toContain('b.run.example.com');

      await finishRun(first.session.sessionId, env.options());
      const remaining = await readFile(env.hostsPath, 'utf8');
      expect(remaining).not.toContain('a.run.example.com');
      expect(remaining).toContain('b.run.example.com');

      await finishRun(second.session.sessionId, env.options());
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);
    } finally {
      await env.cleanup();
    }
  });

  it('父进程消失后租约可被 run gc 回收；仍存活的会话不会被误删', async () => {
    const env = await makeEnv();
    try {
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === 0 && pid === process.pid) return true;
        const error = Object.assign(new Error('no such process'), { code: 'ESRCH' });
        throw error;
      }) as typeof process.kill);

      const alive = await startRun({
        ...env.options(),
        hostname: 'alive.run.example.com',
        ip: '10.0.0.96',
        command: ['true'],
      });
      const beforeGc = await gcRuns(env.options());
      expect(beforeGc.removed).toHaveLength(0);
      expect((await listRuns(env.options())).sessions[0]?.alive).toBe(true);

      const statePath = join(env.dataDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        sessions: Array<{ pid: number }>;
      };
      for (const session of state.sessions) session.pid = 999999;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      const gc = await gcRuns({ ...env.options(), dryRun: true });
      expect(gc.removed).toHaveLength(1);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('alive.run.example.com');

      const applied = await gcRuns(env.options());
      expect(applied.removed).toHaveLength(1);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);
      expect((await listRuns(env.options())).sessions).toHaveLength(0);
      expect(alive.session.sessionId).toBe(applied.removed[0]?.sessionId);
    } finally {
      await env.cleanup();
    }
  });

  it('gc 回收多个孤儿只重建一次，并只写一条汇总审计', async () => {
    const env = await makeEnv();
    try {
      const first = await startRun({
        ...env.options(),
        hostname: 'one.run.example.com',
        ip: '10.0.0.94',
        command: ['true'],
      });
      const second = await startRun({
        ...env.options(),
        hostname: 'two.run.example.com',
        ip: '10.0.0.93',
        command: ['true'],
      });
      const auditPath = join(env.dataDir, 'audit.log');
      const before = await readAudit(auditPath, 100);

      const statePath = join(env.dataDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        sessions: Array<{ pid: number }>;
      };
      for (const session of state.sessions) session.pid = 999999;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      const gc = await gcRuns(env.options());
      expect(gc.removed.map((session) => session.sessionId).sort()).toEqual(
        [first.session.sessionId, second.session.sessionId].sort(),
      );
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);
      expect((await listRuns(env.options())).sessions).toHaveLength(0);

      const after = await readAudit(auditPath, 100);
      const added = after.slice(before.length);
      expect(added.filter((entry) => entry.action === 'write-ok').length).toBe(1);
      expect(added.filter((entry) => entry.action === 'run-gc').length).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  it('run gc --force 可回收 pid 被复用的会话', async () => {
    const env = await makeEnv();
    try {
      const started = await startRun({
        ...env.options(),
        hostname: 'forced.run.example.com',
        ip: '10.0.0.92',
        command: ['true'],
      });
      expect((await listRuns(env.options())).sessions[0]?.alive).toBe(true);

      const forced = await gcRuns({ ...env.options(), force: true });
      expect(forced.removed).toHaveLength(1);
      expect(forced.warnings.join('\n')).toContain('--force');
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);
      expect((await listRuns(env.options())).sessions).toHaveLength(0);
      expect(forced.removed[0]?.sessionId).toBe(started.session.sessionId);
    } finally {
      await env.cleanup();
    }
  });

  it('结束后的会话仍可由 undo 完整恢复（hosts + state + 方案文件）', async () => {
    const env = await makeEnv();
    try {
      const started = await startRun({
        ...env.options(),
        hostname: 'undo-run.example.com',
        ip: '10.0.0.95',
        command: ['true'],
      });
      await finishRun(started.session.sessionId, env.options());
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);

      const undone = await undoHosts(env.options());
      expect(undone.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('undo-run.example.com');
      const state = await readStateFile(env);
      expect(
        (state?.sessions as Array<{ sessionId: string }>).some(
          (session) => session.sessionId === started.session.sessionId,
        ),
      ).toBe(true);
      expect(
        await readFile(join(env.dataDir, 'profiles', `${started.session.layerId}.json`), 'utf8'),
      ).toContain('undo-run.example.com');
    } finally {
      await env.cleanup();
    }
  });
});
