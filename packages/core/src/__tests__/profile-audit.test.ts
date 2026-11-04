import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProfileFromCurrent,
  readAudit,
  readHistory,
  removeProfile,
  showProfile,
  updateProfileMeta,
  undoHosts,
  useProfile,
} from '../index';
import { readStateFile, makeEnv } from './batch1-helpers';

describe('profile 写操作：审计与 undo 覆盖', () => {
  it('profile create 入审计与 undo；撤销后方案文件消失、hosts 保持原样', async () => {
    // 守住：create 必须同时产生 undo 快照与 write-ok 审计，缺一都会让“可撤销/可追溯”失真。
    const env = await makeEnv();
    try {
      const hostsBefore = await readFile(env.hostsPath, 'utf8');
      const profile = await createProfileFromCurrent({
        ...env.options(),
        id: 'work',
        fromCurrent: true,
        priority: 2,
      });
      expect(profile.entries.length).toBeGreaterThan(0);

      const history = await readHistory(env.dataDir);
      expect(history).toHaveLength(1);
      expect(history[0]?.command).toBe('profile create');
      expect(history[0]?.summary).toBeDefined();

      const audit = await readAudit(join(env.dataDir, 'audit.log'), 10);
      const entry = audit.find((record) => record.command === 'profile create');
      expect(entry?.ok).toBe(true);
      expect(entry?.action).toBe('write-ok');
      expect(entry?.beforeSha256).toBeNull();
      expect(entry?.afterSha256).toMatch(/^sha256:/);

      await undoHosts(env.options());
      await expect(showProfile('work', env.options())).rejects.toMatchObject({
        code: 'ENTRY_NOT_FOUND',
      });
      expect(await readFile(env.hostsPath, 'utf8')).toBe(hostsBefore);
    } finally {
      await env.cleanup();
    }
  });

  it('profile remove 可撤销；删除后恢复规则完整，且不影响其他激活方案', async () => {
    // 守住：remove 的 undo 只恢复目标方案，不得改动其他激活层或 hosts。
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'active' });
      await createProfileFromCurrent({ ...env.options(), id: 'spare', fromCurrent: true });
      await useProfile({ ...env.options(), id: 'active' });

      const spareBefore = await readFile(join(env.dataDir, 'profiles', 'spare.json'), 'utf8');
      const hostsBeforeRemove = await readFile(env.hostsPath, 'utf8');
      await removeProfile('spare', env.options());

      const history = await readHistory(env.dataDir);
      expect(history.at(-1)?.command).toBe('profile remove');

      const audit = await readAudit(join(env.dataDir, 'audit.log'), 20);
      expect(audit.some((record) => record.command === 'profile remove')).toBe(true);

      await undoHosts(env.options());
      const spareAfter = await readFile(join(env.dataDir, 'profiles', 'spare.json'), 'utf8');
      expect(spareAfter).toBe(spareBefore);
      const state = await readStateFile(env);
      expect(state?.activeLayers).toEqual(['active']);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(hostsBeforeRemove);
    } finally {
      await env.cleanup();
    }
  });

  it('删除正在生效的方案被拒绝，且不产生 undo/审计记录', async () => {
    // 守住：激活方案的删除必须在任何落盘前失败，失败路径不得留下半套留痕。
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'active' });
      await useProfile({ ...env.options(), id: 'active' });
      const historyBefore = await readHistory(env.dataDir);
      const auditBefore = await readAudit(join(env.dataDir, 'audit.log'), 50);

      await expect(removeProfile('active', env.options())).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      expect(await readHistory(env.dataDir)).toHaveLength(historyBefore.length);
      expect(await readAudit(join(env.dataDir, 'audit.log'), 50)).toHaveLength(auditBefore.length);
      // 方案文件必须仍在
      await expect(showProfile('active', env.options())).resolves.toBeDefined();
    } finally {
      await env.cleanup();
    }
  });

  it('profile update（纯元数据）只写审计，不进入 undo 栈', async () => {
    // 守住：元数据变更只进审计链；undo 栈长度不变，避免“撤销把改名也吃掉”。
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'meta' });
      const historyBefore = await readHistory(env.dataDir);

      const updated = await updateProfileMeta(
        'meta',
        { name: '元数据方案', priority: 7 },
        env.options(),
      );
      expect(updated.name).toBe('元数据方案');
      expect(updated.priority).toBe(7);

      expect(await readHistory(env.dataDir)).toHaveLength(historyBefore.length);
      const audit = await readAudit(join(env.dataDir, 'audit.log'), 20);
      const entry = audit.find((record) => record.command === 'profile update');
      expect(entry?.beforeSha256).toMatch(/^sha256:/);
      expect(entry?.afterSha256).toMatch(/^sha256:/);
      expect(entry?.detail).toContain('名称');
      expect(entry?.detail).toContain('优先级');
    } finally {
      await env.cleanup();
    }
  });
});
