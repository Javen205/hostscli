import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { COMMAND_ENTRIES } from '../command-manifest';

describe('命令清单', () => {
  it('清单与真实注册的命令名称、描述保持一致', async () => {
    const program = new Command();
    for (const entry of COMMAND_ENTRIES) {
      await entry.register(program);
    }

    const registered = new Map(
      program.commands.map((command) => [command.name(), command.description()]),
    );

    expect([...registered.keys()].sort()).toEqual(
      COMMAND_ENTRIES.map((entry) => entry.name).sort(),
    );
    for (const entry of COMMAND_ENTRIES) {
      expect(registered.get(entry.name)).toBe(entry.description);
    }
  });
});
