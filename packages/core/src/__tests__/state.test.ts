import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultState, loadState, saveState } from '../index';

describe('state 持久化：lastRender 不再保存逐主机名来源副本', () => {
  it('旧 state 的 lastRender.sources 可读，下次保存被丢弃', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hostscli-state-legacy-'));
    const statePath = join(directory, 'state.json');
    try {
      await writeFile(
        statePath,
        JSON.stringify({
          schemaVersion: 1,
          activeLayers: ['default'],
          initialized: true,
          ttl: [],
          lastRender: {
            at: '2026-11-01T00:00:00.000Z',
            planHash: 'sha256:legacy',
            sources: [
              { hostname: 'api.example.com', ip: '10.0.0.12', layerId: 'default' },
              { hostname: 'web.example.com', ip: '10.0.0.13', layerId: 'default' },
            ],
          },
        }),
      );

      const state = await loadState(statePath);
      expect(state.lastRender).toEqual({
        at: '2026-11-01T00:00:00.000Z',
        planHash: 'sha256:legacy',
      });
      expect(state.lastRender && 'sources' in state.lastRender).toBe(false);

      await saveState(statePath, state);
      const saved = await readFile(statePath, 'utf8');
      expect(saved).not.toContain('"sources"');
      expect(JSON.parse(saved).lastRender).toEqual(state.lastRender);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('新 state 不含 sources 时读写一致', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hostscli-state-current-'));
    const statePath = join(directory, 'state.json');
    try {
      const state = defaultState();
      state.lastRender = { at: '2026-11-02T00:00:00.000Z', planHash: 'sha256:current' };
      await saveState(statePath, state);

      const loaded = await loadState(statePath);
      expect(loaded.lastRender).toEqual(state.lastRender);
      expect(loaded.activeLayers).toEqual([]);
      expect(loaded.sessions).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('100k 条旧 sources 在保存后体积下降到千分之一以下', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hostscli-state-100k-'));
    const statePath = join(directory, 'state.json');
    try {
      const sources = Array.from({ length: 100_000 }, (_, index) => ({
        hostname: `host-${index}.example.com`,
        ip: `10.0.${Math.floor(index / 256) % 256}.${index % 256}`,
        layerId: 'default',
      }));
      await writeFile(
        statePath,
        JSON.stringify({
          schemaVersion: 1,
          activeLayers: ['default'],
          initialized: true,
          ttl: [],
          lastRender: { at: '2026-11-01T00:00:00.000Z', planHash: 'sha256:legacy', sources },
        }),
      );
      const legacyBytes = (await stat(statePath)).size;
      expect(legacyBytes).toBeGreaterThan(5 * 1024 * 1024);

      await saveState(statePath, await loadState(statePath));
      const slimBytes = (await stat(statePath)).size;
      expect(slimBytes).toBeLessThan(1024);
      expect(slimBytes / legacyBytes).toBeLessThan(0.001);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
