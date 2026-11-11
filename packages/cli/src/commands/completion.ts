import type { Command } from 'commander';
import { COMMAND_ENTRIES } from '../command-manifest';

/**
 * 直接取命令清单，避免补全脚本与真实命令列表漂移
 * （此前手工维护的列表漏掉了 run / undo）。
 */
const COMMANDS = COMMAND_ENTRIES.map((entry) => entry.name);

/** 全局安装后 bin 里同时有这两个名字，补全脚本要覆盖两者。 */
export const COMPLETION_BIN_NAMES = ['hostscli', 'hosts-cli'] as const;

/**
 * 二级子命令。与真实注册保持同步由测试兜底：测试会真正 register 一遍命令，
 * 逐个比对这里的列表，漏写或多写都会失败。
 * `stack layer` 是三级，用空格拼成键。
 */
export const SUBCOMMANDS: Record<string, string[]> = {
  profile: ['list', 'show', 'create', 'use', 'save', 'move', 'update', 'remove'],
  ttl: ['list', 'due', 'pause', 'resume', 'extend', 'restore', 'cancel', 'tick'],
  stack: ['layer', 'apply', 'explain'],
  'stack layer': ['add', 'enable', 'disable', 'list'],
  remote: ['add', 'list', 'remove', 'update'],
  dns: ['flush'],
  config: ['show', 'set', 'keys'],
  network: ['status', 'map', 'unmap', 'auto'],
  git: ['init', 'status', 'snapshot', 'log', 'diff', 'rollback'],
  audit: ['list', 'show', 'verify', 'export'],
  run: ['list', 'gc'],
};

/** 静态枚举值（取不到动态值时的兜底，多个命令取并集）。 */
export const OPTION_VALUES: Record<string, string[]> = {
  '--on-conflict': ['fail', 'highest-priority', 'first-wins', 'last-wins'],
  '--format': ['json', 'yaml', 'ndjson'],
  '--result': ['ok', 'failed'],
};

/** 位置参数取值：`completion <shell>`。 */
export const POSITIONAL_VALUES: Record<string, string[]> = {
  completion: ['bash', 'zsh', 'fish', 'powershell', 'cmd'],
};

/** 需要补全 profile id 的选项；PowerShell 下按数据目录动态读取。 */
const PROFILE_VALUE_OPTIONS = ['--profile', '--layer', '--from', '--to'];

const BASH_SCRIPT = `# hostscli / hosts-cli bash completion
_hostscli_completions() {
  local cur prev top second commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  top="\${COMP_WORDS[1]}"
  second="\${COMP_WORDS[2]}"
  commands="${COMMANDS.join(' ')}"

  case "$prev" in
    --on-conflict) COMPREPLY=( $(compgen -W "${OPTION_VALUES['--on-conflict']!.join(' ')}" -- "$cur") ); return ;;
    --format) COMPREPLY=( $(compgen -W "${OPTION_VALUES['--format']!.join(' ')}" -- "$cur") ); return ;;
    --result) COMPREPLY=( $(compgen -W "${OPTION_VALUES['--result']!.join(' ')}" -- "$cur") ); return ;;
  esac

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi

  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$top" in
${Object.entries({ ...SUBCOMMANDS, ...POSITIONAL_VALUES })
  .filter(([key]) => !key.includes(' '))
  .map(
    ([key, values]) =>
      `      ${key}) COMPREPLY=( $(compgen -W "${values.join(' ')}" -- "$cur") ) ;;`,
  )
  .join('\n')}
      *) COMPREPLY=() ;;
    esac
    return
  fi

  if [ "$top" = "stack" ] && [ "$second" = "layer" ] && [ "$COMP_CWORD" -eq 3 ]; then
    COMPREPLY=( $(compgen -W "${SUBCOMMANDS['stack layer']!.join(' ')}" -- "$cur") )
    return
  fi

  COMPREPLY=()
}
complete -o default -F _hostscli_completions hostscli hosts-cli
`;

