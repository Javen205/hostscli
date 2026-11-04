# CLI 参考

> 本文件是 `hostscli` 的命令契约；参数以 `node packages/cli/dist/index.js --help` 实测为准。
> 架构与不变量见 [architecture.md](./architecture.md)；平台差异见 [platform-matrix.md](./platform-matrix.md)。

## 1. 安装与调用

安装或构建后，有三种等价调用方式：

```bash
# 1) 直接调用构建产物
node packages/cli/dist/index.js --version

# 2) workspace 内链接（pnpm link --global 后）
pnpm --filter hostscli exec hostscli --version

# 3) 通过 npm 全局安装后
hostscli --version
```

下文示例统一用 `HCLI` 代指调用入口：

```bash
HCLI="node packages/cli/dist/index.js"
$HCLI --version
```

## 2. 全局约定

### 2.1 环境变量

| 变量 | 作用 |
| --- | --- |
| `HOSSCLI_HOME` | 覆盖数据目录，默认 `~/.hostscli`；优先级低于 `--data-dir` |
| `NO_COLOR` / 终端非 TTY | 自动关闭颜色（`picocolors` 行为） |
| `SystemRoot` / `windir`（仅 Windows） | 用于解析 `C:\Windows\System32\drivers\etc\hosts` |

### 2.2 公共选项

除 `--version` / `--help` / `completion` / `dns flush` 等少数命令外，大多数命令支持：

| 选项 | 说明 |
| --- | --- |
| `--file <path>` | 指定 hosts 文件，默认按平台解析（`/etc/hosts` 或 Windows 系统路径）。**测试时务必显式传入临时文件** |
| `--data-dir <path>` | 指定数据目录，默认 `~/.hostscli` 或 `HOSSCLI_HOME` |
| `--skip-dns-flush` | 写回后不刷新 DNS 缓存 |
| `--json` | 机器可读输出（字段是对外契约，改名属于破坏性变更） |
| `--dry-run` | 只生成 unified diff，不写 hosts、不写方案 / 状态（仅写操作命令） |
| `--layer <id>` | 指定规则层；多启用层时必须 |
| `--on-conflict <strategy>` | 同优先级冲突：`fail`（默认）/ `highest-priority` / `first-wins` / `last-wins` |
| `--verify` | 写入后抽查托管域名解析，失败自动回滚并写 audit |

### 2.3 输出格式

- 默认表格：`cli-table3` 渲染，适合人工查看；警告写 stderr。
- `--json`：stdout 输出 2 空格缩进的 JSON，警告仍在 stderr。
- 写操作 JSON 的公共字段：

```json
{
  "changed": true,
  "backupPath": "/path/to/backups/hosts-2026-11-03T...",
  "planHash": "sha256:...",
  "affected": [{ "ip": "10.0.0.12", "hostnames": ["api.example.com"], "enabled": true }],
  "diff": "--- ...",
  "dnsFlush": { "ok": true, "attempts": [] },
  "warnings": []
}
```

`--dry-run` 时 `changed` 表示"若执行是否会变化"，`planHash` 为 `null`，`backupPath` 为 `null`。

## 3. 命令总览

| 命令 | 用途 |
| --- | --- |
| `list` | 列出托管区 + 非托管区条目 |
| `add` / `remove` / `enable` / `disable` | 托管条目 CRUD、TTL 禁用 |
| `init` / `apply` | 初始化数据目录与围栏 / 按生效规则重建 |
| `backup` / `restore` | 手动备份与恢复 |
| `profile` | 方案（规则集）管理 |
| `ttl` | 单条记录定时禁用 |
| `stack` | 多层规则栈与冲突裁决 |
| `network` | Wi-Fi SSID → 规则层自动切换（macOS / Linux） |
| `doctor` | 三路解析对比与诊断 |
| `remote` | 远程 hosts 订阅 |
| `dns` | DNS 缓存刷新 |
| `config` | 配置读写 |
| `git` | 数据目录快照 |
| `export` | 导出 config / state / profiles |
| `audit` | 写入审计：哈希链校验、查询、导出 |
| `undo` | 撤销最近 N 次成功写入（hosts + state + 相关方案） |
| `run` | 命令存活期间临时生效的 hosts 条目 |
| `completion` | shell 补全 |

