import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BEGIN_MARKER, END_MARKER } from '../index';

export const HOSTS = [
  '# keep this byte-for-byte',
  '127.0.0.1 localhost',
  '',
  BEGIN_MARKER,
  '10.0.0.12  api.example.com',
  END_MARKER,
  '',
  '192.168.1.1 nas.local',
  '',
].join(EOL);

export interface TestEnv {
  directory: string;
  hostsPath: string;
  dataDir: string;
  options: () => {
    filePath: string;
    dataDir: string;
    env: NodeJS.ProcessEnv;
    dnsFlush: false;
    now: Date;
  };
  cleanup: () => Promise<void>;
}

export async function makeEnv(initial = HOSTS): Promise<TestEnv> {
  const directory = await mkdtemp(join(tmpdir(), 'hostscli-batch1-'));
  const hostsPath = join(directory, 'hosts');
  const dataDir = join(directory, 'data');
  await writeFile(hostsPath, initial);
  return {
    directory,
    hostsPath,
    dataDir,
    options: () => ({
      filePath: hostsPath,
      dataDir,
      env: { ...process.env, HOME: directory },
      dnsFlush: false as const,
      now: new Date('2026-11-02T00:00:00.000Z'),
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function readStateFile(env: TestEnv): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(env.dataDir, 'state.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}