const ZSH_SCRIPT = `#compdef hostscli hosts-cli
# hostscli / hosts-cli zsh completion
_hostscli() {
  local -a commands
  commands=(
${COMMANDS.map((command) => `    '${command}'`).join('\n')}
  )

  case "\${words[CURRENT-1]}" in
    --on-conflict) _values 'strategy' ${OPTION_VALUES['--on-conflict']!.join(' ')}; return ;;
    --format) _values 'format' ${OPTION_VALUES['--format']!.join(' ')}; return ;;
    --result) _values 'result' ${OPTION_VALUES['--result']!.join(' ')}; return ;;
  esac

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  if (( CURRENT == 3 )); then
    case "\${words[2]}" in
${Object.entries({ ...SUBCOMMANDS, ...POSITIONAL_VALUES })
  .filter(([key]) => !key.includes(' '))
  .map(([key, values]) => `      ${key}) _values 'subcommand' ${values.join(' ')}; return ;;`)
  .join('\n')}
    esac
  fi

  if [[ "\${words[2]}" == "stack" && "\${words[3]}" == "layer" ]] && (( CURRENT == 4 )); then
    _values 'subcommand' ${SUBCOMMANDS['stack layer']!.join(' ')}
    return
  fi
}
compdef _hostscli hostscli hosts-cli
`;