## 4. 命令详解

### 4.1 `list`

```bash
$HCLI list [--file <path>] [--data-dir <path>] [--json] [--on-conflict <strategy>] [--skip-dns-flush]
```

输出托管 / 非托管条目、状态（`enabled` / `disabled` / `ttl_disabled`）与汇总。正常路径只读；若存在已到期 TTL，会经 `prepare → reconcileTtls` 惰性结算并写回 hosts、备份与 state（并非严格只读）。

### 4.2 `add`

```bash
$HCLI add <ip> <hostname...> [--layer <id>] [--comment <text>] [--verify]
         [--dry-run] [--json] [--file <path>] [--data-dir <path>] [--skip-dns-flush]
```

多个 hostname 每个写一行；写入需要围栏，围栏不存在时会追加。`--dry-run` 只输出 diff。

### 4.3 `remove` / `enable` / `disable`

```bash
$HCLI remove <hostname...> [--layer <id>] [--verify] [--dry-run]
$HCLI enable <hostname...> [--layer <id>] [--verify] [--dry-run]
$HCLI disable <hostname...> [--for <duration>] [--reason <text>] [--yes]
          [--layer <id>] [--verify] [--dry-run]
```

- `disable --for` 写入 TTL；一次只接受一个主机名，传入多个会整体报 `INVALID_INPUT`，不会部分执行。
- 到期由 `ttl tick`（cron）或下一次命令（包括 `list`）惰性结算。
- 超过 `defaults.ttlWarnThreshold`（默认 `7d`）会要求确认；非 TTY 环境需显式 `--yes`。

### 4.4 `init` / `apply`

```bash
$HCLI init [--verify] [--dry-run] [--json]
$HCLI apply [--verify] [--dry-run] [--json] [--on-conflict <strategy>]
```

`init` 建数据目录与空托管区块（幂等）；`apply` 按当前 `activeLayers` 重建托管区。两者都支持 `--verify`。

### 4.5 `backup` / `restore`

```bash
$HCLI backup [--list] [--keep <n>] [--json]
$HCLI restore [--from <file>] [--keep <n>] [--yes] [--json]
```

- `backup --list` 列出备份（新→旧）；`--keep` 覆盖 `defaults.backupKeep`。
- `restore` 默认取最近备份；恢复后 `state.lastRender` 被清空，并提示后续 `apply`。
- 恢复前后都会做回读校验；失败尝试回滚。

### 4.6 `profile`

```bash
$HCLI profile list [--json]
$HCLI profile show <id> [--json]
$HCLI profile create <id> [--name <name>] [--priority <n>] [--from-current] [--json]
$HCLI profile use <id> [--dry-run] [--on-conflict <strategy>] [--json]
$HCLI profile save <id> [--prune] [--json]   # 把当前托管区存回方案；默认保留被禁用 / 被 TTL 隐藏的条目
$HCLI profile update <id> [--name <name>] [--priority <n>] [--json]
$HCLI profile remove <id> [--yes] [--json]
```

生效中的方案不能删除；`use` 只保留目标方案为 active layer。

### 4.7 `ttl`

```bash
$HCLI ttl list [--within <duration>] [--json]
$HCLI ttl due [--within <duration>] [--json]      # 默认 1d
$HCLI ttl pause <hostname> [--layer <id>]
$HCLI ttl resume <hostname> [--layer <id>]
$HCLI ttl extend <hostname> --for <duration> [--layer <id>]
$HCLI ttl restore|resolve <hostname> [--layer <id>] [--dry-run]
$HCLI ttl cancel <hostname> [--layer <id>] [--dry-run]
$HCLI ttl tick [--json]
```

时长格式：`30m`、`2h`、`3d`、`1h30m`；最小 1 分钟，不支持小数。

### 4.8 `stack`

```bash
$HCLI stack layer list [--json]
$HCLI stack layer add <id> --file <path> [--name <name>] [--priority <n>] [--force] [--no-enable]
$HCLI stack layer enable <id>
$HCLI stack layer disable <id>
$HCLI stack apply [--apply] [--dry-run] [--verify] [--on-conflict <strategy>]
$HCLI stack explain <hostname> [--on-conflict <strategy>] [--json]
```

