import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { addHosts } from '../packages/core/dist/index.js';

/**
 * 写回性能实测。每个规模单独起一个进程，避免上一个规模的内存影响下一个规模的峰值。
 * 用法：node --expose-gc scripts/bench-write.mjs [size]
 */
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

async function collectGarbage() {
  if (typeof globalThis.gc === 'function') {
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.gc();
  }
}

const size = Number(process.argv[2] ?? 20_000);
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
      includes: 'parse + 迁移到 default 方案 + backup + atomic write + 回读校验 + 写 profile/state',
    },
    null,
    2,
  ),
);

await rm(directory, { recursive: true, force: true });
