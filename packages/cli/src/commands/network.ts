import type { Command } from 'commander';
import pc from 'picocolors';
import {
  addDataDirOption,
  addWorkspaceOptions,
  printJson,
  printMutation,
  printWarnings,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

function parseLayers(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export function registerNetworkCommand(program: Command): void {
  const network = program
    .command('network')
    .description('按 Wi-Fi SSID 自动切换规则层（macOS/Linux）');

  addDataDirOption(network.command('status').description('显示当前网络与匹配的映射（只读）'), {
    json: true,
  }).action(async (options) => {
    const { networkStatus } = await import('@hostscli/core/network');
    const result = await networkStatus(workspaceOptions({ dataDir: options.dataDir }));

    if (options.json) {
      printJson(result);
      return;
    }
    const { network: info, mapping } = result;
    process.stdout.write(`网络：${info.ssid ?? '（未识别）'}（${info.source}）\n`);
    process.stdout.write(
      `映射：${mapping ? mapping.layers.join(', ') || '（空）' : '（未配置）'}\n`,
    );
    process.stdout.write(`当前启用层：${result.activeLayers.join(', ') || '（无）'}\n`);
    printWarnings(result.warnings);
  });

  addDataDirOption(
    network.command('map <ssid>').description('把 SSID 映射到一组规则层（后写覆盖前写）'),
    { json: true },
  )
    .option('--layers <ids>', '逗号分隔的层 ID，顺序即启用顺序')
    .option('--name <name>', '映射备注')
    .action(async (ssid: string, options) => {
      if (options.layers === undefined) {
        throw Object.assign(new Error('network map 需要 --layers <id,id>。'), {
          code: 'INVALID_INPUT',
        });
      }
      const { mapNetwork } = await import('@hostscli/core/network');
      const result = await mapNetwork({
        ...workspaceOptions({ dataDir: options.dataDir }),
        ssid,
        layers: parseLayers(options.layers),
        ...(options.name !== undefined ? { name: options.name } : {}),
      });

      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        `${result.replaced ? '已更新' : '已添加'}映射：${ssid} → ${result.mapping.layers.join(', ') || '（空）'}\n`,
      );
      printWarnings(result.warnings);
    });

  addDataDirOption(network.command('unmap <ssid>').description('删除 SSID 映射'), {
    json: true,
  }).action(async (ssid: string, options) => {
    const { unmapNetwork } = await import('@hostscli/core/network');
    await unmapNetwork({
      ...workspaceOptions({ dataDir: options.dataDir }),
      ssid,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ removed: ssid }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`已删除映射：${ssid}\n`);
  });

  addWorkspaceOptions(
    network.command('auto').description('按当前 SSID 应用映射（默认只预览，--apply 落盘）'),
    { json: true, verify: true },
  )
    .option('--apply', '实际切换并写入 hosts（缺省只预览）')
    .action(async (options) => {
      const { networkAuto } = await import('@hostscli/core/network');
      const effective = { ...options, dryRun: !options.apply };
      const filePath = await resolveTargetPath(options);
      if (options.apply) warnSystemHosts(filePath, options, '写入');

      const result = await networkAuto(workspaceOptions(effective));
      if (options.json) {
        printJson(result);
        return;
      }

      process.stdout.write(
        `网络：${result.network.ssid} → ${result.mapping.layers.join(', ') || '（空）'}\n`,
      );
      if (result.changedLayers) {
        process.stdout.write(
          `启用层：${result.previousLayers.join(', ') || '（无）'} → ${result.mapping.layers.join(', ') || '（无）'}\n`,
        );
      } else {
        process.stdout.write(pc.dim('启用层未变化。\n'));
      }
      if (!result.dryRun && result.mutation) {
        printMutation(
          result.mutation,
          { json: false },
          {
            success: '已按当前网络写入 hosts。',
            unchanged: '渲染结果与当前托管区块一致，无需写入。',
          },
        );
      } else {
        process.stdout.write(pc.dim('dry-run：确认后加 --apply 落盘。\n'));
      }
      printWarnings(result.warnings);
    });
}
