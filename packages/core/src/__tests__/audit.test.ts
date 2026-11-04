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

describe('审计：结构化写入记录与一致性检查', () => {
  it('成功写入记录 write-ok、前后哈希、操作者与条目摘要，一致性检查通过', async () => {
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

      if (process.platform !== 'win32') {
        expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
      }
      const verification = await verifyAudit(auditPath);
      expect(verification.ok).toBe(true);
      expect(verification.total).toBeGreaterThan(0);
    } finally {
      await env.cleanup();
    }
  });

  it('旧带链字段记录仍可读取、查询与导出，链字段被忽略', async () => {
    const env = await makeEnv();
    try {
      const auditPath = join(env.dataDir, 'audit.log');
      await mkdir(env.dataDir, { recursive: true });
      await writeFile(
        auditPath,
        `${JSON.stringify({
          id: '1',
          seq: 1,
          at: '2026-10-01T00:00:00.000Z',
          action: 'verify-ok',
          ok: true,
          hostsPath: env.hostsPath,
          prevHash: 'GENESIS',
          recordHash: 'sha256:deadbeef',
          onChain: true,
        })}\n`,
      );
      await appendAudit(auditPath, {
        at: '2026-11-02T00:00:00.000Z',
        action: 'write-ok',
        ok: true,
        hostsPath: env.hostsPath,
      });

      const entries = await readAudit(auditPath, 10);
      expect(entries.map((entry) => entry.id)).toEqual(['1', '2']);
      expect(entries[0]).not.toHaveProperty('recordHash');
      expect(entries[0]).not.toHaveProperty('onChain');

      const shown = await showAudit(auditPath, '1');
      expect(shown?.action).toBe('verify-ok');
      const exported = await exportAudit(auditPath, 'json');
      expect(exported.count).toBe(2);

      const verification = await verifyAudit(auditPath);
      expect(verification.ok).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('删除旧链 sidecar 不影响任何命令', async () => {
    const env = await makeEnv();
    try {
      const auditPath = join(env.dataDir, 'audit.log');
      await mkdir(env.dataDir, { recursive: true });
      await writeFile(
        `${auditPath}.chain.json`,
        JSON.stringify({ seq: 2, lastHash: 'sha256:old', baseHash: 'GENESIS' }),
      );
      await appendAudit(auditPath, {
        at: '2026-11-02T00:00:00.000Z',
        action: 'write-ok',
        ok: true,
        hostsPath: env.hostsPath,
      });

      await expect(readFile(`${auditPath}.chain.json`)).rejects.toMatchObject({ code: 'ENOENT' });
      const entries = await readAudit(auditPath, 10);
      expect(entries).toHaveLength(1);
      expect((await verifyAudit(auditPath)).ok).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('格式损坏的行会让 verify 报告不一致', async () => {
    const env = await makeEnv();
    try {
      const auditPath = join(env.dataDir, 'audit.log');
      await mkdir(env.dataDir, { recursive: true });
      await writeFile(
        auditPath,
        `${JSON.stringify({
          id: '1',
          at: '2026-11-02T00:00:00.000Z',
          action: 'write-ok',
          ok: true,
          hostsPath: env.hostsPath,
        })}\nnot-json\n`,
      );

      const verification = await verifyAudit(auditPath);
      expect(verification.ok).toBe(false);
      expect(verification.invalidLines).toBe(1);
      expect(verification.issues[0]?.id).toBe('format');
    } finally {
      await env.cleanup();
    }
    // 注意：审计不再承诺检测内容篡改；能写 dataDir 的同一用户也能改写 audit.log。
  });

  it('--keep 轮转后记录仍自洽，ID 继续递增', async () => {
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
      expect(entries.map((entry) => entry.id)).toEqual(['3', '4']);
      const verification = await verifyAudit(auditPath);
      expect(verification.ok).toBe(true);
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

  it('verify-ok 审计写入失败不再被静默吞掉，记录为未审计', async () => {
    const env = await makeEnv();
    try {
      // audit.log 是目录：所有审计写入都会失败。
      await mkdir(join(env.dataDir, 'audit.log'), { recursive: true });
      const result = await addHosts({
        ...env.options(),
        ip: '10.0.0.15',
        hostnames: ['verified.example.com'],
        verify: true,
        verifyLookup: async (hostname: string) => [
          { address: hostname === 'verified.example.com' ? '10.0.0.15' : '10.0.0.12', family: 4 },
        ],
      });
      expect(result.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toContain('verified.example.com');

      const failures = await readAuditFailures(env.dataDir);
      expect(failures.some((failure) => failure.detail?.includes('verify-ok'))).toBe(true);
      expect(
        result.warnings.some((warning) => warning.includes('解析验证通过的审计写入失败')),
      ).toBe(true);
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
