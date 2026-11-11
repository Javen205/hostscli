import type { Command } from 'commander';

/**
 * 命令清单只保存名称、描述和加载器，入口据此按需动态导入命令模块。
 * 这样 `--version` / `--help` / 未知命令不必加载 core、表格库与 YAML。
 *
 * 新增一级命令时：在这里追加一条，并同步在 cli 测试里断言描述未漂移。
 */
export interface CommandEntry {
  name: string;
  description: string;
  register: (program: Command) => Promise<void>;
}

export const COMMAND_ENTRIES: CommandEntry[] = [
  {
    name: 'list',
    description: '列出托管区与非托管区的 hosts 条目',
    register: async (program) => (await import('./commands/list')).registerListCommand(program),
  },
  {
    name: 'add',
    description: '在托管区块中新增一条记录（多个主机名按每行一个写入）',
    register: async (program) => (await import('./commands/add')).registerAddCommand(program),
  },
  {
    name: 'remove',
    description: '从托管区块移除记录（整条记录）',
    register: async (program) => (await import('./commands/remove')).registerRemoveCommand(program),
  },
  {
    name: 'enable',
    description: '启用托管区块中的记录（并清除 TTL）',
    register: async (program) => (await import('./commands/enable')).registerEnableCommand(program),
  },
  {
    name: 'disable',
    description: '禁用托管记录；提供 --for 时到期自动恢复',
    register: async (program) =>
      (await import('./commands/disable')).registerDisableCommand(program),
  },
  {
    name: 'init',
    description: '初始化数据目录与托管区块（幂等）',
    register: async (program) => (await import('./commands/init')).registerInitCommand(program),
  },
  {
    name: 'apply',
    description: '按当前生效规则重建托管区块',
    register: async (program) => (await import('./commands/init')).registerApplyCommand(program),
  },
  {
    name: 'backup',
    description: '手动创建 hosts 备份',
    register: async (program) => (await import('./commands/backup')).registerBackupCommand(program),
  },
  {
    name: 'restore',
    description: '从备份恢复 hosts 文件',
    register: async (program) =>
      (await import('./commands/restore')).registerRestoreCommand(program),
  },
  {
    name: 'profile',
    description: '管理方案（规则集）',
    register: async (program) =>
      (await import('./commands/profile')).registerProfileCommand(program),
  },
  {
    name: 'ttl',
    description: '管理单条记录的 TTL 定时禁用',
    register: async (program) => (await import('./commands/ttl')).registerTtlCommand(program),
  },
  {
    name: 'stack',
    description: '规则栈：多层规则、优先级与冲突裁决',
    register: async (program) => (await import('./commands/stack')).registerStackCommand(program),
  },
  {
    name: 'doctor',
    description: '三路解析对比：托管规则 / 系统 DNS / 实际解析（只读）',
    register: async (program) => (await import('./commands/doctor')).registerDoctorCommand(program),
  },
  {
    name: 'remote',
    description: '管理远程 hosts 订阅（拉取为规则层）',
    register: async (program) => (await import('./commands/remote')).registerRemoteCommand(program),
  },
  {
    name: 'dns',
    description: 'DNS 缓存操作',
    register: async (program) => (await import('./commands/dns')).registerDnsCommand(program),
  },
  {
    name: 'config',
    description: '查看与修改配置',
    register: async (program) => (await import('./commands/config')).registerConfigCommand(program),
  },
  {
    name: 'network',
    description: '按 Wi-Fi SSID 自动切换规则层（macOS/Linux）',
    register: async (program) =>
      (await import('./commands/network')).registerNetworkCommand(program),
  },
  {
    name: 'git',
    description: '数据目录快照（独立 git 仓库，不触碰系统 hosts）',
    register: async (program) => (await import('./commands/git')).registerGitCommand(program),
  },
  {
    name: 'export',
    description: '导出 config / state / profiles 快照（便于迁移与版本库管理）',
    register: async (program) => (await import('./commands/export')).registerExportCommand(program),
  },
  {
    name: 'audit',
    description: '写入审计：一致性检查、查询、导出',
    register: async (program) => (await import('./commands/audit')).registerAuditCommand(program),
  },
  {
    name: 'undo',
    description: '撤销最近 N 次成功写入（hosts + state + 相关方案）',
    register: async (program) => (await import('./commands/undo')).registerUndoCommand(program),
  },
  {
    name: 'run',
    description: '命令存活期间临时生效的 hosts 条目（退出后自动移除）',
    register: async (program) => (await import('./commands/run')).registerRunCommand(program),
  },
  {
    name: 'completion',
    description: '输出 shell 补全脚本（bash / zsh / fish / powershell；cmd 为 doskey 宏）',
    register: async (program) =>
      (await import('./commands/completion')).registerCompletionCommand(program),
  },
];

export function findCommandEntry(name: string): CommandEntry | undefined {
  return COMMAND_ENTRIES.find((entry) => entry.name === name);
}

/** 顶层帮助只需要名称与描述，不加载任何命令模块。 */
export function registerCommandPlaceholders(program: Command): void {
  for (const entry of COMMAND_ENTRIES) {
    program.command(entry.name).description(entry.description);
  }
}
