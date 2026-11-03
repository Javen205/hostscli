#!/usr/bin/env node
/**
 * 基准脚本单一入口，用子命令区分四组测量：
 *   parse   解析 / 渲染 + CLI 冷启动（原 bench.mjs）
 *   write   写回路径与 maxRSS（原 bench-write.mjs）
 *   stack   规则栈合并 / apply / explain（原 bench-stack.mjs）
 *   stage4  网络自动切换、写入后验证、git 快照、导出（原 bench-stage4.mjs）
 *
 * 合并只调整代码结构：规模档位、预热与迭代次数、取中位数方式、输出字段均保持不变。
 * write 需要显式 GC 时按原脚本说明加启动参数：node --expose-gc scripts/bench.mjs write
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  BEGIN_MARKER,
  END_MARKER,
  addHosts,
  addStackLayer,
  applyStack,
  explainStackHostname,
  exportSnapshot,
  gitInit,
  gitSnapshot,
  mapNetwork,
  mergeLayers,
  networkAuto,
  parseHosts,
  renderHosts,
  verifyManagedEntries,
} from '../packages/core/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SIZES = [1_000, 5_000, 20_000];

function makeManagedHosts(count) {
  const lines = [
    '# benchmark',
    '127.0.0.1 localhost',
    '',
    '# >>> hostscli managed (do not edit inside) >>>',
  ];
  for (let index = 0; index < count; index += 1) {
    lines.push(`10.0.${Math.floor(index / 256) % 256}.${index % 256}  host-${index}.example.com`);
  }
  lines.push('# <<< hostscli managed <<<', '');
  return lines.join('\n');
}

function makeEntries(size) {
  return Array.from({ length: size }, (_, index) => ({
    ip: `10.${Math.floor(index / 65536) % 256}.${Math.floor(index / 256) % 256}.${index % 256}`,
    hostnames: [`host-${index}.example.com`],
    enabled: true,
  }));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function stats(samples) {
  return {
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
    samples: samples.length,
  };
}

/** 解析/渲染基准沿用原参数：预热 3 次、测量 10 次。 */
function measureBasic(callback, iterations = 10) {
  for (let index = 0; index < 3; index += 1) callback();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    callback();
    samples.push(performance.now() - started);
  }
  return { medianMs: Number(median(samples).toFixed(2)), samples: samples.length };
}

/** 规则栈基准沿用原参数：预热 2 次、测量 7 次，并输出 min/max。 */
function measureStats(callback, iterations = 7) {
  for (let index = 0; index < 2; index += 1) callback();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    callback();
    samples.push(performance.now() - started);
  }
  return stats(samples);
}

function fencedHosts() {
  return ['# bench', '127.0.0.1 localhost', '', BEGIN_MARKER, END_MARKER, ''].join('\n');
}

async function benchParse() {
  const results = [];

  for (const size of SIZES) {
    const raw = Buffer.from(makeManagedHosts(size));
    const document = parseHosts(raw);
    const managedEntries = document.entries
      .filter((entry) => entry.source === 'managed')
      .map((entry) => ({ ip: entry.ip, hostnames: entry.hostnames }));
    results.push({
      size,
      bytes: raw.length,
      entries: document.entries.length,
      parse: measureBasic(() => parseHosts(raw)),
      renderLossless: measureBasic(() => renderHosts(document)),
      renderManaged: measureBasic(() =>
        renderHosts(document, { managedEntries, appendIfMissing: true }),
      ),
    });
  }

  const cliDirectory = await mkdtemp(join(tmpdir(), 'hostscli-bench-cli-'));
  const cliHosts = join(cliDirectory, 'hosts');
  const cliData = join(cliDirectory, 'data');
  await writeFile(cliHosts, makeManagedHosts(100));

  const cliSamples = [];
  const listSamples = [];
  const helpSamples = [];
  const baselineSamples = [];
  const cliPath = join(ROOT, 'packages/cli/dist/index.js');

  for (let index = 0; index < 10; index += 1) {
    const versionStarted = performance.now();
    spawnSync(process.execPath, [cliPath, '--version'], { stdio: 'ignore' });
    cliSamples.push(performance.now() - versionStarted);

    const listStarted = performance.now();
    spawnSync(
      process.execPath,
      [cliPath, 'list', '--file', cliHosts, '--data-dir', cliData, '--skip-dns-flush'],
      { stdio: 'ignore' },
    );
    listSamples.push(performance.now() - listStarted);

    const helpStarted = performance.now();
    spawnSync(process.execPath, [cliPath, '--help'], { stdio: 'ignore' });
    helpSamples.push(performance.now() - helpStarted);

    const baselineStarted = performance.now();
    spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    baselineSamples.push(performance.now() - baselineStarted);
  }

  await rm(cliDirectory, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        source: 'packages/core/dist/index.js',
        warmupIterations: 3,
        measuredIterations: 10,
        parseRender: results,
        cliColdStart: {
          versionMedianMs: Number(median(cliSamples).toFixed(2)),
          listMedianMs: Number(median(listSamples).toFixed(2)),
          helpMedianMs: Number(median(helpSamples).toFixed(2)),
          rawNodeBaselineMedianMs: Number(median(baselineSamples).toFixed(2)),
          samples: cliSamples.length,
          commands: [
            'node packages/cli/dist/index.js --version',
            'node packages/cli/dist/index.js list --file <tmp> --data-dir <tmp> --skip-dns-flush',
            'node packages/cli/dist/index.js --help',
            'node -e ""（进程启动基线）',
          ],
        },
      },
      null,
      2,
    ),
  );
}

