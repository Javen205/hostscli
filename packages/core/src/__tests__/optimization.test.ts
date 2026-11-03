import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidInputError } from '../errors';
import type { Profile } from '../profiles/store';
import { writeProfile } from '../profiles/store';

describe('可信写入（写回优化）', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hostscli-opt-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('trusted 写入仍是合法 JSON，且采用紧凑格式', async () => {
    const profile: Profile = {
      schemaVersion: 1,
      id: 'default',
      name: '默认',
      priority: 0,
      entries: [
        { ip: '10.0.0.1', hostnames: ['api.example.com'], enabled: true },
        { ip: '10.0.0.2', hostnames: ['web.example.com'], enabled: true },
      ],
    };

    await writeProfile(directory, profile, { trusted: true });
    const raw = await readFile(join(directory, 'default.json'), 'utf8');

    expect(JSON.parse(raw)).toEqual(profile);
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  it('trusted 写入仍拦截同层内同一主机名的冲突映射', async () => {
    const profile: Profile = {
      schemaVersion: 1,
      id: 'default',
      name: '默认',
      priority: 0,
      entries: [
        { ip: '10.0.0.1', hostnames: ['API.example.com'], enabled: true },
        { ip: '10.0.0.2', hostnames: ['api.example.com'], enabled: true },
      ],
    };

    await expect(writeProfile(directory, profile, { trusted: true })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});
