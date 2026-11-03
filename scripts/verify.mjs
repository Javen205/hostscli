#!/usr/bin/env node
/**
 * 单一验证入口：本地、Docker、CI 都调用这里，避免三份各说各话的步骤列表。
 *
 * 用法：
 *   pnpm verify             # 完整验证（含安装）
 *   pnpm verify:fast        # 跳过安装（依赖已就绪）
 *   node scripts/verify.mjs --skip-install
 *   node scripts/verify.mjs --only=typecheck
 *
 * 约定：
 * - 每个步骤打印 `[i/N] 名称` 与耗时；失败立即停止并输出该步 stderr 尾部。
 * - `--skip-install` 只影响 install 步骤；e2e 永远不可跳过。
 * - e2e 内部还会校验 command-manifest.ts 与用例一一对应，缺用例直接失败。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

function pnpm(args) {
  return { command: 'pnpm', args };
}

function node(args) {
  return { command: process.execPath, args };
}

const STEPS = [
  { name: 'install', optional: true, ...pnpm(['install', '--frozen-lockfile']) },
  { name: 'build', ...pnpm(['build']) },
  { name: 'typecheck', ...pnpm(['typecheck']) },
  { name: 'lint', ...pnpm(['lint']) },
  { name: 'test', ...pnpm(['test']) },
  { name: 'format:check', ...pnpm(['format:check']) },
  { name: 'smoke', ...node(['scripts/smoke-ci.mjs']) },
  { name: 'e2e', ...node(['scripts/e2e-commands.mjs']) },
];

function parseArgs(argv) {
  const options = { skipInstall: false, only: null };
  for (const arg of argv) {
    if (arg === '--skip-install') {
      options.skipInstall = true;
    } else if (arg.startsWith('--only=')) {
      options.only = arg.slice('--only='.length);
    } else {
      console.error(`[verify] 未知参数：${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  return options;
}

function printUsage() {
  console.error('用法：node scripts/verify.mjs [--skip-install] [--only=<step>]');
  console.error(`可用步骤：${STEPS.map((step) => step.name).join(', ')}`);
}

function tail(text, max = 1500) {
  const value = (text ?? '').trim();
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

function runStep(step) {
  const started = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    env: process.env,
    // Windows 的 pnpm 是 .cmd，需要 shell 才能找到。
    shell: isWindows && step.command === 'pnpm',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const elapsed = Date.now() - started;
  if (result.error || result.status === null) {
    const reason = result.error?.message ?? '进程被信号中断';
    console.error(`[verify] 失败步骤：${step.name}（无法获取退出码：${reason}）`);
    return { ok: false, code: 1, elapsed };
  }
  if (result.status !== 0) {
    console.error(`[verify] 失败步骤：${step.name}（退出码 ${result.status}，耗时 ${elapsed} ms）`);
    if (result.stderr) console.error(`[verify] ${step.name} stderr 尾部：\n${tail(result.stderr)}`);
    return { ok: false, code: result.status, elapsed };
  }
  return { ok: true, code: 0, elapsed };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.only) {
    const step = STEPS.find((item) => item.name === options.only);
    if (!step) {
      console.error(`[verify] 未知步骤：${options.only}`);
      printUsage();
      process.exit(1);
    }
    console.log(`[verify] 只运行步骤：${step.name}`);
    const outcome = runStep(step);
    process.exit(outcome.ok ? 0 : outcome.code);
  }

  const total = STEPS.length;
  const startedAll = Date.now();
  console.log(`[verify] 共 ${total} 步，platform=${process.platform} node=${process.version}`);

  for (const [index, step] of STEPS.entries()) {
    const label = `[${index + 1}/${total}] ${step.name}`;
    if (step.optional && options.skipInstall) {
      console.log(`${label}（跳过：--skip-install）`);
      continue;
    }
    console.log(`${label} …`);
    const outcome = runStep(step);
    if (!outcome.ok) {
      console.error(`[verify] 已中止：${step.name} 未通过，后续步骤未执行。`);
      process.exit(outcome.code);
    }
    console.log(`${label} 通过（${outcome.elapsed} ms）`);
  }

  const elapsed = Date.now() - startedAll;
  console.log(`[verify] 全部 ${total} 步通过（总耗时 ${elapsed} ms）`);
}

main();
