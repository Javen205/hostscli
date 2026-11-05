#!/usr/bin/env node
/**
 * 可复用的发布入口：预检 -> 质量闸门 -> 改版本 -> 打包体检 -> 提交推送 -> 等 CI -> 发布 -> 发布后验证。
 *
 * 用法：
 *   pnpm release --version 0.1.1
 *   pnpm release --bump patch
 *   pnpm release:dry --bump minor
 *   node scripts/release.mjs --dry-run --bump patch --skip-verify
 *   node scripts/release.mjs --version 0.2.0 --branch dev --ci-retries 2
 *
 * 前置条件：
 *   - 当前分支（默认 dev）工作区干净，且与 origin 同名分支完全一致（不领先、不落后）。
 *   - `npm whoami --registry=https://registry.npmjs.org` 已登录，且账号等于包 scope 属主。
 *   - `gh` 已登录并能读 Actions（--skip-ci 可跳过等待）。
 *   - `packages/cli/package.json` 的 `version` 是唯一权威版本来源。
 *
 * 退出码：
 *   0  成功
 *   1  参数 / 用法错误
 *   2  预检失败（脏工作区、分支不符、不同步、verify 失败、身份不符、registry 已存在该版本）
 *   3  提交 / 推送 / CI 失败（尚未发布）
 *   4  发布失败（npm publish 报错，含 E402 / E403 / E409，不做重试与改名）
 *   5  发布后验证失败（registry 未可见、临时前缀安装或命令实测失败）
 *
 * 不会做的事：
 *   - 不 force push、不改写历史、不 reset 远端。
 *   - 不做 npm unpublish，不换名、不换 scope，发布失败后不重试。
 *   - 不删除数据目录 `~/.hostscli`，不写真实 /etc/hosts。
 *   - 不自动改写文档里的版本号：发现旧版本引用时列出并以退出码 2 中止，
 *     由人确认后修改（确需跳过时用 --allow-version-refs）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = join(repoRoot, 'packages', 'cli');
const pkgPath = join(cliDir, 'package.json');
const REGISTRY = 'https://registry.npmjs.org';
const TOTAL_STEPS = 8;
const isWindows = process.platform === 'win32';
const cliBinary = isWindows ? 'hostscli.cmd' : 'hostscli';

const EXIT = {
  OK: 0,
  USAGE: 1,
  PREFLIGHT: 2,
  GIT_OR_CI: 3,
  PUBLISH: 4,
  POST_PUBLISH: 5,
};

const USAGE = `用法：
  node scripts/release.mjs --version <x.y.z> [选项]
  node scripts/release.mjs --bump <patch|minor|major> [选项]

选项：
  --version <x.y.z>        显式目标版本（与 --bump 二选一）
  --bump <kind>            基于 packages/cli/package.json 当前版本递增
  --branch <name>          目标分支，默认 dev
  --skip-verify            跳过 node scripts/verify.mjs（会打印警告）
  --skip-ci                跳过 CI 等待（会打印警告）
  --dry-run                只做只读检查并打印计划，不写文件、不提交、不推送、不发布
  --ci-retries <n>         CI 失败/取消时的重跑次数，默认 2，范围 0-5
  --propagation-timeout <s> 发布后等待 registry 可见的秒数，默认 600
  --allow-version-refs     允许仓库内存在旧版本号引用（默认会中止）
  --help                   打印本帮助
`;

const state = {
  originalText: null,
  versionWritten: false,
  committed: false,
  published: false,
  ciRunId: null,
};

class ReleaseError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = '') {
  throw new ReleaseError(code, message, detail);
}

function tail(text, max = 1800) {
  const value = (text ?? '').trim();
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 30 * 60 * 1000,
    env: process.env,
    // Windows 上 npm / pnpm / gh 是 .cmd，需要 shell 才能解析。
    shell: isWindows && ['npm', 'pnpm', 'gh'].includes(command),
  });
  return { ...result, elapsed: Date.now() - started };
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `退出码 ${result.status}`;
    fail(
      options.code ?? EXIT.GIT_OR_CI,
      `${command} ${args.join(' ')} 失败：${reason}`,
      tail(result.stderr),
    );
  }
  return result;
}

function git(args, options = {}) {
  return mustRun('git', args, { cwd: repoRoot, ...options }).stdout.trim();
}

let stepIndex = 0;
function step(label) {
  stepIndex += 1;
  process.stdout.write(`[${stepIndex}/${TOTAL_STEPS}] ${label}\n`);
  return Date.now();
}

function done(started, extra = '') {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`      ok（${elapsed}s）${extra ? ` ${extra}` : ''}\n`);
}

function note(message) {
  process.stdout.write(`      ${message}\n`);
}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        version: { type: 'string' },
        bump: { type: 'string' },
        branch: { type: 'string', default: 'dev' },
        'skip-verify': { type: 'boolean', default: false },
        'skip-ci': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'ci-retries': { type: 'string', default: '2' },
        'propagation-timeout': { type: 'string', default: '600' },
        'allow-version-refs': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    fail(EXIT.USAGE, error.message);
  }

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(EXIT.OK);
  }
  if (values.version && values.bump) {
    fail(EXIT.USAGE, '--version 与 --bump 只能二选一');
  }
  if (!values.version && !values.bump) {
    fail(EXIT.USAGE, '必须指定 --version <x.y.z> 或 --bump <patch|minor|major>');
  }
  if (values.bump && !['patch', 'minor', 'major'].includes(values.bump)) {
    fail(EXIT.USAGE, `未知的 --bump 值：${values.bump}（可用 patch / minor / major）`);
  }
  if (values.version && !/^\d+\.\d+\.\d+$/.test(values.version)) {
    fail(EXIT.USAGE, `--version 必须是 x.y.z 形式，收到：${values.version}`);
  }
  const retries = Number(values['ci-retries']);
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    fail(EXIT.USAGE, `--ci-retries 必须是 0-5 的整数，收到：${values['ci-retries']}`);
  }
  const timeout = Number(values['propagation-timeout']);
  if (!Number.isInteger(timeout) || timeout < 60) {
    fail(EXIT.USAGE, `--propagation-timeout 至少 60 秒，收到：${values['propagation-timeout']}`);
  }
  return { ...values, ciRetries: retries, propagationTimeout: timeout };
}

function bumpVersion(current, kind) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function npmView(spec, fields = ['version']) {
  return run('npm', ['view', spec, ...fields, '--registry', REGISTRY]);
}

function resolveGh() {
  const probe = run('gh', ['--version'], { timeout: 20 * 1000 });
  if (!probe.error && probe.status === 0) return 'gh';
  const fallback = join(homedir(), '.local', 'bin', 'gh');
  return existsSync(fallback) ? fallback : null;
}

function remoteRunId(gh, branch, sha) {
  const listed = run(
    gh,
    [
      'run',
      'list',
      '--branch',
      branch,
      '--limit',
      '10',
      '--json',
      'databaseId,headSha,status,conclusion',
    ],
    { timeout: 60 * 1000 },
  );
  if (listed.status !== 0) {
    fail(EXIT.GIT_OR_CI, 'gh run list 失败', tail(listed.stderr));
  }
  let runs;
  try {
    runs = JSON.parse(listed.stdout);
  } catch {
    fail(EXIT.GIT_OR_CI, 'gh run list 返回无法解析的 JSON', tail(listed.stdout));
  }
  return runs.find((entry) => entry.headSha === sha)?.databaseId ?? null;
}

function waitForRun(gh, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const viewed = run(gh, ['run', 'view', String(runId), '--json', 'status,conclusion,jobs'], {
      timeout: 60 * 1000,
    });
    if (viewed.status !== 0) {
      fail(EXIT.GIT_OR_CI, `gh run view ${runId} 失败`, tail(viewed.stderr));
    }
    let data;
    try {
      data = JSON.parse(viewed.stdout);
    } catch {
      fail(EXIT.GIT_OR_CI, 'gh run view 返回无法解析的 JSON', tail(viewed.stdout));
    }
    if (data.status === 'completed') return data;
    note(`CI 进行中（${data.status}）…`);
    sleep(20 * 1000);
  }
  fail(EXIT.GIT_OR_CI, `等待 CI run ${runId} 超时`);
}

function assertPack(files, packedSize) {
  const paths = files.map((file) => file.path);
  const unpackedSize = files.reduce((sum, file) => sum + file.size, 0);
  const problems = [];

  if (paths.length < 80 || paths.length > 250) {
    problems.push(`文件数 ${paths.length} 不在 80-250 之间`);
  }
  if (packedSize > 3 * 1024 * 1024) {
    problems.push(`压缩体积 ${(packedSize / 1024 / 1024).toFixed(1)} MB 超过 3MB`);
  }
  if (unpackedSize > 8 * 1024 * 1024) {
    problems.push(`解包体积 ${(unpackedSize / 1024 / 1024).toFixed(1)} MB 超过 8MB`);
  }
  for (const required of ['dist/index.js', 'README.md', 'LICENSE', 'package.json']) {
    if (!paths.includes(required)) problems.push(`缺少必需文件 ${required}`);
  }
  const forbidden = paths.filter(
    (path) =>
      path.startsWith('src/') ||
      path.includes('/__tests__/') ||
      /\.test\.|\.spec\./.test(path) ||
      path.startsWith('docs/dev/') ||
      path.endsWith('.tgz') ||
      path === '.env' ||
      path.startsWith('.env.'),
  );
  if (forbidden.length > 0) problems.push(`包含不该发布的文件：${forbidden.join(', ')}`);
  return problems;
}

function writeVersion(text, version) {
  const next = text.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
  if (next === text) fail(EXIT.PREFLIGHT, '未能在 package.json 中定位 version 字段');
  writeFileSync(pkgPath, next);
}

function findVersionReferences(oldVersion) {
  // 用边界匹配，避免把 10.1.0.1 这类 IP / 依赖版本号当成产品版本。
  const escaped = oldVersion.replace(/\./g, '\\.');
  const result = run('git', ['grep', '-n', '-E', `(^|[^0-9.])${escaped}([^0-9.]|$)`], {
    cwd: repoRoot,
  });
  if (result.status === 0) {
    return result.stdout
      .split('\n')
      .filter((line) => !line.startsWith('pnpm-lock.yaml:'))
      .filter((line) => !line.startsWith('packages/cli/package.json:'))
      .filter(Boolean);
  }
  if (result.status === 1) return [];
  fail(EXIT.PREFLIGHT, 'git grep 扫描版本引用失败', tail(result.stderr));
}

function repoSlug() {
  const url = git(['remote', 'get-url', 'origin']);
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const dryRun = options['dry-run'];
  const branch = options.branch;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const name = pkg.name;
  const currentVersion = pkg.version;
  const targetVersion = options.version ?? bumpVersion(currentVersion, options.bump);
  const scopeOwner = name.startsWith('@') ? name.split('/')[0].slice(1) : null;
  const slug = repoSlug();

  if (dryRun) note('dry-run：只做只读检查并打印计划，不写文件、不提交、不推送、不发布');

  // [1/8] 预检
  let started = step(`预检（${name} ${currentVersion} -> ${targetVersion}）`);
  if (git(['status', '--porcelain']) !== '') {
    fail(EXIT.PREFLIGHT, '工作区不干净，请先提交或暂存改动', tail(git(['status', '--short'])));
  }
  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch !== branch) {
    fail(EXIT.PREFLIGHT, `当前分支 ${currentBranch} 不是 ${branch}（可用 --branch 指定）`);
  }
  git(['fetch', 'origin', branch]);
  const headSha = git(['rev-parse', 'HEAD']);
  const remoteSha = git(['rev-parse', `origin/${branch}`]);
  if (headSha !== remoteSha) {
    const counts = git(['rev-list', '--left-right', '--count', `${headSha}...${remoteSha}`]);
    fail(
      EXIT.PREFLIGHT,
      `本地与 origin/${branch} 不一致（本地/远端独有提交数 ${counts}），请先同步`,
    );
  }
  note(`分支 ${branch} @ ${headSha.slice(0, 7)}，与 origin/${branch} 一致`);

  const who = run('npm', ['whoami', '--registry', REGISTRY]);
  if (who.status !== 0) {
    fail(EXIT.PREFLIGHT, 'npm whoami 失败（未登录官方 registry？）', tail(who.stderr));
  }
  const account = who.stdout.trim().toLowerCase();
  if (scopeOwner && account !== scopeOwner.toLowerCase()) {
    fail(EXIT.PREFLIGHT, `当前 npm 账号 ${account} 与 scope 属主 @${scopeOwner} 不一致`);
  }
  note(`npm 身份 ${account}`);

  const existing = npmView(`${name}@${targetVersion}`);
  if (existing.status === 0) {
    fail(EXIT.PREFLIGHT, `registry 已存在 ${name}@${targetVersion}，请换版本号`);
  }
  if (!/E404|404 Not Found/i.test(existing.stderr ?? '')) {
    fail(EXIT.PREFLIGHT, `查询 ${name}@${targetVersion} 失败且不是 404`, tail(existing.stderr));
  }
  note(`版本 ${targetVersion} 在 registry 上不可见（可用）`);
  done(started);

  // [2/8] 质量闸门
  started = step('质量闸门（node scripts/verify.mjs）');
  if (options['skip-verify']) {
    note('警告：--skip-verify 已跳过验证，风险由操作者承担');
  } else {
    const verified = run(process.execPath, ['scripts/verify.mjs'], { timeout: 60 * 60 * 1000 });
    if (verified.status !== 0) {
      fail(EXIT.PREFLIGHT, 'verify 未通过，拒绝发布', tail(verified.stderr));
    }
  }
  done(started);

  // [3/8] 版本写回
  started = step(`版本写回（${currentVersion} -> ${targetVersion}）`);
  state.originalText = readFileSync(pkgPath, 'utf8');
  if (dryRun) {
    note(`将把 packages/cli/package.json 的 version 改为 ${targetVersion}（dry-run 未写入）`);
  } else {
    writeVersion(state.originalText, targetVersion);
    state.versionWritten = true;
    note('已更新 packages/cli/package.json');
  }
  const references = findVersionReferences(currentVersion);
  if (references.length > 0) {
    note(`发现 ${references.length} 处旧版本 ${currentVersion} 引用：`);
    note(references.map((line) => `       ${line}`).join('\n'));
    if (!options['allow-version-refs'] && !dryRun) {
      fail(
        EXIT.PREFLIGHT,
        `仓库内仍有旧版本引用，已回滚版本改动；请更新后重试（或 --allow-version-refs）`,
      );
    }
  } else {
    note('未发现其他硬编码旧版本引用');
  }
  done(started);

  // [4/8] 打包体检
  started = step('打包体检（npm pack --dry-run --json）');
  const packed = run('npm', ['pack', '--dry-run', '--json'], { cwd: cliDir });
  if (packed.status !== 0) {
    fail(EXIT.PREFLIGHT, 'npm pack --dry-run 失败', tail(packed.stderr));
  }
  let manifest;
  try {
    manifest = JSON.parse(packed.stdout.trim())[0];
  } catch {
    fail(EXIT.PREFLIGHT, 'npm pack --dry-run 未返回可解析的 JSON', tail(packed.stdout));
  }
  const problems = assertPack(manifest.files, manifest.size);
  if (problems.length > 0) {
    fail(EXIT.PREFLIGHT, `打包体检不通过：${problems.join('；')}`);
  }
  const entryPath = join(cliDir, 'dist', 'index.js');
  if (!readFileSync(entryPath, 'utf8').startsWith('#!')) {
    fail(EXIT.PREFLIGHT, 'dist/index.js 缺少 shebang');
  }
  if (!isWindows && (statSync(entryPath).mode & 0o111) === 0) {
    fail(EXIT.PREFLIGHT, 'dist/index.js 没有可执行位');
  }
  note(
    `${manifest.files.length} 个文件，解包 ${(manifest.unpackedSize / 1024 / 1024).toFixed(1)} MB，压缩 ${(manifest.size / 1024).toFixed(1)} kB`,
  );
  done(started);

  // [5/8] 提交与推送
  started = step('提交与推送（普通推送，禁止 force）');
  const message = `chore(release): 发布 ${name}@${targetVersion}`;
  if (dryRun) {
    note(`将执行 git add packages/cli/package.json && git commit -m "${message}"`);
    note(`将执行 git push origin ${branch}`);
  } else {
    mustRun('git', ['add', pkgPath], { cwd: repoRoot });
    mustRun('git', ['commit', '-m', message], { cwd: repoRoot });
    state.committed = true;
    const pushed = run('git', ['push', 'origin', branch], { cwd: repoRoot, timeout: 180 * 1000 });
    if (pushed.status !== 0) {
      fail(
        EXIT.GIT_OR_CI,
        'git push 被拒绝，不执行 force push',
        `${tail(pushed.stderr)}\n      恢复指引：本地提交仍在，git pull --rebase origin ${branch} 后手动推送`,
      );
    }
  }
  done(started);

  const releaseSha = dryRun ? headSha : git(['rev-parse', 'HEAD']);

  // [6/8] CI
  started = step(`CI（等待 ${releaseSha.slice(0, 7)} 的 run）`);
  if (options['skip-ci']) {
    note('警告：--skip-ci 已跳过 CI 等待');
  } else if (dryRun) {
    note('将等待该 sha 的 CI run；失败或取消时重跑 --failed（最多重试次数由 --ci-retries 决定）');
  } else {
    const gh = resolveGh();
    if (gh === null) {
      fail(EXIT.GIT_OR_CI, '找不到 gh CLI，无法等待 CI（可安装 gh 或用 --skip-ci）');
    }
    let runId = null;
    for (let attempt = 0; attempt < 6 && runId === null; attempt += 1) {
      runId = remoteRunId(gh, branch, releaseSha);
      if (runId === null) sleep(15 * 1000);
    }
    if (runId === null) fail(EXIT.GIT_OR_CI, `未找到 ${releaseSha.slice(0, 7)} 的 CI run`);
    state.ciRunId = runId;
    note(`CI run ${runId}`);

    let outcome = waitForRun(gh, runId, 45 * 60 * 1000);
    let attempts = 0;
    while (outcome.conclusion !== 'success' && attempts < options.ciRetries) {
      attempts += 1;
      note(
        `CI 结论 ${outcome.conclusion}，重跑 --failed（第 ${attempts}/${options.ciRetries} 次）`,
      );
      const failedOnly = run(gh, ['run', 'rerun', String(runId), '--failed'], {
        timeout: 60 * 1000,
      });
      if (failedOnly.status !== 0) {
        const full = run(gh, ['run', 'rerun', String(runId)], { timeout: 60 * 1000 });
        if (full.status !== 0) fail(EXIT.GIT_OR_CI, 'gh run rerun 失败', tail(full.stderr));
      }
      outcome = waitForRun(gh, runId, 45 * 60 * 1000);
    }
    if (outcome.conclusion !== 'success') {
      const bad = outcome.jobs
        .filter((job) => job.conclusion !== 'success')
        .map((job) => `${job.name}: ${job.conclusion}`);
      fail(EXIT.GIT_OR_CI, `CI 未通过，拒绝发布（${bad.join('；')}）`);
    }
    note(`CI 通过：${outcome.jobs.map((job) => `${job.name}=${job.conclusion}`).join('，')}`);
  }
  done(started);

  // [7/8] 发布
  started = step('发布（npm publish）');
  if (dryRun) {
    note(`将执行 cd packages/cli && npm publish --registry ${REGISTRY} --access public`);
  } else {
    const published = run('npm', ['publish', '--registry', REGISTRY, '--access', 'public'], {
      cwd: cliDir,
      timeout: 10 * 60 * 1000,
    });
    if (published.status !== 0) {
      fail(
        EXIT.PUBLISH,
        `npm publish 失败（退出码 ${published.status}），按约定不重试、不改名、不换 scope`,
        tail(published.stderr),
      );
    }
    state.published = true;
  }
  done(started);

  // [8/8] 发布后验证
  started = step('发布后验证（registry 可见 + 全新前缀安装）');
  const target = `${name}@${targetVersion}`;
  if (dryRun) {
    note(`将轮询 npm view ${target}，再用临时前缀安装并校验 --version 与 list rc`);
    done(started);
    printSummary({ dryRun, name, targetVersion, releaseSha, slug });
    return;
  }

  const deadline = Date.now() + options.propagationTimeout * 1000;
  let visible = null;
  while (Date.now() < deadline) {
    const viewed = npmView(target, ['version', 'dist.tarball']);
    if (viewed.status === 0) {
      visible = viewed.stdout.trim();
      break;
    }
    note('等待 registry 传播…');
    sleep(15 * 1000);
  }
  if (visible === null) {
    fail(
      EXIT.POST_PUBLISH,
      `已发布但 ${options.propagationTimeout}s 内仍不可读；稍后手动执行 npm view ${target} --registry ${REGISTRY}`,
    );
  }
  note(visible.replace(/\n/g, ' | '));

  const tempPrefix = mkdtempSync(join(tmpdir(), 'hostscli-release-'));
  try {
    mustRun('npm', ['i', '--prefix', tempPrefix, target, '--registry', REGISTRY], {
      timeout: 10 * 60 * 1000,
      code: EXIT.POST_PUBLISH,
    });
    const binPath = join(tempPrefix, 'node_modules', '.bin', cliBinary);
    const versionRun = run(binPath, ['--version'], { cwd: tempPrefix });
    if (versionRun.status !== 0 || versionRun.stdout.trim() !== targetVersion) {
      fail(
        EXIT.POST_PUBLISH,
        `安装后的 --version 不符：期望 ${targetVersion}，实得 ${(versionRun.stdout ?? '').trim() || `退出码 ${versionRun.status}`}`,
      );
    }
    const hostsPath = join(tempPrefix, 'hosts');
    const dataDir = join(tempPrefix, 'data');
    writeFileSync(hostsPath, '127.0.0.1 localhost\n');
    const listRun = run(binPath, ['list', '--file', hostsPath, '--data-dir', dataDir, '--json'], {
      cwd: tempPrefix,
    });
    if (listRun.status !== 0) {
      fail(EXIT.POST_PUBLISH, `安装后的 list 退出码 ${listRun.status}`, tail(listRun.stderr));
    }
    note(`临时前缀安装通过：--version=${targetVersion}，list rc=0`);
  } finally {
    rmSync(tempPrefix, { recursive: true, force: true });
  }

  const latest = npmView(name, ['dist-tags.latest']);
  if (latest.status === 0 && latest.stdout.trim() !== targetVersion) {
    note(`警告：dist-tags.latest 是 ${latest.stdout.trim()}，不是 ${targetVersion}`);
  }
  done(started);
  printSummary({ dryRun: false, name, targetVersion, releaseSha, slug });
}

function printSummary({ dryRun, name, targetVersion, releaseSha, slug }) {
  process.stdout.write('\n发布摘要\n');
  process.stdout.write(`  commit   : ${releaseSha}${dryRun ? '（dry-run 未产生新提交）' : ''}\n`);
  process.stdout.write(
    `  CI run   : ${state.ciRunId ? `${slug}/actions/runs/${state.ciRunId}` : '未等待'}\n`,
  );
  process.stdout.write(`  包地址   : https://www.npmjs.com/package/${name}/v/${targetVersion}\n`);
  process.stdout.write(`  安装命令 : npm i -g ${name}\n`);
  if (dryRun) process.stdout.write('  dry-run 未做任何写操作。\n');
}

try {
  await main();
} catch (error) {
  if (error instanceof ReleaseError) {
    process.stderr.write(`\n[release] ${error.message}\n`);
    if (error.detail) process.stderr.write(`[release] 详情：\n${error.detail}\n`);
    if (state.versionWritten && !state.committed && state.originalText !== null) {
      try {
        writeFileSync(pkgPath, state.originalText);
        process.stderr.write('[release] 已回滚 packages/cli/package.json 的版本改动\n');
      } catch {
        process.stderr.write(
          '[release] 警告：版本回滚失败，请手动检查 packages/cli/package.json\n',
        );
      }
    }
    process.exit(error.code);
  }
  process.stderr.write(`\n[release] 未预期错误：${error?.stack ?? error}\n`);
  process.exit(EXIT.USAGE);
}