`stack apply` 默认只预览 diff，`--apply` 才落盘。`explain` 输出候选链、被覆盖项与最终结果。

### 4.9 `network`

```bash
$HCLI network status [--json]
$HCLI network map <ssid> --layers <id1,id2> [--name <name>]
$HCLI network unmap <ssid>
$HCLI network auto [--apply] [--verify] [--json]
```

- `auto` 默认只预览，`--apply` 才切换并写 hosts。
- Windows 明确不支持 SSID 识别（返回 `unsupported`，不写配置）。

### 4.10 `doctor`

```bash
$HCLI doctor [hostname...] [--all] [--concurrency <n>] [--timeout <ms>] [--json]
```

只读：对比托管规则、系统 DNS 服务器、`getaddrinfo` 实际解析。`--all` 诊断托管区全部域名。

### 4.11 `remote`

```bash
$HCLI remote add <id> --url <url> [--profile <id>] [--name <name>] [--priority <n>] [--activate] [--disabled]
$HCLI remote list [--json]
$HCLI remote remove <id>
$HCLI remote update [id] [--force] [--timeout <ms>] [--max-bytes <n>] [--json]
```

只允许 http/https；默认 15s 超时、1 MB 上限；ETag/Last-Modified 命中 304 不重复写；失败保留上次缓存。

### 4.12 `dns flush`

```bash
$HCLI dns flush [--json]
```

按平台尝试：macOS `dscacheutil` + `killall mDNSResponder`；Linux `resolvectl` → `systemd-resolve` → `nscd`；Windows `ipconfig /flushdns`。失败不抛异常，返回 `ok: false` 并给出警告。

### 4.13 `config`

```bash
$HCLI config show [--json]
$HCLI config set <key> <value>
$HCLI config keys [--json]
```

可修改键（`configKeys()` 实测）：

```text
defaults.backupKeep            defaults.dnsFlush              defaults.ttlWarnThreshold
defaults.verifyAfterApply      defaults.verifyMaxHostnames    defaults.verifyTimeoutMs
defaults.auditKeep             defaults.historyKeep           logging.enabled
logging.keep                   hostsPath                      profilesDir
remote.maxBytes                remote.timeoutMs               output.color
output.format                  ttl.tickInterval               ttl.timerMode
```

`defaults.auditKeep`（默认 1000，0 表示不轮转）控制 `audit.log` 保留条数；`defaults.historyKeep`（默认 30）控制 undo 历史保留次数。轮转会从最旧记录开始删除，链头相应前移，`audit verify` 会如实报告当前链覆盖范围。

`logging.enabled`（默认 `true`）与 `logging.keep`（默认 500）控制普通运行日志 `dataDir/logs/run.jsonl`：append-only JSONL、0600、按行数轮转；只记录命令、参数、事件与结果，不写规则正文，也不进入审计哈希链。`logging.enabled=false` 时不再追加（已关闭时执行的命令自身也不会留下运行日志）。

布尔值只接受 `true/false`；数字只接受非负整数；时长键会先按 TTL 语法校验。

### 4.14 `git`

```bash
$HCLI git init
$HCLI git status
$HCLI git snapshot [-m <text>]
$HCLI git log [--limit <n>]
$HCLI git diff [--rev <hash>]
$HCLI git rollback <rev> [--no-rebuild]
```

仓库位于数据目录内，不触碰系统 hosts。`rollback` 默认重建 hosts；`--no-rebuild` 只恢复数据目录。回滚前若有未快照变更，会先自动提交保护快照。

### 4.15 `export` / `completion`

```bash
$HCLI export [--format json|yaml] [--out <file>]
$HCLI completion bash|zsh|fish
```

`export` 不包含 `audit.log`、`history/`、`cache/`、`backups/`。

### 4.16 `audit`

```bash
$HCLI audit list [--limit <n>] [--since <time>] [--until <time>]
                [--command <name>] [--result ok|failed] [--json]
$HCLI audit show <id> [--json]
$HCLI audit verify [--json]
$HCLI audit export [--format json|ndjson]
```