function fishScript(): string {
  const lines: string[] = ['# hostscli / hosts-cli fish completion'];
  for (const bin of COMPLETION_BIN_NAMES) {
    lines.push(`complete -c ${bin} -f -n '__fish_use_subcommand' -a '${COMMANDS.join(' ')}'`);
    for (const [key, values] of Object.entries({ ...SUBCOMMANDS, ...POSITIONAL_VALUES })) {
      const triggers = key.split(' ');
      const condition = triggers
        .map((item) => `__fish_seen_subcommand_from ${item}`)
        .join('; and ');
      lines.push(`complete -c ${bin} -f -n '${condition}' -a '${values.join(' ')}'`);
    }
    for (const [option, values] of Object.entries(OPTION_VALUES)) {
      lines.push(`complete -c ${bin} -l ${option.replace(/^--/, '')} -x -a '${values.join(' ')}'`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function powershellScript(): string {
  const psArray = (values: string[]): string =>
    `@(${values.map((item) => `'${item}'`).join(', ')})`;
  const hashtable = (entries: Array<[string, string[]]>, indent = '  '): string =>
    ['@{', ...entries.map(([key, values]) => `${indent}'${key}' = ${psArray(values)}`), '}'].join(
      '\n',
    );

  return `# hostscli / hosts-cli PowerShell completion
# 启用：hostscli completion powershell | Out-String | Invoke-Expression
# 可选：把上面这行写进 $PROFILE，每次启动自动加载。
$global:HostsCliCommands = ${psArray(COMMANDS)}
$global:HostsCliSubcommands = ${hashtable(Object.entries(SUBCOMMANDS))}
$global:HostsCliOptionValues = ${hashtable(Object.entries(OPTION_VALUES))}
$global:HostsCliPositionalValues = ${hashtable(Object.entries(POSITIONAL_VALUES))}
$global:HostsCliProfileOptions = ${psArray(PROFILE_VALUE_OPTIONS)}

function global:Get-HostsCliProfiles {
  $root = if ($env:HOSSCLI_HOME) { $env:HOSSCLI_HOME } else { Join-Path $HOME '.hostscli' }
  $dir = Join-Path $root 'profiles'
  if (-not (Test-Path -LiteralPath $dir)) { return @() }
  Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.BaseName }
}

$global:HostsCliCompleter = {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  if ($wordToComplete -ne '' -and $tokens.Count -gt 0) {
    $tokens = @($tokens | Select-Object -First ($tokens.Count - 1))
  }
  $prev = if ($tokens.Count -ge 2) { $tokens[$tokens.Count - 1] } else { '' }
  $commandPath = @($tokens | Select-Object -Skip 1 | Where-Object { -not $_.StartsWith('-') })

  $candidates = @()
  if ($wordToComplete.StartsWith('-')) {
    $candidates = @('--file', '--data-dir', '--json', '--dry-run', '--verify', '--no-verify',
      '--skip-dns-flush', '--on-conflict', '--layer', '--profile', '--all-profiles', '--force',
      '--comment', '--yes', '--help')
  } elseif ($global:HostsCliOptionValues.ContainsKey($prev)) {
    $candidates = $global:HostsCliOptionValues[$prev]
  } elseif ($global:HostsCliProfileOptions -contains $prev) {
    $candidates = @(Get-HostsCliProfiles)
  } else {
    $key = ($commandPath -join ' ').Trim()
    if ($key -eq '') {
      $candidates = $global:HostsCliCommands
    } elseif ($global:HostsCliSubcommands.ContainsKey($key)) {
      $candidates = $global:HostsCliSubcommands[$key]
    } elseif ($global:HostsCliPositionalValues.ContainsKey($key)) {
      $candidates = $global:HostsCliPositionalValues[$key]
    }
  }

  $candidates | Where-Object { $_ -like ($wordToComplete + '*') } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}

Register-ArgumentCompleter -Native -CommandName hostscli,hosts-cli -ScriptBlock $global:HostsCliCompleter
`;
}

function cmdScript(): string {
  const macros = [
    ['h', 'hostscli'],
    ['hc', 'hosts-cli'],
    ...COMMANDS.map((command) => [`h${command}`, `hostscli ${command}`]),
  ];
  return `@echo off
rem ============================================================
rem hostscli / hosts-cli 的 cmd 宏（不是补全）
rem
rem 说明：cmd.exe 没有可编程的命令名补全接口，做不到真正的 Tab 补全。
rem 本文件只提供 doskey 宏和一个命令速查，属于"宏级别"的近似方案。
rem 宏只在当前 cmd 会话有效；关闭窗口后失效。
rem
rem 启用：
rem   hostscli completion cmd > hostscli-macros.cmd
rem   call hostscli-macros.cmd
rem 想每次打开 cmd 自动加载，可把 call 命令写进注册表
rem   HKCU\\Software\\Microsoft\\Command Processor\\AutoRun
rem ============================================================

rem 命令速查（等价的完整写法）
rem   hostscli list / add / remove / enable / disable
rem   hostscli profile list|show|create|use|save|move|update|remove
rem   hostscli ttl list|due|pause|resume|extend|restore|cancel|tick
rem   hostscli stack layer|apply|explain
rem   hostscli remote add|list|remove|update
rem   hostscli dns flush
rem   hostscli config show|set|keys
rem   hostscli network status|map|unmap|auto
rem   hostscli doctor / backup / restore / init / apply
rem   hostscli git init|status|snapshot|log|diff|rollback
rem   hostscli export / audit / undo / run / completion

${macros.map(([name, command]) => `doskey ${name}=${command} $*`).join('\n')}
`;
}

export type CompletionShell = 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd';

export const COMPLETION_SHELLS: CompletionShell[] = ['bash', 'zsh', 'fish', 'powershell', 'cmd'];

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case 'bash':
      return BASH_SCRIPT;
    case 'zsh':
      return ZSH_SCRIPT;
    case 'fish':
      return fishScript();
    case 'powershell':
      return powershellScript();
    case 'cmd':
      return cmdScript();
  }
}

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion <shell>')
    .description('输出 shell 补全脚本（bash / zsh / fish / powershell；cmd 为 doskey 宏）')
    .action((shell: string) => {
      if (!COMPLETION_SHELLS.includes(shell as CompletionShell)) {
        throw Object.assign(
          new Error('只支持 bash / zsh / fish / powershell / cmd（cmd 为 doskey 宏，非补全）。'),
          { code: 'INVALID_INPUT' },
        );
      }
      process.stdout.write(completionScript(shell as CompletionShell));
    });
}
