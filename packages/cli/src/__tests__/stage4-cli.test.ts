import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMMAND_ENTRIES } from '../command-manifest';
import {
  COMPLETION_BIN_NAMES,
  COMPLETION_SHELLS,
  completionScript,
  SUBCOMMANDS,
} from '../commands/completion';
import { parseIntOption, parseNameOption, parsePriorityOption } from '../commands/common';
import { serializeSnapshot } from '../commands/export';
import { exitCodeFor } from '../errors';
import { renderEntryTable } from '../output/table';
import { binNameFrom } from '../program-name';

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

  it('全部 shell 的补全脚本都覆盖一级命令与两个命令名（含 run / undo）', () => {
    // 直接以命令清单为准，补全列表漏项会让脚本测试失败而不是悄悄漂移。
    const commands = COMMAND_ENTRIES.map((entry) => entry.name);
    expect(commands).toContain('run');
    expect(commands).toContain('undo');
    for (const shell of COMPLETION_SHELLS) {
      const script = completionScript(shell);
      for (const command of commands) expect(script).toContain(command);
      for (const bin of COMPLETION_BIN_NAMES) expect(script).toContain(bin);
    }
    expect(completionScript('bash')).toContain('complete -o default -F _hostscli_completions');
    expect(completionScript('zsh')).toContain('#compdef hostscli hosts-cli');
    expect(completionScript('fish')).toContain('complete -c hosts-cli');
    expect(completionScript('powershell')).toContain(
      'Register-ArgumentCompleter -Native -CommandName hostscli,hosts-cli',
    );
    // cmd 只能做到宏级别，输出里必须明确说明不是补全。
    const cmd = completionScript('cmd');
    expect(cmd).toContain('doskey h=hostscli $*');
    expect(cmd).toContain('doskey hc=hosts-cli $*');
    expect(cmd).toContain('不是补全');
  });

  it('补全脚本与真实注册的二级子命令不漂移', async () => {
    const program = new Command();
    for (const entry of COMMAND_ENTRIES) await entry.register(program);

    const actual: Record<string, string[]> = {};
    const walk = (command: Command, prefix: string): void => {
      if (command.commands.length === 0) return;
      const key = `${prefix}${command.name()}`;
      actual[key] = command.commands.map((child) => child.name());
      for (const child of command.commands) walk(child, `${key} `);
    };
    for (const command of program.commands) walk(command, '');

    // 清单里有子命令的父命令必须写进 SUBCOMMANDS，否则补全缺失。
    for (const [key, names] of Object.entries(actual)) {
      expect(SUBCOMMANDS[key], `补全缺少父命令 ${key}`).toEqual(names);
    }
    // 反向：SUBCOMMANDS 不能凭空多出命令清单里不存在的父命令。
    for (const key of Object.keys(SUBCOMMANDS)) {
      expect(actual[key], `补全多写了不存在的父命令 ${key}`).toBeDefined();
    }
  });

  it('生成的脚本能被对应 shell 解析（缺 shell 时跳过并说明）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcli-completion-'));
    const check = (binary: string, args: string[], script: string): string | null => {
      const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0) return null;
      const file = join(dir, binary.replace(/\W/g, '_'));
      writeFileSync(file, script);
      const result = spawnSync(binary, [...args, file], { encoding: 'utf8' });
      return result.status === 0 ? '' : result.stderr || result.stdout || '语法检查失败';
    };

    try {
      const bash = check('bash', ['-n'], completionScript('bash'));
      expect(bash).not.toBeNull();
      expect(bash).toBe('');

      const zsh = check('zsh', ['-n'], completionScript('zsh'));
      if (zsh !== null) expect(zsh).toBe('');

      const fish = check('fish', ['-n'], completionScript('fish'));
      if (fish !== null) expect(fish).toBe('');

      const probe = spawnSync(
        'pwsh',
        ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
        {
          encoding: 'utf8',
        },
      );
      if (!probe.error && probe.status === 0) {
        const file = join(dir, 'completion.ps1');
        writeFileSync(file, completionScript('powershell'));
        // -Command 之后的内容会被拼进命令文本，$args 拿不到路径，必须用 -File 传参。
        const checker = join(dir, 'check-syntax.ps1');
        writeFileSync(
          checker,
          [
            'param([Parameter(Mandatory = $true)][string]$Path)',
            '$tokens = $null; $errors = $null;',
            '[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors);',
            'if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }',
          ].join('\n'),
        );
        const result = spawnSync('pwsh', ['-NoProfile', '-File', checker, file], {
          encoding: 'utf8',
        });
        expect(result.stdout + result.stderr).toBe('');
        expect(result.status).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // 四个 shell 各起一次进程，CI 上 pwsh 冷启动就可能超过 vitest 默认 5s。
  }, 30_000);

  it('命令名按 argv[1] 自适应，未知入口回落到 hostscli', () => {
    expect(binNameFrom('/usr/local/bin/hostscli')).toBe('hostscli');
    expect(binNameFrom('/usr/local/bin/hosts-cli')).toBe('hosts-cli');
    expect(binNameFrom('C:\\npm\\hosts-cli.cmd')).toBe('hostscli');
    expect(binNameFrom('/repo/packages/cli/dist/index.js')).toBe('hostscli');
    expect(binNameFrom(undefined)).toBe('hostscli');
  });

  it('整数选项拒绝非整数、越界值，不再静默回退默认值', () => {
    const limit = parseIntOption('--limit', { min: 1, max: 200 });
    expect(limit('20')).toBe(20);
    for (const value of ['abc', '12abc', '1.5', '', '201', '0', '-1']) {
      const error = (() => {
        try {
          limit(value);
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(parseIntOption('--keep', { min: 0 })('0')).toBe(0);
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

  it('大表渲染保持秒级完成且列对齐（cli-table3 会退化为 O(n²)）', () => {
    const esc = String.fromCharCode(27);
    const stripAnsi = (text: string): string =>
      text.replace(new RegExp(`${esc}\\[[0-9;]*m`, 'g'), '');

    const entries = Array.from({ length: 3000 }, (_, index) => ({
      id: `layer:${index}`,
      ip: `10.0.${Math.floor(index / 256)}.${index % 256}`,
      hostnames: [`host${index}.example.com`],
      enabled: true,
      layerId: 'layer',
      source: 'external' as const,
    }));

    const output = renderEntryTable(entries);
    const lines = stripAnsi(output).split('\n');
    expect(lines).toHaveLength(3001);
    const columnStart = (line: string, text: string): number => line.indexOf(text);
    expect(columnStart(lines[0]!, 'HOSTNAMES')).toBe(columnStart(lines[1]!, 'host0.example.com'));
    expect(columnStart(lines[0]!, 'STATUS')).toBe(columnStart(lines[3000]!, 'enabled'));
  });

  it('list 表格显示展示序号与所属方案，超长方案名被截断且不串列', () => {
    const esc = String.fromCharCode(27);
    const stripAnsi = (text: string): string =>
      text.replace(new RegExp(`${esc}\\[[0-9;]*m`, 'g'), '');
    const longLayer = `layer-${'x'.repeat(40)}`;

    const entries = [
      {
        id: 'a',
        ip: '10.0.0.1',
        hostnames: ['a.example.com'],
        enabled: true,
        layerId: 'default',
        source: 'managed' as const,
      },
      {
        id: 'b',
        ip: '10.0.0.2',
        hostnames: ['b.example.com'],
        enabled: false,
        layerId: longLayer,
        source: 'managed' as const,
      },
      {
        id: 'c',
        ip: '10.0.0.3',
        hostnames: ['c.example.com'],
        enabled: true,
        layerId: 'default',
        source: 'external' as const,
      },
    ];

    const lines = stripAnsi(renderEntryTable(entries, { index: true })).split('\n');
    const cells = (line: string): string[] => line.split('│').map((cell) => cell.trim());
    const header = lines.findIndex((line) => line.includes('PROFILE'));
    expect(header).toBeGreaterThanOrEqual(0);
    // cli-table3 在每行之间插分隔线，因此数据行步长为 2。
    const firstRow = lines[header + 2]!;
    const secondRow = lines[header + 4]!;
    const thirdRow = lines[header + 6]!;
    expect(cells(firstRow)[1]).toBe('1');
    expect(cells(firstRow)[4]).toBe('default');
    // 超长方案名截断为 24 个可见字符（含省略号）。
    expect(cells(secondRow)[4]).toContain('…');
    expect(cells(secondRow)[4]).not.toBe(longLayer);
    expect(cells(secondRow)[2]).toBe('10.0.0.2');
    // 非托管行不属于任何方案。
    expect(cells(thirdRow)[4]).toBe('-');
    // 未启用序号时不出现 # 列。
    expect(stripAnsi(renderEntryTable(entries)).split('\n')[0]).not.toContain('#');
  });

  it('各命令只声明自己真正会用到的共享选项', async () => {
    const flagsOf = async (name: string, path: string[] = []): Promise<string[]> => {
      const program = new Command();
      const entry = COMMAND_ENTRIES.find((item) => item.name === name);
      expect(entry).toBeDefined();
      await entry!.register(program);
      let command = program.commands.find((item) => item.name() === name);
      for (const segment of path) {
        command = command?.commands.find((item) => item.name() === segment);
      }
      expect(command).toBeDefined();
      return command!.options
        .map((option) => option.long)
        .filter((value): value is string => typeof value === 'string');
    };

    // 只读命令不该声明 --skip-dns-flush；只读数据目录的命令不该声明 --file。
    const list = await flagsOf('list');
    expect(list).toEqual(
      expect.arrayContaining([
        '--file',
        '--data-dir',
        '--json',
        '--on-conflict',
        '--profile',
        '--all-profiles',
      ]),
    );
    expect(list).not.toContain('--skip-dns-flush');
    expect(await flagsOf('doctor')).not.toContain('--skip-dns-flush');
    expect(await flagsOf('backup')).not.toContain('--skip-dns-flush');

    const profileList = await flagsOf('profile', ['list']);
    expect(profileList).toEqual(expect.arrayContaining(['--data-dir', '--json']));
    expect(profileList).not.toContain('--file');
    expect(profileList).not.toContain('--skip-dns-flush');
    expect(await flagsOf('config', ['show'])).not.toContain('--file');
    expect(await flagsOf('ttl', ['pause'])).not.toContain('--file');

    // 写 hosts 的命令保留完整工作区选项，并支持 --verify / --no-verify。
    const add = await flagsOf('add');
    expect(add).toEqual(
      expect.arrayContaining([
        '--file',
        '--data-dir',
        '--skip-dns-flush',
        '--profile',
        '--layer',
        '--verify',
        '--no-verify',
      ]),
    );
    expect(await flagsOf('ttl', ['tick'])).toEqual(
      expect.arrayContaining(['--file', '--data-dir', '--skip-dns-flush', '--verify']),
    );

    // run 的子命令自己声明工作区选项，--help 才看得到；父命令仍可继承。
    expect(await flagsOf('run', ['list'])).toEqual(
      expect.arrayContaining(['--data-dir', '--json']),
    );
    expect(await flagsOf('run', ['gc'])).toEqual(
      expect.arrayContaining(['--file', '--data-dir', '--json']),
    );
  });
});
