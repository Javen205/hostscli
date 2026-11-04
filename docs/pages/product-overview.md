# 产品概览

## 1. 定位

`hostscli` 是面向开发者的跨平台 hosts 管理命令行工具。它把系统 hosts 文件中的一小段区域变成**结构化、可回滚的单条记录**，并把"临时规则到期恢复"变成工具状态，而不是依赖人的记忆。

与其他 hosts 工具相比，它的侧重点不是再实现一遍 `add / remove / list`，而是三件事：

1. **细粒度时间语义**：单条记录可以定时禁用并自动恢复，而不是整个方案临时生效。
2. **规则分层**：多个规则集可以并存，按优先级合并，并解释最终结果的来源。
3. **生效可验证**：写入后可以抽查解析结果，失败自动回滚；`doctor` 对比托管规则、系统 DNS 与实际解析。

## 2. 目标用户

| 优先级 | 用户群 | 典型诉求 |
| --- | --- | --- |
| P0 | 本地联调的前后端工程师 | 把域名临时指向测试机；切回线上；临时映射用完自动失效 |
| P1 | 运维 / SRE / 测试环境搭建者 | 多套环境规则并存；批量下发；改完能确认真的生效 |
| P2 | CI / 容器 / 临时调试机使用者 | 非交互执行；输出可机读；退出码稳定 |

前提是使用者机器上已有 Node.js（`>=20`）。分发路径以 npm 为主。

## 3. 解决的痛点

| 痛点 | 现实表现 | hostscli 的对应能力 |
| --- | --- | --- |
| 手改 hosts 无保护 | 误删、编码或行尾被编辑器改坏、没有备份 | 无损读写、写入前自动备份、原子替换、`restore` |
| 环境切换靠复制粘贴 | 开发 / 测试 / 预发规则互相覆盖 | 方案（profile）与规则栈分层叠加 |
| 临时映射忘记清理 | 本地正常、线上异常，排查成本高 | 单条记录 TTL 定时禁用，到期自动恢复 |
| 改完不知道是否生效 | 被 DNS 缓存、代理、格式问题挡住 | 自动刷新 DNS；`doctor` 三路对比 |
| 平台差异 | 路径不同、需要提权、Windows 行尾与文件占用不同 | 平台适配层统一封装 |
| 无法脚本化 | 图形工具只能人点，输出不可机读 | `--json`、`--dry-run`、稳定退出码 |

## 4. 能力总览

命令清单与实现一一对应，共 21 个一级命令。

| 能力 | 命令 | 说明 |
| --- | --- | --- |
| 查看 | `list` | 区分托管 / 非托管、启用 / 禁用 / TTL 禁用，支持 `--json` |
| 单条增删改 | `add` / `remove` / `enable` / `disable` | 多个主机名按每行一个写入；写入只发生在围栏内 |
| 初始化与重建 | `init` / `apply` | 初始化数据目录与空托管区块；按当前生效规则重建 |
| 备份与恢复 | `backup` / `restore` | 写入前自动备份；恢复前校验，失败回滚 |
| 方案管理 | `profile` | 创建、切换、保存、更新、删除规则集 |
| 定时禁用 | `ttl` | `list` / `due` / `pause` / `resume` / `extend` / `restore` / `cancel` / `tick` |
| 规则栈 | `stack` | 多层规则、优先级、冲突策略、`explain` 候选链 |
| DNS 诊断 | `doctor` | 托管规则 / 系统 DNS / 实际解析三路对比，只读 |
| 远程订阅 | `remote` | 拉取远程 hosts 内容为规则层，支持 ETag 缓存 |
| DNS 缓存 | `dns flush` | 按平台尝试系统刷新命令，失败只警告 |
| 配置 | `config` | 查看、修改白名单配置项 |
| 网络切换 | `network` | 按 Wi-Fi SSID 映射规则层（macOS / Linux） |
| 数据目录快照 | `git` | 独立 git 仓库记录数据目录，不触碰系统 hosts |
| 导出 | `export` | 导出 config / state / profiles 快照，支持 JSON / YAML |
| 审计 | `audit list` | 写入后验证与回滚的 JSONL 审计日志 |
| Shell 补全 | `completion` | 输出 bash / zsh / fish 补全脚本 |

完整参数与示例见 [cli-reference.md](./cli-reference.md)。

## 5. 托管方式与数据目录

hostscli 只改写由下列围栏圈定的区域：

```text
# >>> hostscli managed (do not edit inside) >>>
10.0.0.12   api.example.com
# <<< hostscli managed <<<
```

