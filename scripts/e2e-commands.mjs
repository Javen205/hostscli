#!/usr/bin/env node
/**
 * 命令级端到端覆盖：逐个用真实 CLI 进程执行 command-manifest.ts 里的全部一级命令。
 *
 * 设计约束：
 * - 只和临时 hostsPath、临时 dataDir 交互，绝不触碰系统 hosts。
 * - 清单与用例必须一一对应：清单新增命令但这里没写用例、或用例出现清单外的命令，都直接失败。
 * - 平台差异显式断言（Windows 的 network 不支持、离线 remote、git 缺失时打印 SKIP）。
 * - 每个用例独立目录，失败时打印退出码与 stderr 尾部，便于在 CI 日志定位。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const manifestPath = join(repoRoot, 'packages', 'cli', 'src', 'command-manifest.ts');
const isWindows = process.platform === 'win32';
const eol = isWindows ? '\r\n' : '\n';
const STEP_TIMEOUT_MS = 60_000;

const BEGIN = '# >>> hostscli managed (do not edit inside) >>>';
const END = '# <<< hostscli managed <<<';
const HOST = 'api.example.com';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tail(text, max = 900) {
  const value = (text ?? '').trim();
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

function formatCommand(args) {
  return args.join(' ');
}

function createContext(root) {
  const hostsPath = join(root, 'hosts');
  const dataDir = join(root, 'data');

  function run(args, options = {}) {
    const expectations = Array.isArray(options.expect) ? options.expect : [options.expect ?? 0];
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    if (result.error) {
      throw new Error(`命令无法执行：${formatCommand(args)}（${result.error.message}）`);
    }
    if (!expectations.includes(result.status)) {
      throw new Error(
        `命令退出码不符：${formatCommand(args)}\n` +
          `期望 ${expectations.join(' / ')}，实际 ${result.status}\n` +
          `stderr: ${tail(result.stderr)}`,
      );
    }
    return result;
  }

  function runJson(args, options = {}) {
    const result = run(args, options);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `期望 JSON 输出：${formatCommand(args)}\nstdout: ${tail(result.stdout)}\n` +
          `stderr: ${tail(result.stderr)}`,
      );
    }
  }

  async function writeHosts(text) {
    await writeFile(hostsPath, text);
  }

  async function readHosts() {
    return readFile(hostsPath, 'utf8');
  }

  return { root, hostsPath, dataDir, run, runJson, writeHosts, readHosts };
}

function baseHosts(managed = []) {
  return ['# e2e-top', '127.0.0.1 localhost', BEGIN, ...managed, END, '# e2e-bottom', ''].join(eol);
}

function workspace(ctx) {
  return ['--file', ctx.hostsPath, '--data-dir', ctx.dataDir];
}

function dataOnly(ctx) {
  return ['--data-dir', ctx.dataDir];
}

function hasGit() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${description}`);
}

async function assertNoSidecar(path) {
  try {
    await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`不应存在旧的链 sidecar：${path}`);
}

function spawnCli(args, env) {
  return spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...(env ?? {}) },
    stdio: 'ignore',
  });
}

const CASES = {
  async list(ctx) {
    await ctx.writeHosts(baseHosts(['10.0.0.12  api.example.com']));
    const json = ctx.runJson(['list', ...workspace(ctx), '--json']);
    assert(
      json.entries.some((entry) => entry.hostnames.includes(HOST)),
      'list 未返回托管条目',
    );
    assert(json.summary.managed === 1, `summary.managed 应为 1，实际 ${json.summary.managed}`);
    assert(
      json.entries.some(
        (entry) => entry.hostnames.includes('localhost') && entry.source === 'external',
      ),
      'list 未区分非托管条目',
    );

    // 别名回归：hosts-cli 指向同一入口，必须读到与 hostscli 完全相同的数据
    //（数据目录、state、profiles 不因命令名分裂）。Windows 建 symlink 需额外权限，跳过。
    if (!isWindows) {
      const aliasPath = join(ctx.root, 'hosts-cli');
      await symlink(cliPath, aliasPath);
      const alias = spawnSync(aliasPath, ['list', ...workspace(ctx), '--json'], {
        encoding: 'utf8',
        timeout: STEP_TIMEOUT_MS,
      });
      assert(alias.status === 0, `hosts-cli 别名执行失败：${tail(alias.stderr)}`);
      const aliasJson = JSON.parse(alias.stdout);
      assert(
        aliasJson.summary.managed === json.summary.managed &&
          aliasJson.activeLayers.join(',') === json.activeLayers.join(','),
        'hosts-cli 别名读到的数据与 hostscli 不一致',
      );
    }
  },

  async add(ctx) {
    await ctx.writeHosts(baseHosts());
    const before = await ctx.readHosts();

    const dry = ctx.runJson([
      'add',
      '10.0.0.12',
      HOST,
      '--comment',
      'e2e',
      '--dry-run',
      ...workspace(ctx),
      '--json',
    ]);
    assert(dry.changed === true, 'add --dry-run 应报告 changed=true');
    assert(dry.diff.includes(HOST), 'add --dry-run 的 diff 应包含新主机名');
    assert((await ctx.readHosts()) === before, 'add --dry-run 不应写盘');

    const added = ctx.runJson([
      'add',
      '10.0.0.12',
      HOST,
      '--comment',
      'e2e',
      ...workspace(ctx),
      '--json',
    ]);
    assert(added.changed === true, 'add 应报告 changed=true');
    assert((await ctx.readHosts()).includes(`10.0.0.12  ${HOST}`), 'add 后 hosts 未包含新记录');

    ctx.run(['add', 'not-an-ip', HOST, ...workspace(ctx)], { expect: 2 });
    ctx.run(['add', '10.0.0.13', HOST, ...workspace(ctx)], { expect: 2 });
  },

  async remove(ctx) {
    await ctx.writeHosts(baseHosts());
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);

    const removed = ctx.runJson(['remove', HOST, ...workspace(ctx), '--json']);
    assert(removed.changed === true, 'remove 应报告 changed=true');
    assert(!(await ctx.readHosts()).includes(HOST), 'remove 后 hosts 仍包含该主机名');

    ctx.run(['remove', HOST, ...workspace(ctx)], { expect: 1 });
  },

  async enable(ctx) {
    await ctx.writeHosts(baseHosts());
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);
    ctx.runJson(['disable', HOST, ...workspace(ctx), '--json']);

    const enabled = ctx.runJson(['enable', HOST, ...workspace(ctx), '--json']);
    assert(enabled.changed === true, 'enable 应报告 changed=true');
    const list = ctx.runJson(['list', ...workspace(ctx), '--json']);
    const entry = list.entries.find((item) => item.hostnames.includes(HOST));
    assert(entry?.status === 'enabled', `enable 后状态应为 enabled，实际 ${entry?.status}`);

    ctx.run(['enable', 'missing.example.com', ...workspace(ctx)], { expect: 1 });
  },

  async disable(ctx) {
    await ctx.writeHosts(baseHosts());
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);

    // 非 TTY 下超过阈值会要求确认，确认失败应返回 CANCELLED(8)。
    ctx.run(['disable', HOST, '--for', '100d', ...workspace(ctx)], { expect: 8 });

    const ttl = ctx.runJson([
      'disable',
      HOST,
      '--for',
      '5m',
      '--reason',
      'e2e',
      ...workspace(ctx),
      '--json',
    ]);
    assert(ttl.record?.expiresAt, 'disable --for 未返回 expiresAt');
    const list = ctx.runJson(['list', ...workspace(ctx), '--json']);
    const entry = list.entries.find((item) => item.hostnames.includes(HOST));
    assert(entry?.status === 'ttl_disabled', `TTL 后状态应为 ttl_disabled，实际 ${entry?.status}`);
  },

  async init(ctx) {
    await ctx.writeHosts('# e2e-only\n127.0.0.1 localhost\n');
    const first = ctx.runJson(['init', ...workspace(ctx), '--json']);
    assert(first.changed === true, '首次 init 应写入托管区块');
    const text = await ctx.readHosts();
    assert(text.includes(BEGIN) && text.includes(END), 'init 后缺少围栏标记');

    const second = ctx.runJson(['init', ...workspace(ctx), '--json']);
    assert(second.changed === false, '重复 init 应报告 changed=false');
  },

  async apply(ctx) {
    await ctx.writeHosts('# e2e-only\n127.0.0.1 localhost\n');
    ctx.runJson(['init', ...workspace(ctx), '--json']);
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);

    const applied = ctx.runJson(['apply', ...workspace(ctx), '--json']);
    assert(typeof applied.changed === 'boolean', 'apply 未返回 changed');
    assert((await ctx.readHosts()).includes('# e2e-only'), 'apply 改动了围栏外内容');
  },

  async backup(ctx) {
    await ctx.writeHosts(baseHosts());
    const backup = ctx.runJson(['backup', ...workspace(ctx), '--json']);
    assert(backup.backupPath, 'backup 未返回 backupPath');
    const content = await readFile(backup.backupPath, 'utf8');
    assert(content.includes(BEGIN), '备份内容缺少托管区');

    const listed = ctx.runJson(['backup', '--list', ...workspace(ctx), '--json']);
    assert(Array.isArray(listed.files) && listed.files.length >= 1, 'backup --list 未列出备份');
  },

  async restore(ctx) {
    const original = baseHosts();
    await ctx.writeHosts(original);
    const backup = ctx.runJson(['backup', ...workspace(ctx), '--json']);

    await ctx.writeHosts(`${original}# e2e-mutated\n`);
    const restored = ctx.runJson([
      'restore',
      '--from',
      backup.backupPath,
      '--yes',
      ...workspace(ctx),
      '--json',
    ]);
    assert(restored.changed === true, 'restore 应报告 changed=true');
    assert((await ctx.readHosts()) === original, 'restore 后内容与备份不一致');

    ctx.run(['restore', '--from', join(ctx.root, 'missing-backup'), '--yes', ...workspace(ctx)], {
      expect: 1,
    });
  },

  async profile(ctx) {
    await ctx.writeHosts(baseHosts());
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);

    const created = ctx.runJson([
      'profile',
      'create',
      'office',
      '--from-current',
      '--name',
      'Office',
      '--priority',
      '10',
      ...workspace(ctx),
      '--json',
    ]);
    assert(
      created.entries.length === 1,
      `profile create 应导入 1 条，实际 ${created.entries.length}`,
    );

    const list = ctx.runJson(['profile', 'list', ...dataOnly(ctx), '--json']);
    assert(
      list.profiles.some((item) => item.id === 'office'),
      'profile list 未包含 office',
    );

    const shown = ctx.runJson(['profile', 'show', 'office', ...dataOnly(ctx), '--json']);
    assert(shown.id === 'office' && shown.name === 'Office', 'profile show 字段不符');
    const shownText = ctx.run(['profile', 'show', 'office', ...dataOnly(ctx)]);
    const shownHeader = shownText.stdout.split(/\r?\n/).find((line) => line.includes('HOSTNAMES'));
    assert(Boolean(shownHeader) && shownHeader.includes('#'), 'profile show 表格缺少展示序号列');

    const updated = ctx.runJson([
      'profile',
      'update',
      'office',
      '--name',
      'Office-2',
      '--priority',
      '20',
      ...dataOnly(ctx),
      '--json',
    ]);
    assert(updated.name === 'Office-2' && updated.priority === 20, 'profile update 未生效');

    const used = ctx.runJson(['profile', 'use', 'office', ...workspace(ctx), '--json']);
    assert(typeof used.changed === 'boolean', 'profile use 未返回 changed');
    const afterUse = ctx.runJson(['profile', 'list', ...dataOnly(ctx), '--json']);
    const office = afterUse.profiles.find((item) => item.id === 'office');
    assert(office?.active === true, 'profile use 后 office 未标记为启用');
    const saved = ctx.runJson(['profile', 'save', 'office', ...workspace(ctx), '--json']);
    assert(saved.entries.length === 1, 'profile save 未保存条目');

    // 迁移：dup 从当前托管区导入同名条目，默认应拒绝；--force 覆盖后 hosts 中该条目消失。
    const dup = ctx.runJson([
      'profile',
      'create',
      'dup',
      '--from-current',
      ...workspace(ctx),
      '--json',
    ]);
    assert(dup.entries.length === 1, 'profile create dup 应从当前托管区导入 1 条');
    ctx.run(['profile', 'move', HOST, '--from', 'office', '--to', 'dup', ...workspace(ctx)], {
      expect: 2,
    });
    const moved = ctx.runJson([
      'profile',
      'move',
      HOST,
      '--from',
      'office',
      '--to',
      'dup',
      '--force',
      ...workspace(ctx),
      '--json',
    ]);
    assert(moved.from === 'office' && moved.to === 'dup', 'profile move 返回字段不符');
    assert(moved.replacedHostnames.includes(HOST), 'profile move --force 未记录被覆盖的主机名');
    assert(moved.toActive === false, 'profile move 应报出目标方案未生效');
    assert(!(await ctx.readHosts()).includes(HOST), '条目迁到未生效方案后仍留在 hosts');

    // 未生效目标要给出明确提示与查看方式；迁回生效方案则不该提示。
    const backToActive = ctx.run([
      'profile',
      'move',
      HOST,
      '--from',
      'dup',
      '--to',
      'office',
      ...workspace(ctx),
    ]);
    assert(!backToActive.stdout.includes('未生效'), '迁移到生效方案不应提示方案未生效');
    const backToInactive = ctx.run([
      'profile',
      'move',
      HOST,
      '--from',
      'office',
      '--to',
      'dup',
      ...workspace(ctx),
    ]);
    assert(
      backToInactive.stdout.includes('hostscli profile use dup'),
      '迁移到未生效方案未提示切换方式',
    );
    assert(
      backToInactive.stdout.includes('hostscli list --profile dup'),
      '迁移到未生效方案未提示查看方式',
    );

    // 回归：条目迁到未生效方案后，默认 list 看不到，list --profile 必须能看到。
    const effective = ctx.runJson(['list', ...workspace(ctx), '--json']);
    assert(
      !effective.entries.some((entry) => entry.hostnames.includes(HOST)),
      '生效视图不应出现已迁走的条目',
    );
    const profileView = ctx.runJson(['list', '--profile', 'dup', ...workspace(ctx), '--json']);
    assert(
      profileView.entries.some((entry) => entry.hostnames.includes(HOST)),
      'list --profile 未展示未生效方案里的条目',
    );
    assert(
      !profileView.entries.some((entry) => entry.source === 'external'),
      '方案视图不应混入非托管行',
    );
    assert(profileView.view?.mode === 'profiles', 'list --profile 缺少 view 字段');
    assert(profileView.summary.external === 0, '方案视图 summary.external 应为 0');
    assert(profileView.view.omittedExternal >= 1, '方案视图应报出被省略的非托管行数量');
    const allView = ctx.runJson(['list', '--all-profiles', ...workspace(ctx), '--json']);
    assert(allView.view?.mode === 'all', 'list --all-profiles 缺少 view 字段');
    assert(
      allView.entries.some((entry) => entry.hostnames.includes(HOST)),
      'list --all-profiles 未展示未生效方案里的条目',
    );

    const officeAfterMove = ctx.runJson(['profile', 'show', 'office', ...dataOnly(ctx), '--json']);
    assert(officeAfterMove.entries.length === 0, '迁移后源方案仍保留条目');
    const audit = ctx.runJson([
      'audit',
      'list',
      ...dataOnly(ctx),
      '--command',
      'profile move',
      '--json',
    ]);
    assert(
      audit.records.some((record) => record.action === 'move-failed' && record.ok === false),
      '冲突迁移未写入 move-failed 审计',
    );
    ctx.runJson(['profile', 'remove', 'dup', ...dataOnly(ctx), '--json']);

    const empty = ctx.runJson(['profile', 'create', 'home', ...dataOnly(ctx), '--json']);
    assert(empty.entries.length === 0, 'profile create 未带 --from-current 应为空');
    ctx.runJson(['profile', 'remove', 'home', ...dataOnly(ctx), '--json']);
  },

  async ttl(ctx) {
    await ctx.writeHosts(baseHosts());
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);
    ctx.runJson(['disable', HOST, '--for', '5m', ...workspace(ctx), '--json']);

    const listed = ctx.runJson(['ttl', 'list', ...dataOnly(ctx), '--json']);
    assert((listed.records ?? []).length === 1, 'ttl list 应有 1 条记录');

    const statePath = join(ctx.dataDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    for (const record of state.ttl ?? []) record.expiresAt = '2000-01-01T00:00:00.000Z';
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}${eol}`);

    const ticked = ctx.runJson(['ttl', 'tick', ...workspace(ctx), '--json']);
    assert((ticked.restored ?? []).length === 1, 'ttl tick 未恢复到期记录');
    const list = ctx.runJson(['list', ...workspace(ctx), '--json']);
    const entry = list.entries.find((item) => item.hostnames.includes(HOST));
    assert(entry?.status === 'enabled', `ttl tick 后状态应为 enabled，实际 ${entry?.status}`);

    ctx.run(['ttl', 'restore', 'missing.example.com', ...workspace(ctx)], { expect: 1 });
  },

  async stack(ctx) {
    await ctx.writeHosts(baseHosts());
    const layerFile = join(ctx.root, 'office.hosts');
    await writeFile(layerFile, `10.10.0.1  stack.example.com${eol}`);

    const added = ctx.runJson([
      'stack',
      'layer',
      'add',
      'office',
      '--file',
      layerFile,
      ...dataOnly(ctx),
      '--json',
    ]);
    assert(added.profile.entries.length === 1, 'stack layer add 未导入条目');

    const layers = ctx.runJson(['stack', 'layer', 'list', ...dataOnly(ctx), '--json']);
    assert(
      layers.layers.some((layer) => layer.id === 'office'),
      'stack layer list 未包含 office',
    );

    const applied = ctx.runJson(['stack', 'apply', ...workspace(ctx), '--json']);
    assert(typeof applied.changed === 'boolean', 'stack apply 未返回 changed');

    const explained = ctx.runJson([
      'stack',
      'explain',
      'stack.example.com',
      ...workspace(ctx),
      '--json',
    ]);
    assert(explained.candidates.length >= 1, 'stack explain 没有候选链');

    ctx.run(['stack', 'layer', 'add', 'broken', ...dataOnly(ctx)], { expect: 2 });
  },

  async doctor(ctx) {
    await ctx.writeHosts(baseHosts());
    const report = ctx.runJson(['doctor', '--all', ...workspace(ctx), '--json']);
    assert(Array.isArray(report.rows) && report.rows.length === 0, '空托管区 doctor --all 应无行');
    assert(report.exitCode === 0, `空托管区 doctor 退出码字段应为 0，实际 ${report.exitCode}`);

    ctx.run(['doctor', ...workspace(ctx)], { expect: 1 });
  },

  async remote(ctx) {
    const add = ctx.runJson([
      'remote',
      'add',
      'offline',
      '--url',
      'http://127.0.0.1:1/hosts',
      ...dataOnly(ctx),
      '--json',
    ]);
    assert(add.source.id === 'offline', 'remote add 返回字段不符');

    const list = ctx.runJson(['remote', 'list', ...dataOnly(ctx), '--json']);
    assert(
      list.sources.some((item) => item.source.id === 'offline'),
      'remote list 未包含订阅',
    );

    const failed = ctx.runJson(
      ['remote', 'update', 'offline', '--timeout', '1000', ...dataOnly(ctx), '--json'],
      { expect: 6 },
    );
    assert(failed.failed === 1, `remote update 离线应失败 1 个，实际 ${failed.failed}`);

    ctx.runJson(['remote', 'remove', 'offline', ...dataOnly(ctx), '--json']);
    ctx.run(['remote', 'add', 'no-url', ...dataOnly(ctx)], { expect: 2 });
  },

  async dns(ctx) {
    const result = ctx.run(['dns', 'flush', '--json'], { expect: [0, 6] });
    const payload = JSON.parse(result.stdout);
    assert(typeof payload.ok === 'boolean', 'dns flush 未返回 ok');
    assert(Array.isArray(payload.attempts), 'dns flush 未返回 attempts');
  },

  async config(ctx) {
    const shown = ctx.runJson(['config', 'show', ...dataOnly(ctx), '--json']);
    assert(shown.configPath, 'config show 未返回 configPath');
    assert(shown.config.hostsPath === null, '初始 hostsPath 应为 null');

    const keys = ctx.runJson(['config', 'keys', ...dataOnly(ctx), '--json']);
    assert(keys.keys.includes('hostsPath'), 'config keys 未包含 hostsPath');

    ctx.runJson(['config', 'set', 'hostsPath', '~/e2e-hosts', ...dataOnly(ctx), '--json'], {
      env: { HOME: ctx.root, USERPROFILE: ctx.root },
    });
    const expanded = ctx.runJson(['config', 'show', ...dataOnly(ctx), '--json'], {
      env: { HOME: ctx.root, USERPROFILE: ctx.root },
    });
    const expected = join(ctx.root, 'e2e-hosts');
    assert(
      expanded.config.hostsPath === expected,
      `~ 展开结果不符，期望 ${expected}，实际 ${expanded.config.hostsPath}`,
    );
    if (isWindows) {
      assert(!expanded.config.hostsPath.includes('/'), '~ 展开在 Windows 上产生了混合分隔符');
    }

    ctx.run(['config', 'set', 'unknown.key', '1', ...dataOnly(ctx)], { expect: 2 });
    ctx.run(['config', 'set', 'defaults.backupKeep', 'abc', ...dataOnly(ctx)], { expect: 2 });
  },

  async network(ctx) {
    const status = ctx.runJson(['network', 'status', ...dataOnly(ctx), '--json']);
    assert(status.network.platform === process.platform, 'network status 平台字段不符');

    if (isWindows) {
      assert(status.network.supported === false, 'Windows 上 network status 应明确报告不支持');
      assert(
        status.network.detail?.includes('不支持'),
        `Windows 不支持提示缺失：${status.network.detail}`,
      );
      const auto = ctx.run(['network', 'auto', ...workspace(ctx), '--json'], { expect: 6 });
      assert(
        auto.stderr.includes('不支持') || auto.stderr.includes('Windows'),
        `Windows network auto 未明确报错，stderr: ${tail(auto.stderr)}`,
      );
    } else {
      assert(status.network.platform !== 'win32', 'POSIX 平台字段不应是 win32');
      if (status.network.ssid) {
        ctx.runJson(['profile', 'create', 'office', ...dataOnly(ctx), '--json']);
        ctx.runJson([
          'network',
          'map',
          status.network.ssid,
          '--layers',
          'office',
          ...dataOnly(ctx),
          '--json',
        ]);
        const auto = ctx.runJson(['network', 'auto', ...workspace(ctx), '--json']);
        assert(auto.dryRun === true, 'network auto 默认应为 dry-run');
      } else {
        const auto = ctx.run(['network', 'auto', ...workspace(ctx), '--json'], { expect: 6 });
        assert(
          auto.stderr.includes('SSID') ||
            auto.stderr.includes('Wi-Fi') ||
            auto.stderr.includes('iwgetid') ||
            auto.stderr.includes('nmcli') ||
            auto.stderr.includes('不支持'),
          `network auto 未给出可识别的失败原因，stderr: ${tail(auto.stderr)}`,
        );
      }
    }

    ctx.runJson(['network', 'map', 'e2e-ssid', '--layers', 'office', ...dataOnly(ctx), '--json']);
    ctx.runJson(['network', 'unmap', 'e2e-ssid', ...dataOnly(ctx), '--json']);
  },

  async git(ctx) {
    if (!hasGit()) {
      return { skip: '当前环境未安装 git，快照命令无法验证（Docker 镜像常见）' };
    }
    await ctx.writeHosts(baseHosts());
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);
    await mkdir(ctx.dataDir, { recursive: true });

    const init = ctx.runJson(['git', 'init', ...dataOnly(ctx), '--json']);
    assert(init.gitDir, 'git init 未返回 gitDir');

    const snapshot = ctx.runJson(['git', 'snapshot', '-m', 'e2e', ...dataOnly(ctx), '--json']);
    assert(snapshot.created === true && snapshot.commit, 'git snapshot 未创建提交');

    const log = ctx.runJson(['git', 'log', ...dataOnly(ctx), '--json']);
    assert(log.entries.length >= 1, 'git log 没有记录');

    const diff = ctx.runJson(['git', 'diff', ...dataOnly(ctx), '--json']);
    assert(typeof diff.diff === 'string', 'git diff 未返回 diff 字符串');

    const rollback = ctx.runJson([
      'git',
      'rollback',
      snapshot.commit,
      '--no-rebuild',
      ...dataOnly(ctx),
      '--json',
    ]);
    assert(rollback.commit && rollback.restored, 'git rollback 返回字段不符');
  },

  async export(ctx) {
    await mkdir(ctx.dataDir, { recursive: true });
    const outPath = join(ctx.root, 'snapshot.json');
    ctx.run(['export', '--format', 'json', '--out', outPath, ...dataOnly(ctx)]);
    const snapshot = JSON.parse(await readFile(outPath, 'utf8'));
    assert(snapshot.schemaVersion === 1, 'export 快照 schemaVersion 应为 1');
    assert(Array.isArray(snapshot.profiles), 'export 快照缺少 profiles');

    const yaml = ctx.run(['export', '--format', 'yaml', ...dataOnly(ctx)]);
    assert(yaml.stdout.includes('schemaVersion:'), 'export --format yaml 输出不含 schemaVersion');

    ctx.run(['export', '--format', 'toml', ...dataOnly(ctx)], { expect: 2 });
  },

  async audit(ctx) {
    await ctx.writeHosts(baseHosts());
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);

    const listed = ctx.runJson(['audit', 'list', ...dataOnly(ctx), '--json']);
    assert(Array.isArray(listed.records), 'audit list 未返回 records');
    assert(listed.auditPath.includes('audit'), 'audit list 未返回 auditPath');
    const write = listed.records.find((record) => record.action === 'write-ok');
    assert(write, 'audit list 缺少成功写入记录 write-ok');
    assert(write.beforeSha256 && write.afterSha256, '写入记录缺少前后内容哈希');
    assert(write.onChain === undefined && write.recordHash === undefined, '审计不应再输出链字段');

    const shown = ctx.runJson(['audit', 'show', String(write.id), ...dataOnly(ctx), '--json']);
    assert(shown.action === 'write-ok', 'audit show 字段不符');

    const verified = ctx.runJson(['audit', 'verify', ...dataOnly(ctx), '--json']);
    assert(verified.ok === true, `audit verify 应为 ok，实际 ${JSON.stringify(verified.issues)}`);
    assert(verified.total >= 1, 'audit verify 未统计到记录');
    assert(verified.chain === undefined, 'audit verify 不应再返回链状态');

    await assertNoSidecar(join(ctx.dataDir, 'audit.log.chain.json'));

    const exported = ctx.run(['audit', 'export', '--format', 'ndjson', ...dataOnly(ctx)]);
    assert(exported.stdout.trim().split('\n').length >= 1, 'audit export --format ndjson 输出为空');

    const filtered = ctx.runJson([
      'audit',
      'list',
      '--result',
      'failed',
      ...dataOnly(ctx),
      '--json',
    ]);
    assert(filtered.records.length === 0, '--result failed 不应包含成功写入');

    ctx.run(['audit', 'list', '--result', 'bogus', ...dataOnly(ctx)], { expect: 2 });
    ctx.run(['audit', 'show', '999999', ...dataOnly(ctx)], { expect: 2 });

    // 旧格式（带链字段）记录仍可读；格式损坏行让 verify 非零退出。
    const auditPath = join(ctx.dataDir, 'audit.log');
    await writeFile(
      auditPath,
      `${JSON.stringify({
        id: 'legacy-1',
        seq: 1,
        at: '2026-10-01T00:00:00.000Z',
        action: 'verify-ok',
        ok: true,
        hostsPath: ctx.hostsPath,
        prevHash: 'GENESIS',
        recordHash: 'sha256:deadbeef',
        onChain: true,
      })}\n${await readFile(auditPath, 'utf8')}`,
    );
    const legacy = ctx.runJson(['audit', 'list', ...dataOnly(ctx), '--json']);
    assert(
      legacy.records.some((record) => record.id === 'legacy-1'),
      '旧格式审计记录应继续可读',
    );
    await writeFile(auditPath, `${await readFile(auditPath, 'utf8')}not-json\n`);
    ctx.run(['audit', 'verify', ...dataOnly(ctx)], { expect: 1 });
  },

  async undo(ctx) {
    await ctx.writeHosts(baseHosts());
    const before = await ctx.readHosts();
    ctx.runJson(['add', '10.0.0.12', HOST, ...workspace(ctx), '--json']);

    const dry = ctx.runJson(['undo', '--dry-run', ...workspace(ctx), '--json']);
    assert(dry.dryRun === true && dry.changed === true, 'undo --dry-run 应报告 changed=true');
    assert((await ctx.readHosts()).includes(HOST), 'undo --dry-run 不应写盘');

    const undone = ctx.runJson(['undo', ...workspace(ctx), '--json']);
    assert(undone.changed === true && undone.steps === 1, 'undo 未报告撤销 1 步');
    assert((await ctx.readHosts()) === before, 'undo 后 hosts 未回到写入前内容');

    const redone = ctx.runJson(['undo', ...workspace(ctx), '--json']);
    assert(redone.changed === true, '再次 undo 应可回放（redo）');
    assert((await ctx.readHosts()).includes(HOST), '再次 undo 未恢复被撤销的写入');

    ctx.run(['undo', '--steps', '5', ...workspace(ctx)], { expect: 2 });

    await ctx.writeHosts(`${await ctx.readHosts()}# manual-edit${eol}`);
    ctx.run(['undo', ...workspace(ctx)], { expect: 3 });
  },

  async run(ctx) {
    await ctx.writeHosts(baseHosts());

    ctx.run(
      [
        'run',
        '--host',
        'run.example.com',
        '--ip',
        '10.0.0.99',
        ...workspace(ctx),
        '--',
        process.execPath,
        '-e',
        '0',
      ],
      { expect: 0 },
    );
    assert(!(await ctx.readHosts()).includes('run.example.com'), 'run 结束后临时条目未移除');
    const listed = ctx.runJson(['run', 'list', ...workspace(ctx), '--json']);
    assert(listed.sessions.length === 0, 'run 结束后仍留有会话租约');

    ctx.run(
      [
        'run',
        '--host',
        'run.example.com',
        '--ip',
        '10.0.0.99',
        ...workspace(ctx),
        '--',
        process.execPath,
        '-e',
        'process.exit(3)',
      ],
      { expect: 3 },
    );
    assert(!(await ctx.readHosts()).includes('run.example.com'), '子进程失败后临时条目未移除');

    ctx.run(
      [
        'run',
        '--host',
        'run.example.com',
        '--ip',
        '10.0.0.99',
        ...workspace(ctx),
        '--',
        'definitely-not-a-real-executable',
      ],
      { expect: 2 },
    );
    assert(!(await ctx.readHosts()).includes('run.example.com'), '命令不存在时不应残留条目');
    assert((await ctx.readHosts()).includes('# e2e-top'), 'run 失败路径改动了围栏外内容');

    const gc = ctx.runJson(['run', 'gc', ...workspace(ctx), '--json']);
    assert(Array.isArray(gc.removed) && gc.removed.length === 0, '空环境 run gc 不应回收任何会话');

    // 真实孤儿：父进程被 SIGKILL 留下租约，`--file/--data-dir` 必须由子命令生效。
    const defaultData = join(ctx.root, 'default-data');
    const defaultHosts = join(ctx.root, 'default-hosts');
    const customHosts = join(ctx.root, 'custom-hosts');
    const customData = join(ctx.root, 'custom-data');
    await mkdir(defaultData, { recursive: true });
    await mkdir(customData, { recursive: true });
    await writeFile(defaultHosts, baseHosts());
    await writeFile(
      join(defaultData, 'config.json'),
      JSON.stringify({ schemaVersion: 1, hostsPath: defaultHosts }),
    );
    await writeFile(customHosts, baseHosts());
    const defaultBefore = await readFile(defaultHosts, 'utf8');

    const child = spawnCli(
      [
        'run',
        '--host',
        'orphan.example.com',
        '--ip',
        '10.0.0.88',
        '--file',
        customHosts,
        '--data-dir',
        customData,
        '--',
        process.execPath,
        '-e',
        'setTimeout(() => {}, 8000)',
      ],
      { HOSSCLI_HOME: defaultData },
    );

    const statePath = join(customData, 'state.json');
    await waitFor(async () => {
      try {
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        return Array.isArray(state.sessions) && state.sessions.length > 0;
      } catch {
        return false;
      }
    }, 'run 会话租约写入自定义数据目录');
    assert(
      (await readFile(customHosts, 'utf8')).includes('orphan.example.com'),
      '孤儿会话的临时条目应写入自定义 hosts',
    );

    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    const orphanList = ctx.runJson(
      ['run', 'list', '--file', customHosts, '--data-dir', customData, '--json'],
      {
        env: { HOSSCLI_HOME: defaultData },
      },
    );
    assert(
      orphanList.sessions.some((session) => session.orphan),
      'run list 未识别出孤儿会话',
    );

    const orphanGc = ctx.runJson(
      ['run', 'gc', '--file', customHosts, '--data-dir', customData, '--json'],
      {
        env: { HOSSCLI_HOME: defaultData },
      },
    );
    assert(
      orphanGc.removed.length === 1,
      `run gc 应回收 1 个孤儿，实际 ${orphanGc.removed.length}`,
    );
    assert(
      !(await readFile(customHosts, 'utf8')).includes('orphan.example.com'),
      'run gc 未从自定义 hosts 移除孤儿条目',
    );
    assert(
      (await readFile(defaultHosts, 'utf8')) === defaultBefore,
      'run gc 改动了默认配置指向的 hosts（--file 被子命令吞噬）',
    );
  },

  async completion(ctx) {
    const bash = ctx.run(['completion', 'bash']);
    assert(bash.stdout.includes('_hostscli_completions'), 'bash 补全脚本内容不符');
    assert(bash.stdout.includes('hostscli hosts-cli'), 'bash 补全脚本未覆盖 hosts-cli 别名');
    const zsh = ctx.run(['completion', 'zsh']);
    assert(zsh.stdout.includes('#compdef hostscli hosts-cli'), 'zsh 补全脚本内容不符');
    const fish = ctx.run(['completion', 'fish']);
    assert(fish.stdout.includes('complete -c hostscli'), 'fish 补全脚本内容不符');
    assert(fish.stdout.includes('complete -c hosts-cli'), 'fish 补全脚本未覆盖 hosts-cli 别名');

    const ps = ctx.run(['completion', 'powershell']);
    assert(
      ps.stdout.includes('Register-ArgumentCompleter -Native -CommandName hostscli,hosts-cli'),
      'PowerShell 补全未注册两个命令名',
    );
    assert(ps.stdout.includes('--on-conflict'), 'PowerShell 补全未覆盖 --on-conflict 取值');
    assert(ps.stdout.includes('Get-HostsCliProfiles'), 'PowerShell 补全缺少动态 profile 取值');

    const cmd = ctx.run(['completion', 'cmd']);
    assert(cmd.stdout.includes('doskey h=hostscli $*'), 'cmd 宏文件缺少 hostscli 宏');
    assert(cmd.stdout.includes('doskey hc=hosts-cli $*'), 'cmd 宏文件缺少 hosts-cli 宏');
    assert(cmd.stdout.includes('不是补全'), 'cmd 输出未说明它只是宏、不是补全');

    ctx.run(['completion', 'nushell'], { expect: 2 });
  },
};

async function manifestCommandNames() {
  const source = await readFile(manifestPath, 'utf8');
  const names = [...source.matchAll(/\bname:\s*'([^']+)'/g)].map((match) => match[1]);
  return [...new Set(names)];
}

function validateCoverage(manifestNames, caseNames) {
  const missing = manifestNames.filter((name) => !caseNames.includes(name));
  const extra = caseNames.filter((name) => !manifestNames.includes(name));
  const problems = [];
  if (missing.length > 0) problems.push(`e2e 缺少用例的命令：${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`e2e 用例包含清单外的命令：${extra.join(', ')}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[e2e] FAIL ${problem}`);
    console.error('[e2e] 覆盖校验失败：command-manifest.ts 与 CASES 必须一一对应。');
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function main() {
  console.log(`[e2e] platform=${process.platform} node=${process.version}`);
  try {
    await readFile(cliPath);
  } catch {
    console.error(`[e2e] 未找到构建产物：${cliPath}\n[e2e] 请先运行 pnpm build。`);
    process.exitCode = 1;
    return;
  }

  const manifestNames = await manifestCommandNames();
  const caseNames = Object.keys(CASES);
  console.log(`[e2e] 命令清单 ${manifestNames.length} 个；用例 ${caseNames.length} 个`);
  if (!validateCoverage(manifestNames, caseNames)) return;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for (const name of manifestNames) {
    const started = Date.now();
    const root = await mkdtemp(join(tmpdir(), `hostscli-e2e-${name}-`));
    const ctx = createContext(root);
    try {
      const outcome = (await CASES[name](ctx)) ?? {};
      const elapsed = Date.now() - started;
      if (outcome.skip) {
        skipped += 1;
        console.log(`[e2e] SKIP ${name}（${outcome.skip}）`);
      } else {
        passed += 1;
        console.log(`[e2e] PASS ${name}（${elapsed} ms）`);
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name, message });
      console.log(`[e2e] FAIL ${name}（${Date.now() - started} ms）\n${message}`);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(
    `[e2e] 覆盖：${manifestNames.length - failed}/${manifestNames.length} 命令；` +
      `PASS ${passed}，SKIP ${skipped}，FAIL ${failed}`,
  );
  console.log(
    '[e2e] SKIP 真实系统 hosts 写入与提权：全部用例只使用临时 hostsPath，' +
      '真实 /etc/hosts 与提权路径需在真机单独验证。',
  );
  for (const failure of failures) {
    console.error(`[e2e] FAIL ${failure.name}：${failure.message}`);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[e2e] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
