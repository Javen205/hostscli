import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addHosts,
  addRemoteSource,
  addStackLayer,
  createHostsBackup,
  createProfileFromCurrent,
  exportSnapshot,
  gitInit,
  gitSnapshot,
  mapNetwork,
  readAudit,
  removeRemoteSource,
  restoreHostsBackup,
  setStackLayerEnabled,
  unmapNetwork,
  updateConfig,
} from '../index';
import { HOSTS, makeEnv } from './batch1-helpers';

async function auditCommands(env: { dataDir: string }): Promise<string[]> {
  const records = await readAudit(join(env.dataDir, 'audit.log'), 200);
  return records.flatMap((record) => (record.command ? [record.command] : []));
}

async function runtimeLog(env: { dataDir: string }): Promise<string> {
  try {
    return await readFile(join(env.dataDir, 'logs', 'run.jsonl'), 'utf8');
  } catch {
    return '';
  }
}

describe('非 commitPlan 写操作：审计与运行日志', () => {
  it('普通写入同时留下运行日志；关闭 logging.enabled 后不再追加', async () => {
    // 守住：运行日志开关只影响日志本身，主写路径行为不变。
    const env = await makeEnv();
    try {
      await addHosts({ ...env.options(), ip: '10.0.0.13', hostnames: ['log.example.com'] });
      const first = await runtimeLog(env);
      expect(first).toContain('"event":"write-ok"');

      const linesBefore = first.split('\n').filter(Boolean).length;
      await updateConfig('logging.enabled', 'false', env.options());
      const quietBaseline = (await runtimeLog(env)).split('\n').filter(Boolean).length;
      expect(quietBaseline).toBe(linesBefore + 1); // config set 自身仍按旧配置记了一条
      await addHosts({ ...env.options(), ip: '10.0.0.14', hostnames: ['quiet.example.com'] });
      const second = await runtimeLog(env);
      expect(second.split('\n').filter(Boolean).length).toBe(quietBaseline);
    } finally {
      await env.cleanup();
    }
  });

  it('config set / network map / network unmap 都有审计记录', async () => {
    // 守住：不经过 commitPlan 的配置写入也要有前后指纹，不能成为审计黑洞。
    const env = await makeEnv();
    try {
      await updateConfig('logging.keep', '7', env.options());
      await mapNetwork({ ...env.options(), ssid: 'lab', layers: [] });
      await unmapNetwork({ ...env.options(), ssid: 'lab' });

      const commands = await auditCommands(env);
      expect(commands).toContain('config set');
      expect(commands).toContain('network map');
      expect(commands).toContain('network unmap');
      const records = await readAudit(join(env.dataDir, 'audit.log'), 200);
      for (const command of ['config set', 'network map', 'network unmap']) {
        const entry = records.find((record) => record.command === command);
        // 首次 config set 之前配置不存在，before 合法地为 null；之后都应有指纹。
        expect(entry?.afterSha256).toMatch(/^sha256:/);
        if (command !== 'config set') {
          expect(entry?.beforeSha256).toMatch(/^sha256:/);
        }
      }
    } finally {
      await env.cleanup();
    }
  });

  it('stack layer add / disable 与 backup / restore / remote 均入审计', async () => {
    // 守住：备份、恢复、订阅与层导入都是"有副作用但非 hosts 主写入"，逐个必须可追溯。
    const env = await makeEnv();
    try {
      const backupPath = await createHostsBackup(env.options());

      await addHosts({
        ...env.options(),
        ip: '10.0.0.13',
        hostnames: ['after-backup.example.com'],
      });
      const restored = await restoreHostsBackup({ ...env.options(), backupFile: backupPath });
      expect(restored.changed).toBe(true);
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);

      await addRemoteSource({
        ...env.options(),
        id: 'feed',
        url: 'https://rules.example.com/list.txt',
      });
      await removeRemoteSource({ ...env.options(), id: 'feed' });

      // 先用一个普通方案文件作为层来源，避免依赖 YAML 解析分支。
      const sourcePath = join(env.dataDir, 'profiles', 'source.json');
      await createProfileFromCurrent({ ...env.options(), id: 'source', fromCurrent: true });
      await addStackLayer({ ...env.options(), file: sourcePath, id: 'layer-two' });
      await setStackLayerEnabled({ ...env.options(), id: 'layer-two', enabled: false });

      const commands = await auditCommands(env);
      expect(commands).toContain('backup create');
      expect(commands).toContain('restore');
      expect(commands).toContain('remote add');
      expect(commands).toContain('remote remove');
      expect(commands).toContain('stack layer add');
      expect(commands).toContain('stack layer disable');
    } finally {
      await env.cleanup();
    }
  });

  it('git init / snapshot 不改变 hosts，但留下审计记录', async () => {
    // 守住：git 仓库写入不能绕过审计，也不能顺手改动 hosts。
    const env = await makeEnv();
    try {
      await gitInit(env.options());
      await writeFile(join(env.dataDir, 'note.txt'), 'snapshot me\n');
      const snapshot = await gitSnapshot({ ...env.options(), message: 'test snapshot' });
      expect(snapshot.created).toBe(true);

      const commands = await auditCommands(env);
      expect(commands).toContain('git init');
      expect(commands).toContain('git snapshot');
      expect(await readFile(env.hostsPath, 'utf8')).toBe(HOSTS);
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  it('export 只记运行日志、不入审计链', async () => {
    // 守住：export 写的是用户指定文件，不能把"只读快照"误记成受管状态变更。
    const env = await makeEnv();
    try {
      const before = await auditCommands(env);
      await exportSnapshot(env.options());
      expect(await auditCommands(env)).toEqual(before);
      expect(await runtimeLog(env)).toContain('"event":"export"');
    } finally {
      await env.cleanup();
    }
  });
});
