import { chmod, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { ExportSnapshot } from '@hostscli/core';
import { stringify } from 'yaml';
import { addDataDirOption, workspaceOptions } from './common';

export type ExportFormat = 'json' | 'yaml';

/** JSON 固定 2 空格缩进；YAML 由 `yaml` 库序列化，两者内容等价。 */
export function serializeSnapshot(snapshot: ExportSnapshot, format: ExportFormat): string {
  return format === 'yaml' ? stringify(snapshot) : `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function registerExportCommand(program: Command): void {
  addDataDirOption(
    program
      .command('export')
      .description('导出 config / state / profiles 快照（便于迁移与版本库管理）'),
    {},
  )
    .option('--format <format>', 'json（默认）或 yaml', 'json')
    .option('--out <file>', '写入文件（默认输出到 stdout）')
    .action(async (options) => {
      const format = options.format ?? 'json';
      if (format !== 'json' && format !== 'yaml') {
        throw Object.assign(new Error('--format 只接受 json / yaml。'), {
          code: 'INVALID_INPUT',
        });
      }

      const { exportSnapshot } = await import('@hostscli/core/export');
      const snapshot = await exportSnapshot(workspaceOptions({ dataDir: options.dataDir }));
      const text = serializeSnapshot(snapshot, format);

      if (options.out) {
        await writeFile(options.out, text, { mode: 0o600 });
        // writeFile 的 mode 只对新建文件生效；已存在的文件显式收紧权限。
        await chmod(options.out, 0o600);
        process.stdout.write(`已导出：${options.out}\n`);
        return;
      }
      process.stdout.write(text);
    });
}