围栏之外的内容逐字节保留，包括空行、缩进、注释、行尾与 BOM。起止围栏必须各恰好出现一次。

运行数据默认位于 `~/.hostscli`，可用环境变量 `HOSSCLI_HOME` 或 `--data-dir` 覆盖：

```text
config.json          配置（0600）
state.json           运行态：activeLayers / initialized / ttl / lastRender（时间与整文件哈希）/ sessions（0600）
profiles/<id>.json   方案（规则集）
backups/             hosts 备份
cache/remote/        远程订阅内容与 ETag
audit.log            JSONL 审计（0600）
.git/                可选的 git 快照仓库
```

## 6. 与其他工具的差异

| 工具 | 形态 | 与 hostscli 的主要差异 |
| --- | --- | --- |
| SwitchHosts | GUI 桌面应用 | 图形界面是它的优势；hostscli 不提供 GUI，专注命令行与脚本化 |
| hostctl | Go CLI | 有 profile 切换与 profile 级临时配置；hostscli 提供单条记录级 TTL |
| goodhosts | Go CLI | CRUD 与备份完备；hostscli 额外提供规则栈、TTL 与诊断 |
| txeh | Go 库 + CLI | 偏编程接口；hostscli 是面向终端与脚本的 CLI |

hostscli 不追求覆盖图形工具的全部体验，差异化集中在"单条记录的时间语义 + 分层规则 + 可验证生效"。

## 7. 明确的边界

以下内容当前版本未提供：

- 托盘、菜单栏、可视化编辑器、TUI 外壳。
- 常驻 daemon；TTL 默认通过命令启动时的惰性结算执行，也可用 `ttl tick` 配合系统 cron。
- 系统级定时器安装命令（LaunchDaemon / systemd timer / Windows 计划任务）。
- 修改系统 DNS 配置或管理 DNS 记录；`doctor` 与 `dns flush` 只做诊断与缓存刷新。
- 改写围栏以外的 hosts 行。
- 通配域名、敏感规则加密、多机同步、AI 自然语言转操作。
- 导入 SwitchHosts 数据。
- Windows 的 Wi-Fi SSID 识别与 PowerShell 补全。

### 规模与数据目录占用

以默认 `historyKeep=30`、`backupKeep=20`、每条规则一个主机名为夹具，实测（macOS / APFS；字节数是落盘文件总量，耗时受机器负载影响仅供参考）：

| hosts 规模 | hosts 文件 | 单次写回落盘 | 稳态数据目录 | 稳态 / hosts | 峰值 RSS | 单次写回耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| 60k | 2.15 MB | 12.7 MB | 238 MB | 约 116 倍 | 约 556 MB | 约 3.3 s |
| 100k | 3.59 MB | 21.1 MB | 396 MB | 约 116 倍 | 约 864 MB | 约 5.8 s |
| 200k | 7.31 MB | 42.8 MB | 803 MB | 约 115 倍 | 约 1.6 GB | 约 11 s |

- **60k：可用。** 每次写回在数秒内完成，数据目录约数百 MB，普通开发机可以承受。
- **100k：经本次优化后仍偏重。** 单次写回约 6 秒、稳态目录约 400 MB、峰值内存约 860 MB；写入频繁或磁盘紧张时体验明显下降。
- **200k：不支持。** 单次写回超过 10 秒、稳态目录约 800 MB、峰值内存约 1.6 GB，低内存机器有被系统终止的风险。

超出上述规模时，每次写回都会重写 hosts、方案与 state，并生成 undo 快照与备份，等待时间与目录占用同步上升；稳态目录约为 hosts 文件的 115 倍，可按 `hosts 文件大小 × 115` 估算。需要压缩占用时可降低 `defaults.historyKeep` / `defaults.backupKeep`，代价是 undo 可回退步数与备份份数减少。

本次优化移除了 `state.lastRender` 中按主机名逐条保存的来源副本；该副本没有读取方，`stack explain` 与 `doctor` 都从当前规则和 hosts 现算。稳态占用因此从约 hosts 的 216 倍降到约 116 倍，旧 state 中的该字段会被忽略，下一次写入后自然消失。

## 8. 运行要求

| 项 | 要求 |
| --- | --- |
| Node.js | `>=20` |
| 操作系统 | macOS、Linux、Windows；其他平台返回 `UNSUPPORTED_PLATFORM` |
| 写系统 hosts | macOS / Linux 需要 `sudo`；Windows 需要管理员终端 |
| 只读试运行 | 所有写命令支持 `--dry-run` |
