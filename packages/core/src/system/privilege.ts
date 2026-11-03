import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 判断目标文件当前是否可以直接写入（不触发提权、不交互）。
 * 文件不存在时，只要求父目录可写（允许首次创建）。
 */
export async function canWriteDirectly(targetPath: string): Promise<boolean> {
  const directory = dirname(targetPath);
  const directoryWritable = await access(directory, constants.W_OK)
    .then(() => true)
    .catch(() => false);
  if (!directoryWritable) return false;

  try {
    await access(targetPath, constants.W_OK);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT';
  }
}

export function permissionHint(targetPath: string, platform: string = process.platform): string {
  if (platform === 'win32') {
    return `没有写入 ${targetPath} 的权限。请以管理员身份打开终端后重试，或调整该文件的 ACL。`;
  }
  return `没有写入 ${targetPath} 的权限。请使用 sudo 运行命令（例如 sudo hostscli ...）后重试，或调整文件权限。`;
}