async function collectGarbage() {
  if (typeof globalThis.gc === 'function') {
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.gc();
  }
}

async function benchWrite(sizeArg) {
  const size = Number(sizeArg ?? 20_000);
  const directory = await mkdtemp(join(tmpdir(), 'hostscli-bench-write-'));
  const hostsPath = join(directory, 'hosts');
  const dataDir = join(directory, 'data');
  const backupDir = join(directory, 'backups');
  const source = makeManagedHosts(size);
  await writeFile(hostsPath, source);

  await collectGarbage();
  const before = process.memoryUsage();
  const started = performance.now();
  await addHosts({
    filePath: hostsPath,
    dataDir,
    backupDir,
    dnsFlush: false,
    ip: '10.0.0.12',
    hostnames: ['bench-new.example.com'],
  });
  const elapsed = performance.now() - started;
  await collectGarbage();
  const after = process.memoryUsage();

  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        entries: size,
        fileBytesBefore: Buffer.byteLength(source),
        wallMs: Number(elapsed.toFixed(2)),
        heapUsedDeltaMB: Number(((after.heapUsed - before.heapUsed) / 1024 / 1024).toFixed(2)),
        rssDeltaMB: Number(((after.rss - before.rss) / 1024 / 1024).toFixed(2)),
        maxRssMB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
        gcExposed: typeof globalThis.gc === 'function',
        includes:
          'parse + 迁移到 default 方案 + backup + atomic write + 回读校验 + 写 profile/state',
      },
      null,
      2,
    ),
  );

  await rm(directory, { recursive: true, force: true });
}

function makeLayerInputs(size) {
  const entries = makeEntries(size);
  const third = Math.ceil(entries.length / 3);
  const toHostEntries = (slice, layerId) =>
    slice.map((entry) => ({
      ...entry,
      id: `${layerId}-${entry.ip}`,
      layerId,
      source: 'managed',
      hostnames: entry.hostnames,
    }));
  return [
    { id: 'base', priority: 0, entries: toHostEntries(entries.slice(0, third), 'base'), order: 0 },
    {
      id: 'team',
      priority: 10,
      entries: toHostEntries(entries.slice(third, third * 2), 'team'),
      order: 1,
    },
    {
      id: 'local',
      priority: 20,
      entries: toHostEntries(entries.slice(third * 2), 'local'),
      order: 2,
    },
  ];
}

