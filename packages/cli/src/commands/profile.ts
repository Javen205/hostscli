import type { Command } from 'commander';
import pc from 'picocolors';
import { binName } from '../program-name';
import {
  addDataDirOption,
  addWorkspaceOptions,
  confirm,
  conflictStrategy,
  parseNameOption,
  parsePriorityOption,
  printJson,
  printMutation,
  resolveTargetPath,
  warnSystemHosts,
  workspaceOptions,
} from './common';

export function registerProfileCommand(program: Command): void {
  const profile = program.command('profile').description('管理方案（规则集）');

  // list/show/update/remove 只读写数据目录，声明 --file 会误导成"会读写 hosts"。
  addDataDirOption(profile.command('list').description('列出方案'), { json: true }).action(
    async (options) => {
      const { listProfiles } = await import('@hostscli/core/profiles');
      const result = await listProfiles(workspaceOptions(options));
      if (options.json) {
        printJson({
          activeLayers: result.activeLayers,
          profiles: result.profiles.map((view) => ({
            id: view.profile.id,
            name: view.profile.name,
            priority: view.profile.priority,
            entryCount: view.entryCount,
            active: view.active,
          })),
        });
        return;
      }
      const { renderProfileTable } = await import('../output/table');
      process.stdout.write(`${renderProfileTable(result.profiles)}\n`);
    },
  );

  addDataDirOption(profile.command('show <id>').description('查看方案内容'), {
    json: true,
  }).action(async (id: string, options) => {
    const { showProfile, profileEntriesToHostEntries } = await import('@hostscli/core/profiles');
    const result = await showProfile(id, workspaceOptions(options));
    if (options.json) {
      printJson(result);
      return;
    }
    const { renderEntryTable } = await import('../output/table');
    process.stdout.write(`方案 ${result.id}（${result.name}，priority ${result.priority}）\n`);
    // 与 list 共用同一套表格与序号规则（序号仅渲染层，不写入 --json）。
    process.stdout.write(
      `${renderEntryTable(profileEntriesToHostEntries(result), { index: true })}\n`,
    );
  });

  addWorkspaceOptions(
    profile.command('create <id>').description('创建方案；--from-current 导入当前托管区块'),
    { json: true, dnsFlush: false },
  )
    .option('--name <name>', '方案显示名', parseNameOption)
    .option('--priority <n>', '优先级（越大越优先）', parsePriorityOption)
    .option('--from-current', '把当前托管区块的条目导入新方案')
    .action(async (id: string, options) => {
      const { createProfileFromCurrent } = await import('@hostscli/core/profiles');
      const result = await createProfileFromCurrent({
        ...workspaceOptions(options),
        id,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
        fromCurrent: Boolean(options.fromCurrent),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        `已创建方案 ${result.id}（${result.entries.length} 条）。使用 ${binName()} profile use ${result.id} 切换。\n`,
      );
    });

  addWorkspaceOptions(profile.command('use <id>').description('切换到指定方案并重建托管区块'), {
    json: true,
    dryRun: true,
    onConflict: true,
    verify: true,
  }).action(async (id: string, options) => {
    const { useProfile } = await import('@hostscli/core/profiles');
    const filePath = await resolveTargetPath(options);
    warnSystemHosts(filePath, options, '写入');
    const result = await useProfile({
      ...workspaceOptions(options),
      id,
      onConflict: conflictStrategy(options),
    });
    if (result.switched) {
      printMutation(result, options, {
        success: `已切换到方案 ${id}。`,
        unchanged: `已切换到方案 ${id}（托管区块内容无变化）。`,
      });
      return;
    }
    printMutation(result, options, {
      success: `方案 ${id} 已是当前方案。`,
      unchanged: `方案 ${id} 已是当前方案，托管区块无变化。`,
    });
  });

  addWorkspaceOptions(profile.command('save <id>').description('把当前托管区块保存进指定方案'), {
    json: true,
    dnsFlush: false,
  })
    .option('--prune', '删除当前被禁用或被 TTL 隐藏的条目（默认保留）')
    .action(async (id: string, options) => {
      const { saveProfileFromCurrent } = await import('@hostscli/core/profiles');
      const result = await saveProfileFromCurrent({
        ...workspaceOptions(options),
        id,
        prune: Boolean(options.prune),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(`已保存方案 ${id}（${result.entries.length} 条）。\n`);
    });

  addWorkspaceOptions(
    profile
      .command('move <hostname>')
      .description('把条目迁移到另一个方案（保留 IP、启用状态、注释与 TTL）'),
    { json: true, dryRun: true, onConflict: true },
  )
    .requiredOption('--from <id>', '源方案 ID')
    .requiredOption('--to <id>', '目标方案 ID')
    .option('--force', '目标方案已有同名主机名时覆盖：冲突主机名改指向被迁移条目的 IP')
    .action(async (hostname: string, options) => {
      const { moveProfileEntry } = await import('@hostscli/core/profiles');
      const result = await moveProfileEntry({
        ...workspaceOptions(options),
        hostname,
        from: options.from,
        to: options.to,
        force: Boolean(options.force),
        ...(options.onConflict !== undefined ? { onConflict: conflictStrategy(options) } : {}),
      });
      const extras = [
        result.ttlRecords > 0 ? `TTL ${result.ttlRecords} 条一并迁移` : '',
        result.replacedHostnames.length > 0 ? `覆盖 ${result.replacedHostnames.join(', ')}` : '',
      ]
        .filter((item) => item !== '')
        .join('；');
      const suffix = extras === '' ? '' : `（${extras}）`;
      if (options.json) {
        // 迁移结果包含 from/to/movedIp/ttlRecords 等字段，printMutation 的
        // 通用 payload 会丢掉它们，因此这里直接输出完整结果。
        printJson(result);
        return;
      }
      printMutation(result, options, {
        success:
          `已迁移 ${result.movedIp} -> ${result.movedHostnames.join(', ')}：` +
          `${result.from} → ${result.to}${suffix}`,
        unchanged:
          `已迁移 ${result.movedIp} -> ${result.movedHostnames.join(', ')}：` +
          `${result.from} → ${result.to}${suffix}（hosts 无变化，方案文件已更新）`,
      });
      // 目标方案未生效时条目会从 hosts 中消失，容易被误认为丢数据，必须明确告知。
      // dry-run 没有真正迁移，不提示；--json 走 toActive 字段。
      if (!options.dryRun && !result.toActive) {
        process.stdout.write(
          pc.dim(
            `提示：方案 ${result.to} 未生效，用 ${binName()} profile use ${result.to} 切换后生效，` +
              `或 ${binName()} list --profile ${result.to} 查看。\n`,
          ),
        );
      }
    });

  addDataDirOption(profile.command('update <id>').description('更新方案名称或优先级'), {
    json: true,
  })
    .option('--name <name>', '新的显示名', parseNameOption)
    .option('--priority <n>', '新的优先级', parsePriorityOption)
    .action(async (id: string, options) => {
      const { updateProfileMeta } = await import('@hostscli/core/profiles');
      const result = await updateProfileMeta(
        id,
        {
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.priority !== undefined ? { priority: options.priority } : {}),
        },
        workspaceOptions(options),
      );
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(`已更新方案 ${id}。\n`);
    });

  addDataDirOption(profile.command('remove <id>').description('删除方案（生效中的方案不可删除）'), {
    json: true,
  })
    .option('--yes', '跳过确认')
    .action(async (id: string, options) => {
      if (!options.yes && !options.json) {
        const confirmed = await confirm(`确认删除方案 ${id}？`);
        if (!confirmed) {
          throw Object.assign(new Error('已取消删除。'), { code: 'CANCELLED' });
        }
      }
      const { removeProfile } = await import('@hostscli/core/profiles');
      await removeProfile(id, workspaceOptions(options));
      if (options.json) {
        printJson({ removed: id });
        return;
      }
      process.stdout.write(`已删除方案 ${id}。\n`);
    });
}
