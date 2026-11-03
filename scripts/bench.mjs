import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseHosts, renderHosts } from '../packages/core/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function measure(callback, iterations = 10) {
  for (let index = 0; index < 3; index += 1) callback();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    callback();
    samples.push(performance.now() - started);
  }
  return { medianMs: Number(median(samples).toFixed(2)), samples: samples.length };
}

const sizes = [1_000, 5_000, 20_000];
const results = [];

for (const size of sizes) {
  const raw = Buffer.from(makeManagedHosts(size));
  const document = parseHosts(raw);
  const managedEntries = document.entries
    .filter((entry) => entry.source === 'managed')
    .map((entry) => ({ ip: entry.ip, hostnames: entry.hostnames }));
  results.push({
    size,
    bytes: raw.length,
    entries: document.entries.length,
    parse: measure(() => parseHosts(raw)),
    renderLossless: measure(() => renderHosts(document)),
    renderManaged: measure(() => renderHosts(document, { managedEntries, appendIfMissing: true })),
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
