# hostscli

跨平台 hosts 管理命令行工具。它把系统 hosts 文件中的一小段托管区域变成结构化数据，支持增删改查、方案切换、定时恢复和诊断，同时逐字节保留托管区之外的所有内容。

## 安装与使用

```bash
# npm
npm i -g hostscli

# 或 pnpm
pnpm add -g hostscli

# 确认安装
hostscli --help
```

写系统 hosts 需要相应权限：macOS / Linux 使用 `sudo`，Windows 使用管理员终端。只想先试运行可加 `--dry-run`。macOS 与 Linux 使用 `/etc/hosts`，Windows 使用 `%SystemRoot%\System32\drivers\etc\hosts`；macOS 已在本机验证，Linux / Windows 的路径与命令分支已实现，但仍需真机验收。

**查看当前条目**

```bash
hostscli list
hostscli list --json
```

**添加一条规则**

```bash
sudo hostscli add 10.0.0.12 api.example.com
```

**启用与禁用**

```bash
sudo hostscli disable api.example.com --reason "排查故障"
sudo hostscli enable api.example.com
```

**带 TTL 的临时禁用**

```bash
sudo hostscli disable api.example.com --for 30m --reason "临时维护"
sudo hostscli ttl list
```

`--for` 支持 `30m`、`2h`、`3d`、`1h30m`。到期后可执行 `sudo hostscli ttl tick` 结算并恢复；不执行 `tick` 时，下一次写操作也会惰性恢复。

**按方案或网络切换**

```bash
# 把当前托管区保存为方案，再切换
sudo hostscli profile create office --from-current
sudo hostscli profile use office

# 接入指定 Wi-Fi 时自动启用对应规则层
sudo hostscli network map "Office Wi-Fi" --layers office
sudo hostscli network auto --apply
```

**备份与回滚**

```bash
sudo hostscli backup
sudo hostscli backup --list
sudo hostscli restore --yes

# 数据目录快照（需要本机安装 git）
hostscli git snapshot -m "before change"
hostscli git log
sudo hostscli git rollback <rev>
```

**DNS 诊断**

```bash
hostscli doctor api.example.com
hostscli doctor --all
hostscli dns flush --json
```

`doctor` 对比托管规则、系统 DNS 服务器与实际解析结果；`dns flush` 按平台刷新 DNS 缓存。

## 功能介绍

- **托管区增删改查**：`add`、`remove`、`enable`、`disable`、`list` 只操作围栏内的托管条目，围栏外内容（注释、空行、行尾、BOM）逐字节保留。
- **方案（profile）**：把不同场景的规则保存为多个方案，`profile use` 切换时重建托管区，适合办公室 / 家庭 / 出差等环境。
- **单条 TTL**：`disable --for 30m` 临时禁用一条记录，到期自动恢复，避免忘记手动改回。
- **规则栈**：多个命名层按优先级合并，支持 `fail`、`highest-priority`、`first-wins`、`last-wins` 冲突策略，`stack explain` 可查看某个域名的候选链。
- **网络感知切换**：`network map` 把 Wi-Fi SSID 映射到规则层，`network auto --apply` 在接入该网络时切换；Windows 不支持 SSID 识别。
- **备份与快照**：每次写入前自动备份，`restore` 可恢复最近或指定备份；`git snapshot` / `rollback` 管理数据目录历史。
- **DNS 诊断**：`doctor` 对比规则、系统 DNS 与实际解析，帮助定位缓存或上游问题。
- **远程订阅**：`remote add/update` 拉取远程 hosts 规则，支持 ETag 缓存、超时与大小上限，失败时保留上次成功内容。
- **写入后验证**：写操作加 `--verify` 会抽查托管域名解析，失败自动回滚并记录审计。
- **导出与审计**：`export --format json|yaml` 导出可迁移快照；`audit list` 查看写入、验证与回滚记录。
- **Shell 补全**：`completion bash|zsh|fish` 生成补全脚本。

## 贡献代码与开发流程

```bash
git clone https://github.com/Javen205/hostscli.git
cd hostscli
corepack enable
pnpm install
```

常用命令：

| 命令                | 作用                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `pnpm build`        | 构建 `packages/core` 与 `packages/cli`（tsup，输出 `dist/`）       |
| `pnpm test`         | 运行 Vitest 测试                                                   |
| `pnpm lint`         | ESLint 检查                                                        |
| `pnpm typecheck`    | TypeScript 类型检查（两个包）                                      |
| `pnpm format:check` | Prettier 格式检查；需要自动修复时用 `pnpm format`                  |
| `pnpm verify`       | 单一验证入口：build、typecheck、lint、test、格式、冒烟与命令级 e2e |

目录结构：

- `packages/core`：hosts 解析/渲染、规则合并、方案与状态存储、原子写、备份、诊断、远程订阅等核心逻辑，不依赖 CLI。
- `packages/cli`：Commander 命令定义、输出格式与入口；命令按需加载，通过 `@hostscli/core` 的子路径导入所需能力。

提交 PR 前：

1. 改动前先跑 `pnpm test`，改动后跑 `pnpm verify`（包含 build、typecheck、lint、test、format:check、冒烟与命令级 e2e）；依赖已装好时用 `pnpm verify:fast` 跳过安装。
2. 对外可见的变更（新命令、参数、行为调整）用 Changesets 记录：`pnpm changeset`，按提示选择包与变更类型。
3. 提交信息使用 Conventional Commits，例如 `feat: 支持按网络切换规则层`、`fix: 修复围栏外内容被改写`。说明"为什么"，而不是复述 diff。
4. 不要提交 `node_modules/`、`dist/`、临时数据目录或系统 hosts 的测试副本。
