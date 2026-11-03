import { saveConfig } from '../storage/config';
import { configKeys, getConfigValue, setConfigValue } from '../storage/config';
import type { HostsCliConfig } from '../storage/config';
import { withWorkspace } from './context';
import type { WorkspaceOptions } from './context';

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
    const config = setConfigValue(workspace.config, key, value);
    await saveConfig(workspace.paths.configPath, config);
    return { configPath: workspace.paths.configPath, config };
  });
}

export function availableConfigKeys(): string[] {
  return configKeys();
}

export { getConfigValue };