async function benchStack() {
  const report = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    sizes: [],
  };

  for (const size of SIZES) {
    const raw = Buffer.from(fencedHosts());
    const document = parseHosts(raw);
    const mergedEntries = mergeLayers(makeLayerInputs(size)).entries;
    const managedEntries = mergedEntries.map((entry) => ({
      ip: entry.ip,
      hostnames: entry.hostnames,
    }));

    const merge = measureStats(() => mergeLayers(makeLayerInputs(size)));
    const render = measureStats(() =>
      renderHosts(document, { managedEntries, appendIfMissing: true }),
    );

    // 完整 apply：每次先重置 hosts，确保写回路径被实际执行。
    const directory = await mkdtemp(join(tmpdir(), 'hostscli-bench-stack-'));
    const hostsPath = join(directory, 'hosts');
    const dataDir = join(directory, 'data');
    const layerFile = join(directory, 'layers.json');
    await writeFile(layerFile, JSON.stringify({ entries: makeEntries(size), priority: 10 }));
    const baseOptions = {
      filePath: hostsPath,
      dataDir,
      env: { ...process.env, HOME: directory },
      dnsFlush: false,
      now: new Date('2026-11-02T00:00:00.000Z'),
    };
    await writeFile(hostsPath, fencedHosts());
    await addStackLayer({ ...baseOptions, id: 'bench', file: layerFile });

    const applySamples = [];
    for (let index = 0; index < 5; index += 1) {
      await writeFile(hostsPath, fencedHosts());
      const started = performance.now();
      await applyStack({ ...baseOptions, dryRun: false });
      applySamples.push(performance.now() - started);
    }
    const apply = stats(applySamples);

    const explainSamples = [];
    for (let index = 0; index < 7; index += 1) {
      const started = performance.now();
      await explainStackHostname({
        ...baseOptions,
        hostname: `host-${Math.floor(size / 2)}.example.com`,
      });
      explainSamples.push(performance.now() - started);
    }
    const explainMs = Number(median(explainSamples).toFixed(2));

    const maxRssAfterApplyKb = process.resourceUsage().maxRSS;

    // CLI 冷启动：stack apply 预览 + explain（在已构建好的环境上）
    const cliPath = join(ROOT, 'packages/cli/dist/index.js');
    const cliApplySamples = [];
    const cliExplainSamples = [];
    for (let index = 0; index < 7; index += 1) {
      const applyStarted = performance.now();
      spawnSync(
        process.execPath,
        [cliPath, 'stack', 'apply', '--file', hostsPath, '--data-dir', dataDir, '--skip-dns-flush'],
        { stdio: 'ignore' },
      );
      cliApplySamples.push(performance.now() - applyStarted);

      const explainStarted = performance.now();
      spawnSync(
        process.execPath,
        [
          cliPath,
          'stack',
          'explain',
          `host-${Math.floor(size / 2)}.example.com`,
          '--file',
          hostsPath,
          '--data-dir',
          dataDir,
          '--skip-dns-flush',
        ],
        { stdio: 'ignore' },
      );
      cliExplainSamples.push(performance.now() - explainStarted);
    }

    report.sizes.push({
      size,
      bytes: raw.length,
      merge: {
        ...merge,
        explainMs,
      },
      render,
      apply,
      memory: { maxRssAfterApplyKb, note: 'maxRSS 为进程启动以来的峰值（含此前规模）' },
      cliColdStart: {
        stackApplyPreviewMedianMs: Number(median(cliApplySamples).toFixed(2)),
        stackExplainMedianMs: Number(median(cliExplainSamples).toFixed(2)),
      },
    });

    await rm(directory, { recursive: true, force: true });
  }

  console.log(JSON.stringify(report, null, 2));
}