- 所有成功写入都会记录 `write-ok`，字段包含时间、命令与参数、操作者（uid 与可得的用户名）、目标 hostsPath、变更前后内容哈希、条目级摘要（新增 / 删除 / 禁用 / 恢复）；验证与回滚事件同样入账。
- 每条新记录带 `id` / `seq` / `prevHash` / `recordHash`，`audit verify` 据此发现内容被改、记录被删或尾部被截断。旧格式记录仍可读取，但标记为"不在链上"，不做完整性保证。
- `--since` / `--until` 接受 ISO 8601 或任何 `Date.parse` 可识别的时间；`since > until` 报 `INVALID_INPUT`。
- `audit export` 只写 stdout，不落盘；`ndjson` 每行一条，便于管道处理。
- `--keep` 轮转由 `defaults.auditKeep` 控制，文件权限 0600、落盘原子。
- 审计写入失败不会阻断主操作：该次操作会被记入 `audit-unaudited.jsonl`，`audit verify` 与 `audit list` 会显示"有操作未被审计"。

### 4.17 `undo`

```bash
$HCLI undo [--steps <n>] [--dry-run] [--json] [--verify]
          [--file <path>] [--data-dir <path>] [--skip-dns-flush]
```

- 撤销最近 `--steps`（1–100，默认 1）次成功写入，按从新到旧逆序回放，一次性恢复 hosts 托管区、state 与相关方案文件；三处使用写入前的原始字节快照，不是重新渲染。
- 每次撤销本身也会产生一条可再撤销的历史记录，因此连续执行 `undo` 可在两个状态间来回切换。
- 若当前 hosts / state / 方案已被其他操作改写，撤销会以 `CONFLICT` 拒绝，不覆盖他人修改；`--dry-run` 只输出将发生的 diff。
- 没有可撤销记录时返回 `ENTRY_NOT_FOUND`；`--steps` 超过可用记录数返回 `INVALID_INPUT`。
- 复用 `dataDir/history/<id>/` 快照与 `dataDir/history/journal.jsonl` 日志，保留次数由 `defaults.historyKeep` 控制（默认 30）。

### 4.18 `run`

```bash
$HCLI run --host <hostname> --ip <addr> [--] <command...>
$HCLI run list [--json]
$HCLI run gc [--dry-run] [--json]
```

- 命令存活期间，临时条目以最高优先级生效；子进程正常退出、异常退出或被 SIGINT / SIGTERM / SIGHUP 中止后自动移除条目并清理会话方案。
- 命令不存在或启动失败时不会写入临时条目。
- 会话以 `session-<hex>` 命名并写入 `state.sessions` 租约，父进程被强杀时可执行 `run list` 查看、`run gc` 回收。
- 多个 `run` 可并存；清理只影响对应会话，不会覆盖其他命令在此期间对托管区的改写。
- `run` 与 `undo` / 普通写入共用同一把工作区锁与 `--verify` 语义；`run list` / `run gc` 也需要传入与启动时相同的 `--file` / `--data-dir`。

### 4.19 写操作留痕对账表

口径：**审计**指进入 `audit.log` 哈希链（或明确标记未审计）；**undo** 指可在 `undo` 中按原始字节回放；**运行日志**指 `dataDir/logs/run.jsonl`。只读命令三项皆无。

