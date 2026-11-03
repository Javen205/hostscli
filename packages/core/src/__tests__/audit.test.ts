import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addHosts,
  appendAudit,
  exportAudit,
  queryAudit,
  readAudit,
  readAuditFailures,
  showAudit,
  verifyAudit,
} from '../index';
import { makeEnv } from './batch1-helpers';

describe('审计：写入留痕与哈希链', () => {
  it('成功写入记录 write-ok、前后哈希、操作者与条目摘要，链校验通过', async () => {
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['audit.example.com'] });

      const auditPath = join(env.dataDir, 'audit.log');
      const entries = await readAudit(auditPath, 10);
      const write = entries.find((entry) => entry.action === 'write-ok');
      expect(write).toBeDefined();
      expect(write?.ok).toBe(true);
      expect(write?.hostsPath).toBe(env.hostsPath);
      expect(write?.beforeSha256).toMatch(/^sha256:/);
      expect(write?.afterSha256).toMatch(/^sha256:/);
      expect(write?.operator?.uid === null || typeof write?.operator?.uid === 'number').toBe(true);
      expect(
        write?.summary?.added.some((entry) => entry.hostnames.includes('audit.example.com')),
      ).toBe(true);

      expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
      const verification = await verifyAudit(auditPath);
      expect(verification.ok).toBe(true);
      expect(verification.chained).toBeGreaterThan(0);
    } finally {
      await env.cleanup();
    }
  });

  it('篡改任一条记录内容会被 verify 发现', async () => {
    const env = await makeEnv();
    try {
      const auditPath = join(env.dataDir, 'audit.log');
      await appendAudit(auditPath, {
        at: '2026-11-02T00:00:00.000Z',
        action: 'verify-ok',
        ok: true,
        hostsPath: env.hostsPath,
        checked: 1,
      });
      await appendAudit(auditPath, {
        at: '2026-11-02T00:01:00.000Z',
        action: 'verify-ok',
        ok: true,
        hostsPath: env.hostsPath,
        checked: 2,
      });

      const raw = await readFile(auditPath, 'utf8');
      await writeFile(auditPath, raw.replace('"checked":1', '"checked":9'));

      const verification = await verifyAudit(auditPath);
      expect(verification.ok).toBe(false);
      expect(verification.issues[0]?.reason).toContain('哈希不匹配');
      expect(verification.issues[0]?.id).toBe('1');
    } finally {
      await env.cleanup();
    }
  });

  it('旧格式记录可读但标记为不在链上；尾部截断可被发现', async () => {
    const env = await makeEnv();
    try {
      const auditPath = join(env.dataDir, 'audit.log');
      await mkdir(env.dataDir, { recursive: true });
      await writeFile(
        auditPath,
        `${JSON.stringify({
          at: '2026-10-01T00:00:00.000Z',
          action: 'verify-ok',
          ok: true,
          hostsPath: env.hostsPath,
        })}\n`,
      );
      await appendAudit(auditPath, {
        at: '2026-11-02T00:00:00.000Z',
        action: 'write-ok',
        ok: true,
        hostsPath: env.hostsPath,
      });

      const verification = await verifyAudit(auditPath);
      expect(verification.legacy).toBe(1);
      expect(verification.chained).toBe(1);
      expect(verification.ok).toBe(true);

      const legacy = await showAudit(auditPath, 'legacy-1');
      expect(legacy?.onChain).toBe(false);
      expect(legacy?.legacy).toBe(true);

      // 删掉最后一条链上记录后，sidecar 仍记录原 seq，可发现尾部被截断。
      const raw = await readFile(auditPath, 'utf8');
      const lines = raw.trim().split('\n');
      await writeFile(auditPath, `${lines.slice(0, -1).join('\n')}\n`);
      const truncated = await verifyAudit(auditPath);
      expect(truncated.ok).toBe(false);
      expect(truncated.issues.some((issue) => /尾部|被删除/.test(issue.reason))).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('--keep 轮转后链仍然自洽，seq 继续递增', async () => {
    const env = await makeEnv();
    try {
      const auditPath = join(env.dataDir, 'audit.log');
      for (let index = 0; index < 4; index += 1) {
        await appendAudit(
          auditPath,
          {
            at: `2026-11-02T00:0${index}:00.000Z`,
            action: 'write-ok',
            ok: true,
            hostsPath: env.hostsPath,
            detail: `record-${index}`,
          },
          { keep: 2 },
        );
      }
      const entries = await readAudit(auditPath, 10);
      expect(entries).toHaveLength(2);
      const verification = await verifyAudit(auditPath);
      expect(verification.ok).toBe(true);
      expect(verification.chain.seq).toBe(4);
    } finally {
      await env.cleanup();
    }
  });

  it('过滤、show 与导出接口按语义工作', async () => {
    const env = await makeEnv();
    try {
      const auditPath = join(env.dataDir, 'audit.log');
      await appendAudit(auditPath, {
        at: '2026-11-01T10:00:00.000Z',
        action: 'write-ok',
        ok: true,
        hostsPath: env.hostsPath,
        command: 'add',
      });
      await appendAudit(auditPath, {
        at: '2026-11-02T10:00:00.000Z',
        action: 'write-rollback',
        ok: false,
        hostsPath: env.hostsPath,
        command: 'remove',
      });

      const okOnly = await queryAudit(auditPath, { result: 'ok' });
      expect(okOnly.records).toHaveLength(1);
      expect(okOnly.records[0]?.command).toBe('add');

      const byCommand = await queryAudit(auditPath, { command: 'remove' });
      expect(byCommand.records[0]?.ok).toBe(false);

      const byRange = await queryAudit(auditPath, {
        since: '2026-11-02T00:00:00.000Z',
        until: '2026-11-03T00:00:00.000Z',
      });
      expect(byRange.records).toHaveLength(1);

      const shown = await showAudit(auditPath, '2');
      expect(shown?.action).toBe('write-rollback');

      const json = await exportAudit(auditPath, 'json');
      expect(JSON.parse(json.content)).toHaveLength(2);
      const ndjson = await exportAudit(auditPath, 'ndjson');
      expect(ndjson.content.trim().split('\n')).toHaveLength(2);

      await expect(
        queryAudit(auditPath, {
          since: '2026-11-03T00:00:00.000Z',
          until: '2026-11-01T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      await env.cleanup();
    }
  });

  it('审计写入失败不阻断主操作，并留下"未审计"标记', async () => {
    const env = await makeEnv();
    const previous = process.env.HOSTSCLI_COMMAND;
    process.env.HOSTSCLI_COMMAND = 'add';
    try {
      await mkdir(join(env.dataDir, 'audit.log'), { recursive: true });
      const result = await addHosts({
        ...env.options(),
        ip: '10.0.0.14',
        hostnames: ['unaudited.example.com'],
      });
      expect(result.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('unaudited.example.com');

      const failures = await readAuditFailures(env.dataDir);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0]?.command).toBe('add');
      expect(result.warnings.some((warning) => warning.includes('审计'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HOSTSCLI_COMMAND;
      else process.env.HOSTSCLI_COMMAND = previous;
      await env.cleanup();
    }
  });
});
