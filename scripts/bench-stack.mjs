import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  BEGIN_MARKER,
  END_MARKER,
  addStackLayer,
  applyStack,
  explainStackHostname,
  mergeLayers,
  parseHosts,
  renderHosts,
} from '../packages/core/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sizes = [1_000, 5_000, 20_000];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function measure(callback, iterations = 7) {
  for (let index = 0; index < 2; index += 1) callback();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    callback();
    samples.push(performance.now() - started);
  }
  return {
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
    samples: samples.length,
  };
}

function makeEntries(size) {
  return Array.from({ length: size }, (_, index) => ({
    ip: `10.${Math.floor(index / 65536) % 256}.${Math.floor(index / 256) % 256}.${index % 256}`,
    hostnames: [`host-${index}.example.com`],
    enabled: true,
  }));
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

function emptyFencedHosts() {
  return ['# bench', '127.0.0.1 localhost', '', BEGIN_MARKER, END_MARKER, ''].join('\n');
}

const report = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  sizes: [],
};

for (const size of sizes) {
  const raw = Buffer.from(emptyFencedHosts());
  const document = parseHosts(raw);
  const mergedEntries = mergeLayers(makeLayerInputs(size)).entries;
  const managedEntries = mergedEntries.map((entry) => ({
    ip: entry.ip,
    hostnames: entry.hostnames,
  }));

  const merge = measure(() => mergeLayers(makeLayerInputs(size)));

  const render = measure(() => renderHosts(document, { managedEntries, appendIfMissing: true }));

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
  await writeFile(hostsPath, emptyFencedHosts());
  await addStackLayer({ ...baseOptions, id: 'bench', file: layerFile });

  const applySamples = [];
  for (let index = 0; index < 5; index += 1) {
    await writeFile(hostsPath, emptyFencedHosts());
    const started = performance.now();
    await applyStack({ ...baseOptions, dryRun: false });
    applySamples.push(performance.now() - started);
  }
  const apply = {
    medianMs: Number(median(applySamples).toFixed(2)),
    minMs: Number(Math.min(...applySamples).toFixed(2)),
    maxMs: Number(Math.max(...applySamples).toFixed(2)),
    samples: applySamples.length,
  };

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