| 命令 / 子命令 | 写磁盘 | 审计 | undo | 运行日志 |
| --- | --- | --- | --- | --- |
| `list` | 否 | 否 | 否 | 否 |
| `add` / `remove` / `enable` / `disable` | 是（hosts/state） | 是 | 是 | 是 |
| `init` / `apply` | 是（hosts/state） | 是 | 是（有变更时） | 是 |
| `backup` | 是（backups/） | 是 | 否（备份是恢复原语） | 是 |
| `restore` | 是（hosts/state） | 是 | 否（用备份反向恢复） | 是 |
| `profile list` / `show` | 否 | 否 | 否 | 否 |
| `profile create` | 是（profiles/） | 是 | 是 | 是 |
| `profile remove` | 是（profiles/） | 是 | 是 | 是 |
| `profile update` | 是（profiles/；激活时连带 hosts） | 是 | 否（纯元数据；连带 hosts 变化仍可 undo） | 是 |
| `profile use` / `save` | 是（hosts/profiles/state） | 是 | 是 | 是 |
| `ttl list` / `due` | 否 | 否 | 否 | 否 |
| `ttl pause` / `resume` / `extend` / `tick` | 是（hosts/state，仅变更时） | 是 | 是 | 是 |
| `stack layer list` / `stack explain` | 否 | 否 | 否 | 否 |
| `stack layer add` | 是（profiles/state） | 是 | 否（层导入不是 hosts 写入；可用 `profile remove` 反向） | 是 |
| `stack layer enable` / `disable` | 是（state） | 是 | 否 | 是 |
| `stack apply` | 是（hosts/state） | 是 | 是 | 是 |
| `doctor` | 否 | 否 | 否 | 否 |
| `remote list` | 否 | 否 | 否 | 否 |
| `remote add` / `remove` / `update` | 是（config；update 还写 profiles/cache） | 是 | 否（订阅登记用 add/remove 反向调整） | 是 |
| `dns flush` | 否（只清系统缓存） | 否 | 否 | 否（不绑定数据目录） |
| `config show` / `keys` | 否 | 否 | 否 | 否 |
| `config set` | 是（config.json） | 是 | 否 | 是 |
| `network status` | 否 | 否 | 否 | 否 |
| `network map` / `unmap` | 是（config.json） | 是 | 否 | 是 |
| `network auto`（dry-run） | 否 | 否 | 否 | 否 |
| `network auto --apply` | 是（hosts/state） | 是 | 是 | 是 |
| `git status` / `log` / `diff` | 否 | 否 | 否 | 否 |
| `git init` / `snapshot` | 是（数据目录内 `.git`） | 是 | 否（git 历史即回滚点） | 是 |
| `git rollback` | 是（数据目录；默认重建 hosts） | 是 | 部分（hosts 重建可 undo；仓库回滚不可） | 是 |
| `export` | 是（用户 `--out` 指定文件 + 运行日志） | 否（见下） | 否 | 是（event=export） |
| `audit list` / `show` / `verify` | 否 | 否 | 否 | 否 |
| `audit export` | 否（只写 stdout） | 否 | 否 | 否 |
| `undo` | 是（hosts/state/profiles） | 是（undo-ok） | 是（可再撤销） | 是 |
| `run` | 是（hosts/state/profiles） | 是 | 是 | 是 |
| `run list` | 否 | 否 | 否 | 否 |
| `run gc` | 是（hosts/state/profiles） | 是 | 是 | 是 |
| `completion` | 否 | 否 | 否 | 否 |

口径说明：

- `export` 写入的是**用户指定路径**的文件，可能位于数据目录之外，内容只是数据目录的只读快照；它不改受管状态（hosts/state/profiles），唯一的数据目录副作用是运行日志。把它塞进审计链会让"审计 = 对托管状态的写入"这一语义失真。因此只记运行日志（`event=export`），不入审计链。`audit export` 仅写 stdout，同样不审计。
- `dns flush` 是系统缓存副作用，不读写数据目录，没有可审计的状态变更；失败会以 `NETWORK` 错误返回。
- 审计写入失败沿用统一策略：主操作成功 + `audit-unaudited.jsonl` 标记 + warning，不阻断；运行日志写失败直接忽略。

## 5. 退出码

退出码是对外契约，脚本可依赖：

| 退出码 | 含义 | 典型错误码 |
| --- | --- | --- |
| 0 | 成功（含 `--dry-run` 无变化） | — |
| 1 | 业务失败 | `ENTRY_NOT_FOUND`、`EXTERNAL_ENTRY`、`LOCKED` |
| 2 | 用法 / 参数错误 | `INVALID_INPUT`、`DUPLICATE_ENTRY`、`UNSUPPORTED_PLATFORM`、Commander 用法错误 |
| 3 | 规则冲突 | `CONFLICT` |
| 4 | 权限不足 | `PERMISSION` |
| 5 | 写入后校验 / 解析验证失败 | `VERIFICATION` |
| 6 | 网络 / DNS 错误 | `NETWORK` |
| 7 | 文件格式 / 编码 / 存储损坏 | `HOSTS_FORMAT`、`UNSUPPORTED_ENCODING`、`STORAGE_CORRUPT` |
| 8 | 用户取消 | `CANCELLED` |

