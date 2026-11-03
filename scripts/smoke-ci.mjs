import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const eol = isWindows ? '\r\n' : '\n';

const BEGIN = '# >>> hostscli managed (do not edit inside) >>>';
const END = '# <<< hostscli managed <<<';
const HOST = 'api.example.com';

const OUTSIDE_TOP = ['# outside-top', '# keep this line byte-for-byte', '127.0.0.1 localhost', ''];
const OUTSIDE_BOTTOM = ['# outside-bottom', '# 最后一行不得被改动', ''];

function fail(message, result) {
  const detail = result ? `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` : '';
  throw new Error(`[smoke] ${message}${detail}`);
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  if (result.status !== expectedStatus) {
    fail(
      `命令失败（期望退出码 ${expectedStatus}，实际 ${result.status}）：${args.join(' ')}`,
      result,
    );
  }
  return result;
}

function runJson(args) {
  const result = run(args);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`期望 JSON 输出：${args.join(' ')}`, result);
  }
}

function initialHostsText() {
  return [...OUTSIDE_TOP, BEGIN, END, ...OUTSIDE_BOTTOM].join(eol);
}

function splitOutside(text) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin < 0 || end < 0) throw new Error('[smoke] 围栏标记缺失');
  return { prefix: text.slice(0, begin), suffix: text.slice(end + END.length) };
}

function findEntry(list, hostname) {
  return list.entries.find(
    (entry) => Array.isArray(entry.hostnames) && entry.hostnames.includes(hostname),
  );
}

async function setTtlExpired(dataDir) {
  const statePath = join(dataDir, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (!Array.isArray(state.ttl) || state.ttl.length === 0) {
    throw new Error('[smoke] state.json 中没有 TTL 记录');
  }
  for (const record of state.ttl) record.expiresAt = '2000-01-01T00:00:00.000Z';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}${eol}`);
}

async function main() {
  console.log(`[smoke] platform=${process.platform} node=${process.version}`);
  const root = await mkdtemp(join(tmpdir(), 'hostscli smoke '));
  const hostsPath = join(root, 'hosts');
  const dataDir = join(root, 'data dir');
  const original = initialHostsText();
  await writeFile(hostsPath, original);
  console.log(`[smoke] hostsPath=${hostsPath}`);

  // 只通过 config 设置 hostsPath，所有命令只带 --data-dir；绝不触碰系统 hosts。
  run(['config', 'set', 'hostsPath', hostsPath, '--data-dir', dataDir]);
  console.log('[smoke] config set hostsPath exit=0');

  run(['add', '10.0.0.12', HOST, '--data-dir', dataDir, '--skip-dns-flush']);
  const added = runJson(['list', '--data-dir', dataDir, '--json']);
  if (findEntry(added, HOST)?.status !== 'enabled') fail('add 后状态不是 enabled');
  console.log('[smoke] add exit=0, list=status enabled');

  run(['disable', HOST, '--data-dir', dataDir, '--skip-dns-flush']);
  const disabled = runJson(['list', '--data-dir', dataDir, '--json']);
  if (findEntry(disabled, HOST)?.status !== 'disabled') fail('disable 后状态不是 disabled');
  console.log('[smoke] disable exit=0, list=status disabled');

  run(['enable', HOST, '--data-dir', dataDir, '--skip-dns-flush']);
  run([
    'disable',
    HOST,
    '--for',
    '10m',
    '--reason',
    'smoke',
    '--data-dir',
    dataDir,
    '--skip-dns-flush',
  ]);
  const ttlList = runJson(['ttl', 'list', '--data-dir', dataDir, '--json']);
  if ((ttlList.records ?? []).length === 0) fail('ttl list 为空');
  console.log('[smoke] disable --for 10m exit=0, ttl list 有记录');

  await setTtlExpired(dataDir);
  run(['ttl', 'tick', '--data-dir', dataDir, '--json']);
  const restored = runJson(['list', '--data-dir', dataDir, '--json']);
  if (findEntry(restored, HOST)?.status !== 'enabled') fail('ttl tick 到期后未恢复 enabled');
  console.log('[smoke] ttl tick exit=0, 到期条目已恢复');

  run(['remove', HOST, '--data-dir', dataDir, '--skip-dns-flush']);
  const removed = runJson(['list', '--data-dir', dataDir, '--json']);
  if (findEntry(removed, HOST)) fail('remove 后条目仍存在');
  console.log('[smoke] remove exit=0, 条目已删除');

  const final = await readFile(hostsPath, 'utf8');
  const before = splitOutside(original);
  const after = splitOutside(final);
  if (before.prefix !== after.prefix) fail('围栏前内容被改动（应逐字节不变）');
  if (before.suffix !== after.suffix) fail('围栏后内容被改动（应逐字节不变）');
  console.log('[smoke] 围栏外内容逐字节不变');
  if (isWindows && !final.includes('\r\n')) fail('Windows 上 CRLF 未被保留');
  console.log(`[smoke] 行尾保留 eol=${JSON.stringify(eol)}`);

  // 只读文件：POSIX 下 chmod 0444；Windows 下设置只读属性。
  // Windows 的 W_OK 映射以 libuv 实际行为为准：若仍报告可写，则记录跳过而不是误报失败。
  const readonlyHosts = join(root, 'readonly-hosts');
  await writeFile(readonlyHosts, initialHostsText());
  run(['config', 'set', 'hostsPath', readonlyHosts, '--data-dir', dataDir]);

  let readonlyExpected = true;
  if (isWindows) {
    spawnSync('attrib', ['+R', readonlyHosts], { encoding: 'utf8' });
    try {
      accessSync(readonlyHosts, constants.W_OK);
      readonlyExpected = false;
    } catch {
      readonlyExpected = true;
    }
  } else {
    await chmod(readonlyHosts, 0o444);
  }

  if (isRoot) {
    console.log('[smoke] SKIP：容器内默认 root，会绕过只读权限位；提权分支需真机验证');
  } else if (readonlyExpected) {
    const result = spawnSync(
      process.execPath,
      [cliPath, 'add', '10.0.0.12', HOST, '--data-dir', dataDir, '--skip-dns-flush'],
      { encoding: 'utf8' },
    );
    if (result.status !== 4) {
      fail(`只读文件应返回退出码 4，实际 ${result.status}`, result);
    }
    console.log('[smoke] 只读 hosts 返回退出码 4，未写入');
  } else {
    console.log('[smoke] SKIP：当前平台 W_OK 不反映只读属性，需真机 CI 观察');
  }

  if (isWindows) spawnSync('attrib', ['-R', readonlyHosts], { encoding: 'utf8' });
  else await chmod(readonlyHosts, 0o644).catch(() => undefined);

  await rm(root, { recursive: true, force: true });
  console.log('[smoke] PASS');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
