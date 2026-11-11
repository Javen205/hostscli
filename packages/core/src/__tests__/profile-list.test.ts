import { describe, expect, it } from 'vitest';
import {
  createProfileFromCurrent,
  disableFor,
  listHosts,
  moveProfileEntry,
  useProfile,
} from '../index';
import { makeEnv } from './batch1-helpers';

describe('list 方案视图：查看未生效方案', () => {
  it('迁移到未生效方案后，默认 list 看不到，但 list --profile 能查到（回归）', async () => {
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'office', fromCurrent: true });
      await createProfileFromCurrent({ ...env.options(), id: 'work' });
      await useProfile({ ...env.options(), id: 'office' });

      const moved = await moveProfileEntry({
        ...env.options(),
        hostname: 'api.example.com',
        from: 'office',
        to: 'work',
      });
      expect(moved.toActive).toBe(false);

      // 生效视图：条目已从 hosts 移除，只看到两个非托管行。
      const effective = await listHosts(env.options());
      expect(effective.entries.some((entry) => entry.hostnames.includes('api.example.com'))).toBe(
        false,
      );
      expect(effective.summary.external).toBe(2);
      expect(effective.view).toBeUndefined();

      // 方案视图：能查到，且带着原始元数据。
      const view = await listHosts({ ...env.options(), profiles: ['work'] });
      expect(view.entries).toHaveLength(1);
      expect(view.entries[0]).toMatchObject({
        ip: '10.0.0.12',
        hostnames: ['api.example.com'],
        enabled: true,
        layerId: 'work',
        source: 'managed',
      });
      expect(view.view).toEqual({ mode: 'profiles', profiles: ['work'], omittedExternal: 2 });
      // summary 描述本次返回的 entries；非托管行被省略，数量由 view 报出。
      expect(view.summary).toMatchObject({ managed: 1, external: 0, disabled: 0, ttlDisabled: 0 });

      // 全部方案视图：生效的 office（已空）与未生效的 work 一起展示。
      const all = await listHosts({ ...env.options(), allProfiles: true });
      expect(all.view?.mode).toBe('all');
      expect(all.view?.profiles).toEqual(['office', 'work']);
      expect(all.entries.map((entry) => entry.layerId)).toEqual(['work']);
    } finally {
      await env.cleanup();
    }
  });

  it('方案视图保留 TTL 禁用状态与方案内去重顺序', async () => {
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'office', fromCurrent: true });
      await createProfileFromCurrent({ ...env.options(), id: 'work' });
      await useProfile({ ...env.options(), id: 'office' });
      await disableFor({ ...env.options(), hostnames: ['api.example.com'], for: '5m' });

      await moveProfileEntry({
        ...env.options(),
        hostname: 'api.example.com',
        from: 'office',
        to: 'work',
      });

      const view = await listHosts({ ...env.options(), profiles: ['work', 'work'] });
      expect(view.view?.profiles).toEqual(['work']);
      expect(view.summary.ttlDisabled).toBe(1);
      expect(view.entries[0]).toMatchObject({ enabled: false, layerId: 'work' });
      expect(view.entries[0]?.ttl).toBeDefined();
    } finally {
      await env.cleanup();
    }
  });

  it('--profile 与 --all-profiles 互斥；不存在的方案以 ENTRY_NOT_FOUND 报错', async () => {
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'office', fromCurrent: true });

      await expect(
        listHosts({ ...env.options(), profiles: ['office'], allProfiles: true }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(listHosts({ ...env.options(), profiles: ['missing'] })).rejects.toMatchObject({
        code: 'ENTRY_NOT_FOUND',
      });
    } finally {
      await env.cleanup();
    }
  });
});
