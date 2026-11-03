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
  exportSnapshot,
  gitInit,
  gitSnapshot,
  mapNetwork,
  networkAuto,
  verifyManagedEntries,
} from '../packages/core/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sizes = [1_000, 5_000, 20_000];

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

function makeEntries(size) {
  return Array.from({ length: size }, (_, index) => ({
    ip: `10.${Math.floor(index / 65536) % 256}.${Math.floor(index / 256) % 256}.${index % 256}`,
    hostnames: [`host-${index}.example.com`],
    enabled: true,
  }));
}

function fencedHosts() {
  return ['# bench', '127.0.0.1 localhost', '', BEGIN_MARKER, END_MARKER, ''].join('\n');
}

const report = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  generatedAt: new Date().toISOString(),
  sizes: [],
};

for (const size of sizes) {
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
