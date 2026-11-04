import type { Command } from 'commander';
import pc from 'picocolors';
import {
  addDataDirOption,
  addWorkspaceOptions,
  conflictStrategy,
  parsePriorityOption,
  printJson,
  printMutation,
  printWarnings,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

export function registerStackCommand(program: Command): void {
  const stack = program.command('stack').description('规则栈：多层规则、优先级与冲突裁决');

  const layer = stack.command('layer').description('管理规则层');

  addDataDirOption(
    layer.command('add <id>').description('从层文件导入为一层（JSON 方案或纯 hosts 文本）'),
    { json: true },
  )
    .option('--file <path>', '层文件路径（必填）')
    .option('--name <name>', '层显示名')
    .option('--priority <n>', '优先级（越大越优先，默认取文件值或 0）', parsePriorityOption)
    .option('--force', '覆盖同名层')
    .option('--no-enable', '只导入，不加入启用集合')
    .action(async (id: string, options) => {
      if (!options.file) {
        throw Object.assign(new Error('stack layer add 需要 --file <path>。'), {
          code: 'INVALID_INPUT',
        });
      }
      const { addStackLayer } = await import('@hostscli/core/stack');
      const result = await addStackLayer({
        ...workspaceOptions({ dataDir: options.dataDir }),
        id,
        file: options.file,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
        force: Boolean(options.force),
        enable: options.enable !== false,
      });

      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        `${result.replaced ? '已覆盖' : '已导入'}层 ${result.profile.id}（${result.profile.entries.length} 条，priority ${result.profile.priority}）${
          result.enabled ? '，已启用' : '，未启用'
        }。\n`,
      );
      if (result.enabled) {
        process.stdout.write(pc.dim('运行 hostscli stack apply --apply 将最终结果写入 hosts。\n'));
      }
    });

  addDataDirOption(
    layer.command('enable <id>').description('启用一层（不改变优先级；需再 apply）'),
    { json: true },
  ).action(async (id: string, options) => {
    const { setStackLayerEnabled } = await import('@hostscli/core/stack');
    const result = await setStackLayerEnabled({
      ...workspaceOptions({ dataDir: options.dataDir }),
      id,
      enabled: true,
    });
    if (options.json) {
      printJson(result);
      return;
    }
    process.stdout.write(
      result.changed ? `已启用层 ${id}。\n` : pc.dim(`层 ${id} 已处于启用状态。\n`),
    );
    printWarnings(result.warnings);
  });

  addDataDirOption(
    layer.command('disable <id>').description('停用一层（该层条目在下次 apply 后消失）'),
    { json: true },
  ).action(async (id: string, options) => {
    const { setStackLayerEnabled } = await import('@hostscli/core/stack');
    const result = await setStackLayerEnabled({
      ...workspaceOptions({ dataDir: options.dataDir }),
      id,
      enabled: false,
    });
    if (options.json) {
      printJson(result);
      return;
    }
    process.stdout.write(
      result.changed ? `已停用层 ${id}。\n` : pc.dim(`层 ${id} 已处于停用状态。\n`),
    );
    printWarnings(result.warnings);
  });

  addDataDirOption(layer.command('list').description('列出规则层'), { json: true }).action(
    async (options) => {
      const { listStackLayers } = await import('@hostscli/core/stack');
      const result = await listStackLayers(workspaceOptions({ dataDir: options.dataDir }));
      if (options.json) {
        printJson({
          activeLayers: result.activeLayers,
          layers: result.layers.map((view) => ({
            ...view.profile,
            active: view.active,
            entryCount: view.entryCount,
            disabledCount: view.disabledCount,
            ttlCount: view.ttlCount,
          })),
        });
        return;
      }
      const { renderStackLayerTable } = await import('../output/table');
      process.stdout.write(`${renderStackLayerTable(result.layers)}\n`);
      process.stdout.write(pc.dim(`启用顺序：${result.activeLayers.join(', ') || '（无）'}\n`));
    },
  );

  addWorkspaceOptions(
    stack.command('apply').description('按启用的层重建托管区块（默认 dry-run，--apply 落盘）'),
    { json: true, onConflict: true, verify: true },
  )
    .option('--apply', '实际写入 hosts（缺省只预览 diff）')
    .option('--dry-run', '只预览（默认行为）')
    .action(async (options) => {
      if (options.dryRun && options.apply) {
        throw Object.assign(new Error('--apply 与 --dry-run 不能同时使用。'), {
          code: 'INVALID_INPUT',
        });
      }
      const { applyStack } = await import('@hostscli/core/stack');
      const effective = { ...options, dryRun: !options.apply };
      const filePath = await resolveTargetPath(options);
      if (options.apply) warnSystemHosts(filePath, options, '写入');

      const result = await applyStack({
        ...workspaceOptions(effective),
        onConflict: conflictStrategy(options),
      });
      printMutation(result, effective, {
        success: '已按规则栈写入最终结果。',
        unchanged: '规则栈渲染结果与当前托管区块一致，无需写入。',
      });
      if (!options.apply && !options.json) {
        process.stdout.write(pc.dim('dry-run：确认后加 --apply 落盘。\n'));
      }
    });

  addWorkspaceOptions(
    stack.command('explain <hostname>').description('解释单个域名的候选链与最终结果'),
    { json: true, onConflict: true },
  ).action(async (hostname: string, options) => {
    const { explainStackHostname } = await import('@hostscli/core/stack');
    const result = await explainStackHostname({
      ...workspaceOptions(options),
      hostname,
      onConflict: conflictStrategy(options),
    });

    if (options.json) {
      printJson(result);
    } else {
      process.stdout.write(`${result.hostname}\n`);
      for (const candidate of result.candidates) {
        const marker = result.conflict
          ? pc.red('[conflict]')
          : candidate.selected
            ? pc.green('[active]')
            : pc.dim('[shadowed]');
        process.stdout.write(
          `  ← ${candidate.layerId} (priority ${candidate.priority}) ${candidate.ip} ${marker}\n`,
        );
      }
      for (const mapping of result.external) {
        process.stdout.write(
          `  external line ${mapping.line}: ${mapping.raw} ${pc.dim('[external]')}\n`,
        );
      }
      process.stdout.write(
        result.conflict
          ? `${pc.red('result: 无法裁决（同优先级同名多 IP）')}\n`
          : `result: ${result.result ?? '（无托管结果）'}\n`,
      );
    }

    printWarnings(result.warnings);
    if (result.conflict) {
      throw Object.assign(
        new Error(`主机名 ${result.hostname} 存在冲突，请用 --on-conflict 明确裁决策略。`),
        { code: 'CONFLICT' },
      );
    }
  });
}