async function benchStage4() {
  const report = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    generatedAt: new Date().toISOString(),
    sizes: [],
  };

  for (const size of SIZES) {
    const directory = await mkdtemp(join(tmpdir(), 'hostscli-bench-stage4-'));
    const hostsPath = join(directory, 'hosts');
    const dataDir = join(directory, 'data');
    const layerFile = join(directory, 'layer.json');
    await writeFile(hostsPath, fencedHosts());
    await writeFile(layerFile, JSON.stringify({ entries: makeEntries(size), priority: 10 }));

    const baseOptions = {
      filePath: hostsPath,
      dataDir,
      env: { ...process.env, HOME: directory },
      dnsFlush: false,
      now: new Date('2026-11-02T00:00:00.000Z'),
    };

    const importSamples = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      await addStackLayer({ ...baseOptions, id: 'bench', file: layerFile, force: true });
      importSamples.push(performance.now() - started);
    }

    const applySamples = [];
    for (let index = 0; index < 5; index += 1) {
      await writeFile(hostsPath, fencedHosts());
      const started = performance.now();
      await applyStack({ ...baseOptions, dryRun: false });
      applySamples.push(performance.now() - started);
    }

    await mapNetwork({
      ...baseOptions,
      ssid: 'Bench-WiFi',
      layers: ['bench'],
    });
    const networkSamples = [];
    for (let index = 0; index < 5; index += 1) {
      await writeFile(hostsPath, fencedHosts());
      const started = performance.now();
      await networkAuto({
        ...baseOptions,
        detect: async () => ({
          supported: true,
          ssid: 'Bench-WiFi',
          platform: 'darwin',
          source: 'networksetup',
        }),
      });
      networkSamples.push(performance.now() - started);
    }

    const verifySamples = [];
    const expectedEntries = makeEntries(size)
      .slice(0, 50)
      .map((entry, index) => ({
        id: `v-${index}`,
        ip: entry.ip,
        hostnames: entry.hostnames,
        enabled: true,
        source: 'managed',
        layerId: 'bench',
      }));
    const expectedMap = new Map(expectedEntries.map((entry) => [entry.hostnames[0], entry.ip]));
    for (let index = 0; index < 7; index += 1) {
      const started = performance.now();
      await verifyManagedEntries(
        expectedEntries,
        { maxHostnames: 8, timeoutMs: 100, concurrency: 4 },
        {
          lookup: async (hostname) => [
            { address: expectedMap.get(hostname) ?? '127.0.0.1', family: 4 },
          ],
        },
      );
      verifySamples.push(performance.now() - started);
    }

    await gitInit(baseOptions);
    const gitSamples = [];
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(dataDir, 'bench-touch.txt'), `${index}-${Date.now()}\n`);
      const started = performance.now();
      await gitSnapshot({ ...baseOptions, message: `bench ${index}` });
      gitSamples.push(performance.now() - started);
    }

    const exportSamples = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      await exportSnapshot(baseOptions);
      exportSamples.push(performance.now() - started);
    }

    report.sizes.push({
      size,
      import: stats(importSamples),
      apply: stats(applySamples),
      networkAuto: stats(networkSamples),
      verifyEightHostnames: stats(verifySamples),
      gitSnapshot: stats(gitSamples),
      export: stats(exportSamples),
      memory: {
        maxRssKb: process.resourceUsage().maxRSS,
        note: 'maxRSS 为当前进程启动以来的峰值（含此前规模）',
      },
    });

    await rm(directory, { recursive: true, force: true });
  }

  const cliPath = join(ROOT, 'packages/cli/dist/index.js');
  const versionSamples = [];
  const statusSamples = [];
  for (let index = 0; index < 7; index += 1) {
    const started = performance.now();
    spawnSync(process.execPath, [cliPath, '--version'], { stdio: 'ignore' });
    versionSamples.push(performance.now() - started);
  }
  const cliDir = await mkdtemp(join(tmpdir(), 'hostscli-bench-stage4-cli-'));
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    spawnSync(
      process.execPath,
      [cliPath, 'network', 'status', '--data-dir', join(cliDir, 'data'), '--json'],
      { stdio: 'ignore' },
    );
    statusSamples.push(performance.now() - started);
  }
  await rm(cliDir, { recursive: true, force: true });

  report.cliColdStart = {
    version: stats(versionSamples),
    networkStatus: stats(statusSamples),
    note: 'spawn node + 加载 CLI 的端到端耗时；network status 会真实调用 networksetup',
  };

  console.log(JSON.stringify(report, null, 2));
}

function printUsage() {
  console.log(`hostscli 基准脚本

用法：
  node scripts/bench.mjs parse               解析 / 渲染 + CLI 冷启动（1k / 5k / 20k，预热 3 次、测量 10 次）
  node scripts/bench.mjs write [size]        写回路径与 maxRSS（默认 20000 条）
  node scripts/bench.mjs stack               规则栈合并 / apply / explain（1k / 5k / 20k）
  node scripts/bench.mjs stage4              网络自动切换 / 写入后验证 / git 快照 / 导出（1k / 5k / 20k）

说明：
  - 各子命令的规模档位、预热与迭代次数、取中位数方式与原脚本一致，可直接对比历史数据。
  - 需要显式 GC 时：node --expose-gc scripts/bench.mjs write（gcExposed 字段会变为 true）。`);
}

async function main() {
  const subcommand = process.argv[2];
  switch (subcommand) {
    case undefined:
      printUsage();
      return;
    case 'parse':
      await benchParse();
      return;
    case 'write':
      await benchWrite(process.argv[3]);
      return;
    case 'stack':
      await benchStack();
      return;
    case 'stage4':
      await benchStage4();
      return;
    default:
      console.error(`未知子命令：${subcommand}\n`);
      printUsage();
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
