# hostscli

> 为了联调改一行 hosts，切回环境再改回来；临时禁用忘了撤销，几天后谁也说不清哪条是干净的。

`hostscli` 把系统 hosts 文件里的一小段托管区域变成**结构化、可回滚的单条记录**：加一条、看当前状态、临时禁用十分钟、到期自动恢复，都不用再手动编辑整份文件。

它和手改或图形工具的区别：

- **只碰托管区**：围栏之外的注释、空行、行尾和 BOM 逐字节保留，不会顺手重排整份 hosts。
- **记录而不是文本**：启用 / 禁用 / TTL / 规则层都是状态，不是散落在文件里的注释行。
- **可追溯**：每次写入前自动备份，数据目录可做 git 快照，也能导出 JSON / YAML。

## 安装与使用

```bash
# npm
npm i -g hostscli

# 或 pnpm
pnpm add -g hostscli

# 确认安装
hostscli --help
```

写系统 hosts 需要相应权限：macOS / Linux 用 `sudo`，Windows 用管理员终端。macOS 与 Linux 使用 `/etc/hosts`，Windows 使用 `%SystemRoot%\System32\drivers\etc\hosts`；三平台的路径与命令分支已在 CI 覆盖，真实写入仍需提权。只想先看效果可以加 `--dry-run`。

### 30 秒上手

```bash
# 加一条规则
sudo hostscli add 10.0.0.12 api.example.com
# 已添加：10.0.0.12 -> api.example.com

# 看当前托管区
hostscli list
# ┌───────────┬─────────────────┬─────────┬─────────┬─────────┐
# │ IP        │ HOSTNAMES       │ STATUS  │ SOURCE  │ COMMENT │
# ├───────────┼─────────────────┼─────────┼─────────┼─────────┤
# │ 10.0.0.12 │ api.example.com │ enabled │ managed │         │
# └───────────┴─────────────────┴─────────┴─────────┴─────────┘
# 文件: /etc/hosts | 生效层: default | 托管 1 条，禁用 0 条，TTL 0 条，非托管 0 条

# 临时禁用 10 分钟
sudo hostscli disable api.example.com --for 10m --reason "临时维护"
# 已设置 TTL：api.example.com 将在 10m 后自动恢复

# 10 分钟后结算并恢复
sudo hostscli ttl tick
# 已恢复 1 条到期 TTL。
```

不执行 `ttl tick` 时，下一次写操作也会惰性恢复到期记录；`ttl list` 可查看剩余时间和暂停状态。

### 常用操作

```bash
# 查看 JSON
hostscli list --json

# 启用 / 禁用（不加 --for 时保持禁用）
sudo hostscli disable api.example.com --reason "排查故障"
sudo hostscli enable api.example.com

# 删除
sudo hostscli remove api.example.com
```

`--for` 支持 `30m`、`2h`、`3d`、`1h30m`。

### 方案与网络切换

```bash
# 把当前托管区保存为方案，再切换
sudo hostscli profile create office --from-current
sudo hostscli profile use office

# 接入指定 Wi-Fi 时自动启用对应规则层
sudo hostscli network map "Office Wi-Fi" --layers office
sudo hostscli network auto --apply
```

Windows 不支持 SSID 识别；`network auto` 以 `NETWORK` 错误退出（退出码 6），不写入配置、不做切换。

### 备份、快照与导出

```bash
# 系统 hosts 备份
sudo hostscli backup
sudo hostscli backup --list
sudo hostscli restore --yes

# 数据目录快照（需要本机安装 git）
hostscli git snapshot -m "before change"
hostscli git log
sudo hostscli git rollback <rev>

# 导出可迁移快照
hostscli export --format json
hostscli export --format yaml
```

### 诊断

```bash
hostscli doctor api.example.com
hostscli doctor --all
hostscli dns flush --json
```

`doctor` 对比托管规则、系统 DNS 服务器与实际解析结果；`dns flush` 按平台刷新 DNS 缓存。

## 功能介绍

- **托管区增删改查**：`add`、`remove`、`enable`、`disable`、`list` 只操作围栏内的托管条目，围栏外内容逐字节保留。
- **方案（profile）**：把不同场景的规则保存为多个方案，`profile use` 切换时重建托管区。
- **单条 TTL**：`disable --for 30m` 临时禁用一条记录，到期自动恢复，也可暂停、续期或提前恢复。
- **规则栈**：多个命名层按优先级合并，支持 `fail`、`highest-priority`、`first-wins`、`last-wins` 冲突策略，`stack explain` 查看某个域名的候选链。
- **网络感知切换**：`network map` 把 Wi-Fi SSID 映射到规则层，`network auto --apply` 在接入该网络时切换；Windows 不支持 SSID 识别。
- **备份与快照**：每次写入前自动备份，`restore` 可恢复最近或指定备份；`git snapshot` / `rollback` 管理数据目录历史。
- **DNS 诊断**：`doctor` 对比规则、系统 DNS 与实际解析，帮助定位缓存或上游问题。
- **远程订阅**：`remote add/update` 拉取远程 hosts 规则，支持 ETag 缓存、超时与大小上限，失败时保留上次成功内容。
- **写入后验证**：写操作加 `--verify` 会抽查托管域名解析，失败自动回滚并记录审计。
- **导出与审计**：`export --format json|yaml` 导出可迁移快照；`audit list` 查看写入、验证与回滚记录。
- **Shell 补全**：`completion bash|zsh|fish` 生成补全脚本。

## 参与贡献

1. 在项目主页点击 **Fork**，把仓库复制到你自己的账号。
2. clone 你的 fork，并按需添加上游仓库：

   ```bash
   git clone <your-fork-url>
   cd hostscli
   git remote add upstream <upstream-url>
   ```

3. 安装依赖并构建：

   ```bash
   corepack enable
   pnpm install
   pnpm build
   ```

4. 修改后跑单一验证入口，它会依次执行 build、typecheck、lint、test、格式检查、冒烟与全部命令的端到端验证：

   ```bash
   pnpm verify
   ```

   依赖已装好时可以 `pnpm verify:fast`；只排查某一步用 `node scripts/verify.mjs --only=<step>`。

5. 从你的分支向主仓库提交 PR。提交信息使用 Conventional Commits（如 `feat: 支持按网络切换规则层`、`fix: 修复围栏外内容被改写`），说明"为什么"，不必复述 diff。

目录结构：

- `packages/core`：hosts 解析/渲染、规则合并、方案与状态存储、原子写、备份、诊断、远程订阅等核心逻辑，不依赖 CLI。
- `packages/cli`：Commander 命令定义、输出格式与入口；命令按需加载，通过 `@hostscli/core` 的子路径导入所需能力。

对外可见的变更（新命令、参数、行为调整）用 Changesets 记录：`pnpm changeset`，按提示选择包与变更类型。
