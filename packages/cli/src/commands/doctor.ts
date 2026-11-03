import type { Command } from 'commander';
import pc from 'picocolors';
import { addWorkspaceOptions, printJson, workspaceOptions } from './common';

export function registerDoctorCommand(program: Command): void {
  addWorkspaceOptions(
    program
      .command('doctor [hostnames...]')
      .description('三路解析对比：托管规则 / 系统 DNS / 实际解析（只读）'),
    { json: true },
  )
    .option('--all', '诊断托管区块里的全部域名')
    .option('--concurrency <n>', '并发上限（默认 4）', (value) => Number.parseInt(value, 10))
    .option('--timeout <ms>', '单次 DNS 查询超时（默认 3000）', (value) =>
      Number.parseInt(value, 10),
    )
    .action(async (hostnames: string[], options) => {
      const { doctorHosts } = await import('@hostscli/core/doctor');
      const report = await doctorHosts({
        ...workspaceOptions(options),
        ...(options.all ? { all: true } : {}),
        ...(hostnames.length > 0 ? { hostnames } : {}),
        ...(options.concurrency !== undefined && !Number.isNaN(options.concurrency)
          ? { concurrency: options.concurrency }
          : {}),
        ...(options.timeout !== undefined && !Number.isNaN(options.timeout)
          ? { timeoutMs: options.timeout }
          : {}),
      });

      if (options.json) {
        printJson(report);
      } else {
        process.stdout.write(`hosts 文件：${report.filePath}\n`);
        process.stdout.write(
          `DNS 服务器：${report.dnsServers.servers.join(', ') || '（未发现，使用系统默认解析器）'}${pc.dim(
            `（来源：${report.dnsServers.source}）`,
          )}\n`,
        );
        const { renderDoctorTable } = await import('../output/table');
        process.stdout.write(`${renderDoctorTable(report.rows)}\n`);
        const { summary } = report;
        process.stdout.write(
          pc.dim(
            `共 ${summary.total} 个域名：生效 ${summary.effective}，未生效 ${summary.notEffective}，不确定 ${summary.indistinguishable}，正常 ${summary.normal}，NXDOMAIN ${summary.nxdomain}，网络异常 ${summary.unreachable}，双重异常 ${summary.doubleFailure}\n`,
          ),
        );
      }

      for (const warning of report.warnings) {
        process.stderr.write(pc.yellow(`警告：${warning}\n`));
      }

      if (report.exitCode !== 0) {
        process.exitCode = report.exitCode;
        if (!options.json) {
          process.stdout.write(
            pc.dim(
              report.exitCode === 5
                ? '退出码 5：存在规则未生效。\n'
                : '退出码 6：存在 NXDOMAIN / 网络层失败。\n',
            ),
          );
        }
      }
    });
}
