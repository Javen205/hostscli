import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addHosts,
  createProfileFromCurrent,
  disableFor,
  moveProfileEntry,
  readAudit,
  readHistory,
  showProfile,
  undoHosts,
  useProfile,
  writeProfile,
} from '../index';
import type { Profile } from '../index';
import { makeEnv, readStateFile } from './batch1-helpers';

const profilesDirOf = (dataDir: string): string => join(dataDir, 'profiles');

describe('profile move：跨方案迁移条目', () => {
  it('保留 IP/注释；源方案移除、目标方案加入；生效时立即重建 hosts', async () => {
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'office', fromCurrent: true });
      await createProfileFromCurrent({ ...env.options(), id: 'prod' });
      await useProfile({ ...env.options(), id: 'office' });
      await addHosts({
        ...env.options(),
        ip: '10.0.0.20',
        hostnames: ['web.example.com'],
        comment: '内网 Web',
        layerId: 'office',
      });
      expect(await readFile(env.hostsPath, 'utf8')).toContain('web.example.com');

      const result = await moveProfileEntry({
        ...env.options(),
        hostname: 'web.example.com',
        from: 'office',
        to: 'prod',
      });
      expect(result.changed).toBe(true);
      expect(result.movedIp).toBe('10.0.0.20');
      expect(result.movedHostnames).toEqual(['web.example.com']);
      expect(result.ttlRecords).toBe(0);

      const officeAfter = await showProfile('office', env.options());
      expect(
        officeAfter.entries.some((candidate) => candidate.hostnames.includes('web.example.com')),
      ).toBe(false);
      const prodAfter = await showProfile('prod', env.options());
      expect(
        prodAfter.entries.find((candidate) => candidate.hostnames.includes('web.example.com')),
      ).toMatchObject({
        ip: '10.0.0.20',
        hostnames: ['web.example.com'],
        comment: '内网 Web',
        enabled: true,
      });

      // 条目从生效方案迁到未生效方案后，hosts 里应当立即消失，但 office 的其他条目保留。
      const hostsAfter = await readFile(env.hostsPath, 'utf8');
      expect(hostsAfter).not.toContain('web.example.com');
      expect(hostsAfter).toContain('api.example.com');

      const audit = await readAudit(join(env.dataDir, 'audit.log'), 20);
      expect(audit.find((record) => record.command === 'profile move')?.ok).toBe(true);
      expect((await readHistory(env.dataDir)).at(-1)?.command).toBe('profile move');
    } finally {
      await env.cleanup();
    }
  });

  it('源与目标都未生效时只写方案文件：hosts 字节不变，且可 undo 还原', async () => {
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'office', fromCurrent: true });
      await createProfileFromCurrent({ ...env.options(), id: 'prod' });
      const office = await showProfile('office', env.options());
      const api = office.entries.find((candidate) =>
        candidate.hostnames.includes('api.example.com'),
      )!;
      api.enabled = false;
      api.disabledReason = '维护中';
      api.comment = '内网 API';
      await writeProfile(profilesDirOf(env.dataDir), office);
      const hostsBefore = await readFile(env.hostsPath, 'utf8');

      const result = await moveProfileEntry({
        ...env.options(),
        hostname: 'api.example.com',
        from: 'office',
        to: 'prod',
      });
      expect(result.changed).toBe(false);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(hostsBefore);

      const officeAfter = await showProfile('office', env.options());
      expect(officeAfter.entries).toHaveLength(0);
      const prodAfter = await showProfile('prod', env.options());
      expect(
        prodAfter.entries.find((candidate) => candidate.hostnames.includes('api.example.com')),
      ).toMatchObject({
        ip: '10.0.0.12',
        hostnames: ['api.example.com'],
        comment: '内网 API',
        enabled: false,
        disabledReason: '维护中',
      });

      await undoHosts(env.options());
      expect(
        (await showProfile('office', env.options())).entries.some((candidate) =>
          candidate.hostnames.includes('api.example.com'),
        ),
      ).toBe(true);
      expect((await showProfile('prod', env.options())).entries).toHaveLength(0);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(hostsBefore);
    } finally {
      await env.cleanup();
    }
  });

  it('目标已存在同名主机名时默认报错并写 move-failed 审计；--force 覆盖且保留目标其他主机名', async () => {
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'office', fromCurrent: true });
      const prod: Profile = {
        schemaVersion: 1,
        id: 'prod',
        name: 'prod',
        priority: 0,
        entries: [
          {
            ip: '10.9.9.9',
            hostnames: ['api.example.com', 'web.example.com'],
            enabled: true,
          },
        ],
      };
      await writeProfile(profilesDirOf(env.dataDir), prod);

      await expect(
        moveProfileEntry({
          ...env.options(),
          hostname: 'api.example.com',
          from: 'office',
          to: 'prod',
        }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_ENTRY' });

      const failures = (await readAudit(join(env.dataDir, 'audit.log'), 20)).filter(
        (record) => record.action === 'move-failed',
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.ok).toBe(false);
      expect(failures[0]?.detail).toContain('--force');
      expect(
        (await showProfile('office', env.options())).entries.some((candidate) =>
          candidate.hostnames.includes('api.example.com'),
        ),
      ).toBe(true);

      const forced = await moveProfileEntry({
        ...env.options(),
        hostname: 'api.example.com',
        from: 'office',
        to: 'prod',
        force: true,
      });
      expect(forced.replacedHostnames).toEqual(['api.example.com']);

      const prodAfter = await showProfile('prod', env.options());
      expect(
        prodAfter.entries.find((candidate) => candidate.hostnames.includes('api.example.com'))?.ip,
      ).toBe('10.0.0.12');
      // 同一目标条目里的其他主机名必须保留，不能被整条覆盖。
      expect(
        prodAfter.entries.find((candidate) => candidate.hostnames.includes('web.example.com'))?.ip,
      ).toBe('10.9.9.9');
    } finally {
      await env.cleanup();
    }
  });

  it('TTL 记录随条目迁移到新方案（entryId 含 layerId，必须同步改写）', async () => {
    const env = await makeEnv();
    try {
      await createProfileFromCurrent({ ...env.options(), id: 'office', fromCurrent: true });
      await createProfileFromCurrent({ ...env.options(), id: 'prod' });
      await useProfile({ ...env.options(), id: 'office' });
      const ttl = await disableFor({
        ...env.options(),
        hostnames: ['api.example.com'],
        for: '5m',
      });

      const result = await moveProfileEntry({
        ...env.options(),
        hostname: 'api.example.com',
        from: 'office',
        to: 'prod',
      });
      expect(result.ttlRecords).toBe(1);

      const state = await readStateFile(env);
      const records = state?.ttl as Array<{ layerId: string; entryId: string }>;
      expect(records).toHaveLength(1);
      expect(records[0]?.layerId).toBe('prod');
      expect(records[0]?.entryId).not.toBe(ttl.record.entryId);

      await useProfile({ ...env.options(), id: 'prod' });
      expect(await readFile(env.hostsPath, 'utf8')).not.toContain('api.example.com');
    } finally {
      await env.cleanup();
    }
  });
});
