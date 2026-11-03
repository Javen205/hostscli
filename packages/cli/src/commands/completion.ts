import type { Command } from 'commander';

const COMMANDS = [
  'list',
  'add',
  'remove',
  'enable',
  'disable',
  'init',
  'apply',
  'backup',
  'restore',
  'profile',
  'ttl',
  'stack',
  'doctor',
  'remote',
  'dns',
  'config',
  'network',
  'git',
  'export',
  'audit',
  'completion',
] as const;

const BASH_SCRIPT = `# hostscli bash completion
_hostscli_completions() {
  local cur commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  commands="${COMMANDS.join(' ')}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
  fi
}
complete -F _hostscli_completions hostscli
`;

const ZSH_SCRIPT = `#compdef hostscli
# hostscli zsh completion
_hostscli() {
  local -a commands
  commands=(
${COMMANDS.map((command) => `    '${command}'`).join('\n')}
  )
  _describe 'command' commands
}
compdef _hostscli hostscli
`;

const FISH_SCRIPT = `# hostscli fish completion
complete -c hostscli -f -n '__fish_use_subcommand' -a '${COMMANDS.join(' ')}'
`;

export function completionScript(shell: 'bash' | 'zsh' | 'fish'): string {
  switch (shell) {
    case 'bash':
      return BASH_SCRIPT;
    case 'zsh':
      return ZSH_SCRIPT;
    case 'fish':
      return FISH_SCRIPT;
  }
}

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion <shell>')
    .description('输出 shell 补全脚本（bash / zsh / fish）')
    .action((shell: string) => {
      if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
        throw Object.assign(new Error('只支持 bash / zsh / fish。'), {
          code: 'INVALID_INPUT',
        });
      }
      process.stdout.write(completionScript(shell));
    });
}