## 6. 常见错误与处理

| 现象 / 错误码 | 原因 | 处理 |
| --- | --- | --- |
| `PERMISSION`（4） | 对系统 hosts 无写权限 | 用 `sudo hostscli ...`；Windows 以管理员终端运行 |
| `HOSTS_FORMAT`（7）：围栏必须恰好各出现一次 | 起止围栏重复 / 缺失 / 顺序颠倒 | 用 `--dry-run` 查看；修正围栏或先 `restore` |
| `INVALID_INPUT`（2）：同一规则集内 x 同时映射到 A 与 B | 方案内同层重复主机名映射 | 编辑 `profiles/<id>.json` 或重新 `profile create --from-current` |
| `CONFLICT`（3） | 同优先级多层映射同一域名到不同 IP | 调整 `priority`，或 `--on-conflict highest-priority/first-wins/last-wins` |
| `ENTRY_NOT_FOUND`（1） | 主机名不在托管区 / 方案不存在 | `list` 确认；`profile list` 查看方案 ID |
| `EXTERNAL_ENTRY`（1） | 目标位于围栏外，拒绝修改 | 先把它加入托管区（`add`），不要手改围栏外内容 |
| `VERIFICATION`（5） | 写入后 `getaddrinfo` 结果与规则不符 | 检查 DNS 缓存 / 上游；命令已自动回滚，可 `doctor` 定位 |
| `LOCKED`（1） | 另一个 hostscli 进程持锁 | 等待后重试；陈旧锁会按 PID + 时间自动清理 |
| `NETWORK`（6） | 远程订阅超时 / HTTP 失败 | 检查 URL；失败不会覆盖上次成功缓存 |
| `UNSUPPORTED_ENCODING`（7） | 非 UTF-8 hosts 文件 | 转成 UTF-8（保留 BOM 也可）；不要用二进制编辑器 |
| `CANCELLED`（8） | 确认提示被拒绝或非 TTY | 需要非交互执行时加 `--yes` |

## 7. 可直接复制运行的示例

以下示例只操作临时文件，不会触碰系统 hosts：

```bash
# 0) 准备沙箱
mkdir -p /tmp/hostscli-demo/data
printf '127.0.0.1 localhost\n\n# >>> hostscli managed (do not edit inside) >>>\n# <<< hostscli managed <<<\n' \
  > /tmp/hostscli-demo/hosts

# 1) 查看
node packages/cli/dist/index.js list \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data --skip-dns-flush

# 2) 新增并预览
node packages/cli/dist/index.js add 10.0.0.12 api.example.com \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data \
  --skip-dns-flush --dry-run

# 3) 真正写入
node packages/cli/dist/index.js add 10.0.0.12 api.example.com \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data --skip-dns-flush

# 4) 30 分钟后自动恢复
node packages/cli/dist/index.js disable api.example.com --for 30m \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data --skip-dns-flush

# 5) TTL 列表与结算
node packages/cli/dist/index.js ttl list --data-dir /tmp/hostscli-demo/data
node packages/cli/dist/index.js ttl tick --data-dir /tmp/hostscli-demo/data

# 6) 方案
node packages/cli/dist/index.js profile create office --from-current \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data
node packages/cli/dist/index.js profile use office \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data --skip-dns-flush

# 7) 备份与恢复
node packages/cli/dist/index.js backup \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data
node packages/cli/dist/index.js restore \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data --yes --skip-dns-flush

# 8) 机器可读输出
node packages/cli/dist/index.js list --json \
  --file /tmp/hostscli-demo/hosts --data-dir /tmp/hostscli-demo/data
```

需要真实生效时，去掉 `--file` 并使用 `sudo`；在此之前建议先 `--dry-run` 确认 diff。
