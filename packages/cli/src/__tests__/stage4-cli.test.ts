import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { completionScript } from '../commands/completion';
import { parseNameOption, parsePriorityOption } from '../commands/common';
import { serializeSnapshot } from '../commands/export';
import { exitCodeFor } from '../errors';

const snapshot = {
  schemaVersion: 1 as const,
  exportedAt: '2026-11-02T00:00:00.000Z',
  hostsPath: '/tmp/hosts',
  platform: 'darwin',
  config: { schemaVersion: 1, defaults: { dnsFlush: true } },
  state: { schemaVersion: 1, activeLayers: ['office'], ttl: [] },
  profiles: [
    {
      schemaVersion: 1,
      id: 'office',
      name: '办公室',
      priority: 10,
      entries: [{ ip: '10.0.0.1', hostnames: ['api.example.com'], enabled: true }],
    },
  ],
};

describe('阶段 4：CLI 导出格式与补全脚本', () => {
  it('JSON 与 YAML 导出语义一致', () => {
    const json = JSON.parse(serializeSnapshot(snapshot as never, 'json'));
    const yaml = parse(serializeSnapshot(snapshot as never, 'yaml'));
    expect(yaml).toEqual(json);
    expect(yaml.profiles[0].id).toBe('office');
  });

  it('三种 shell 的补全脚本都覆盖全部一级命令', () => {
    const commands = [
      'list',
      'add',
      'remove',
      'enable',
      'disable',
      'stack',
      'doctor',
      'network',
      'git',
      'export',
      'audit',
      'completion',
    ];
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = completionScript(shell);
      expect(script).toContain('hostscli');
      for (const command of commands) expect(script).toContain(command);
    }
    expect(completionScript('bash')).toContain('complete -F _hostscli_completions hostscli');
    expect(completionScript('fish')).toContain('complete -c hostscli');
  });

  it('profile 参数解析拒绝空名称与非整数优先级', () => {
    for (const value of ['', '   ', '\t']) {
      const error = (() => {
        try {
          parseNameOption(value);
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    }

    for (const value of ['abc', '1.5', '12abc', '']) {
      const error = (() => {
        try {
          parsePriorityOption(value);
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(parsePriorityOption('10')).toBe(10);
    expect(parseNameOption('办公网')).toBe('办公网');
  });

  it('同名冲突类错误退出码为输入错误 2', () => {
    expect(exitCodeFor({ code: 'DUPLICATE_ENTRY' })).toBe(2);
    expect(exitCodeFor({ code: 'INVALID_INPUT' })).toBe(2);
    expect(exitCodeFor({ code: 'STORAGE_CORRUPT' })).toBe(7);
  });
});
