import { readFile } from 'node:fs/promises';
import { saveConfig } from '../storage/config';
import { configKeys, getConfigValue, setConfigValue } from '../storage/config';
import type { HostsCliConfig } from '../storage/config';
import { withWorkspace } from './context';
import type { WorkspaceOptions } from './context';
import { auditAuxWrite } from './aux-write';
import { hashBytes } from './history';

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function showConfig(options: WorkspaceOptions = {}): Promise<{
  configPath: string;
  config: HostsCliConfig;
}> {
  return withWorkspace(options, async (workspace) => ({
    configPath: workspace.paths.configPath,
    config: workspace.config,
  }));
}

export async function updateConfig(
  key: string,
  value: string,
  options: WorkspaceOptions = {},
): Promise<{ configPath: string; config: HostsCliConfig }> {
  return withWorkspace(options, async (workspace) => {
    const before = await readFileOrNull(workspace.paths.configPath);
    const config = setConfigValue(workspace.config, key, value);
    await saveConfig(workspace.paths.configPath, config);
    await auditAuxWrite(workspace, {
      command: 'config set',
      args: [key, value],
      beforeSha256: hashBytes(before),
      afterSha256: hashBytes(await readFileOrNull(workspace.paths.configPath)),
      detail: `配置 ${key} 设为 ${value}（${workspace.paths.configPath}）。`,
    });
    return { configPath: workspace.paths.configPath, config };
  });
}

export function availableConfigKeys(): string[] {
  return configKeys();
}

export { getConfigValue };
