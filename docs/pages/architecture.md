# 架构说明

> 本文件描述当前代码的实际结构，不是未来规划。
> 命令契约见 [cli-reference.md](./cli-reference.md)；平台差异见 [platform-matrix.md](./platform-matrix.md)；选型与仓库结构见 [tech-stack.md](./tech-stack.md)。

## 1. 总体分层

```text
┌──────────────────────────────────────────────────────────────┐
│ packages/cli                                                 │
│  index.ts           入口：解析 argv，只加载命中的命令模块       │
│  command-manifest.ts 命令清单（名称/描述/动态加载器）           │
│  commands/*.ts       Commander 参数定义 + 输出格式             │
│  output/table.ts     表格输出（cli-table3、颜色、倒计时）       │
└───────────────────────────┬──────────────────────────────────┘
                            │ 仅经 @hostscli/core/<子路径>
┌───────────────────────────▼──────────────────────────────────┐
│ packages/core                                                │
│  engine/*           用例编排：CRUD / 方案 / 栈 / TTL / 备份 /   │
│                     网络 / git / 导出 / 审计 / 撤销 / run /   │
│                     验证                                          │
│  operations.ts      对 CLI 暴露的高层操作汇总（根入口）         │
│  hosts/*            无损解析、模型、渲染（纯函数，无 I/O）      │
│  stack/merge.ts     规则合并、优先级、冲突裁决                  │
│  profiles/store.ts  方案 JSON 的读写与校验                      │
│  storage/*          config/state/路径/JSON I/O                 │
│  system/*           平台路径、权限、原子写、锁、DNS 刷新         │
│  diagnostics/*      doctor 的三路解析对比                       │
│  remote/service.ts  远程订阅下载、ETag 缓存                     │
│  network/detect.ts  Wi-Fi SSID 识别（只读）                     │
└──────────────────────────────────────────────────────────────┘
```

依赖方向严格单向：`cli → core`，`core` 不 import `cli`。`core` 内部：

```text
engine ──► hosts / stack / profiles / storage / system / diagnostics / remote
hosts  ──► 仅 node:net（isIP）、errors          （不碰文件系统）
system ──► 仅 node:fs / node:path / node:child_process
```

`hosts/*` 是纯函数层：解析与渲染只接收 / 返回 Buffer 与内存模型，便于单测和复用。

## 2. 核心数据流

所有写操作都走同一条链路（`engine/plan.ts` → `engine/commit.ts`）：

```text
字节流 readFile
   │
   ▼
parseHosts  ──► HostsDocument
   │            rawLines: 每行 {text, eol}，围栏外内容原样保留
   │            entries: {ip, hostnames, enabled, comment, source, layerId, id}
   │            managedRange / eol / bom
   ▼
resolveActiveLayers  ──► Profile[]（state.activeLayers；无状态时把现有托管区导入 default）
   ▼
buildLayerInputs     ──► 跳过持久禁用与 TTL 禁用条目
   ▼
mergeLayers          ──► 优先级合并 + 冲突策略（fail / highest-priority / first-wins / last-wins）
   ▼
buildRenderPlan      ──► renderHosts(document, {managedEntries})
   │                     只替换围栏内行；围栏外逐字节复制（含 EOL/BOM）
   │                     生成 diff、changed、planHash(sha256)
   ▼
commitPlan
   1. 权限预检 canWriteDirectly
   2. 备份当前 hosts（保留 backupKeep 份）
   3. atomicWriteFile：同目录临时文件 → fsync → rename → 目录 fsync
   4. 回读字节比对，不一致则回滚并写 audit
   5. 刷新 DNS（可选，配置 dnsFlush）
   6. --verify：getaddrinfo 抽查，失败回滚 hosts + 再刷 DNS + 写 audit
   7. 持久化 profile / state；任何失败回滚 hosts
   8. 写 audit（write-ok / verify-ok / verify-rollback / write-rollback）
   9. 写历史快照（engine/history.ts）供 undo 回放
```

写入成功记录 `write-ok` 只在"写入 + 回读 + 可选验证 + 持久化"全部成功之后追加，避免把已回滚的操作标成成功。审计或历史写入失败只产生 warning 与未审计标记，不阻断主操作。

正常只读路径（`doctor`、`stack explain`）不进入 `commitPlan`，不写任何文件。`list` 正常读取也不写；但若存在已到期 TTL，会经 `prepare → reconcileTtls` 惰性结算并写回 hosts、备份与 state，因此不能声称严格只读。

`--dry-run` 与真实写入共享同一个 `RenderPlan`：`--dry-run` 只打印 diff，不执行 commit。

## 3. 关键不变量

改动任何写路径时必须保持：

1. **围栏外逐字节不变**：解析用 `RawLine` 记录每行原始文本与行尾；渲染只重建围栏内行，非围栏行直接拼接。禁止用"重新生成整份文件"的写法。
2. **行尾与 BOM 保留**：`document.eol` 与 `document.bom` 来自原文件；新建文件才使用平台默认（Windows `\r\n`，其余 `\n`）。
3. **权限位保留**：`atomicWriteFile` 先 `stat` 目标取 `mode & 0o777`，显式 `chmod` 临时文件再 rename；配置 / 状态 / 审计仍强制 `0600`。
4. **原子替换**：同目录临时文件 + fsync + rename（+ 目录 fsync）；失败清理临时文件。Windows 对 `EBUSY/EPERM/EACCES` 重试 3 次。
5. **回滚语义**：写后校验失败、验证失败、profile / state 持久化失败，都回滚到写入前字节；但若磁盘内容已被其他进程改写，则跳过回滚并 warning/audit，避免覆盖他人改动。
6. **围栏唯一性**：起止围栏各恰好一次，否则 `HOSTS_FORMAT`。
7. **撤销可复现**：`dataDir/history/<id>/` 保存写入前的 hosts / state / 相关 profile 原始字节与 manifest，undo 按记录**逆序**逐条回放各自的"写入前"快照；回放前校验每条快照的 `sha256` 与记录 `before` 指纹一致、`record.hostsPath` 与本次目标一致，不一致以 `CONFLICT` 拒绝且不部分写入。回放 state 时丢弃 pid 已死的 run 租约并清理会话方案，已到期 TTL 直接丢弃。undo 自身也写入一条可再撤销的历史记录。
8. **审计是一致性记录，不是防篡改凭据**：`audit.log` 为 append-only JSONL，保留单调递增的 `id` 与时间戳；不维护哈希链或 sidecar，因为能写 `dataDir` 的同一用户同样能改写审计。`audit verify` 只检查文件可读、每行可解析、时间与数字 ID 单调、轮转后自洽。旧版本带链字段的记录仍可读，链字段被忽略。
9. **run 租约**：`run` 以最高优先级创建临时方案层与 `state.sessions` 租约，子进程存活期间不持锁；退出或 `run gc` 时在同一写路径批量清理（多孤儿只重建一次 hosts、只写一条汇总审计）。存活判断仅依赖 pid，存在 pid 复用导致漏回收的风险，`run gc --force` 提供显式兜底。
10. **非 hosts 写入同样留痕**：`profile create/remove` 走原始字节快照（hosts + state + 目标方案）并进入 undo；`profile update` 等纯元数据变更只入审计，不进 undo 栈。config / network / stack 层开关 / remote / git / backup / restore 的落盘都写 `write-ok` 审计；`export` 只写用户指定文件，按"不改变受管状态"的口径只记运行日志。
11. **审计与运行日志分离**：审计记录写操作事实（结构化 JSONL、0600、append-only、按 `auditKeep` 轮转），不承诺防篡改；运行日志 `logs/run.jsonl` 只用于排障，append-only、0600、按 `logging.keep` 轮转，任何失败都不得影响主流程。

这些不变量由 `packages/core` 的解析、引擎、操作与 CLI 集成测试覆盖，包括权限位、原子写、并发写入、TTL 结算与回滚路径。

## 4. CLI 启动结构

- `command-manifest.ts` 保存全部一级命令的名称、描述与 `register` 动态加载器；入口只用 `findRequestedCommand` 找到被调用的命令并 `await import()` 对应模块。
- `--version`、`--help`、未知命令只注册占位命令（名称 + 描述），不加载 core、`cli-table3`、`yaml`。
- `packages/core` 通过 `exports` 暴露子路径（`/crud`、`/profiles`、`/stack`、…）。每条 CLI 命令只导入自己需要的域，避免 `list` 顺带加载 `node:dns`、git、远程订阅等模块。
- 需要新增一级命令时：追加清单条目 + 新建 `commands/<name>.ts`；`command-manifest.test.ts` 会断言清单与真实注册的命令名称 / 描述一致。

代价：命令模块被拆成多个构建 chunk；入口不存在的命令不会出现在帮助里（占位命令只保留名称与描述，二级子命令帮助要进入对应模块后才可见）。这是有意的取舍。

## 5. 扩展点清单

| 想扩展的能力 | 改哪里 | 注意 |
| --- | --- | --- |
| 新增一级命令 | `packages/cli/src/command-manifest.ts` + `packages/cli/src/commands/<name>.ts` | 描述要和清单一致；有写操作时复用 `common.ts` 的 workspace 选项 |
| 新增二级子命令 | 对应 `commands/<name>.ts` 的注册函数 | 仍然只在命中一级命令后才加载 |
| 新增配置项 | `packages/core/src/storage/config.ts` 的 schema + `configKeys/setConfigValue` | 同步 [cli-reference.md](./cli-reference.md)；`passthrough` 允许旧版本读新字段，但 `config set` 只接受白名单键；移除键时在 `REMOVED_CONFIG_KEYS` 里登记并给 warning |
| 新增规则排除来源（维护窗口等） | `engine/layers.ts` 的 `buildLayerInputs` | 返回 `disabled` 供输出解释；不要把排除写进 hosts 文件 |
| 新增冲突策略 | `stack/merge.ts` 的 `ConflictStrategy` + `mergeLayers` | 同步 CLI `--on-conflict` 选项与文档 |
| 新增输出格式 | `packages/cli/src/output/table.ts` + 各命令的 `printJson` / `printMutation` | `--json` 是脚本契约，字段改名属于破坏性变更 |
| 新平台适配 | `system/platform.ts` + 新建 `system/<platform>.ts` | 需要 hosts 路径、默认 EOL、权限提示、DNS 刷新命令；同步平台矩阵 |
| 新 DNS 诊断来源 | `diagnostics/dns-servers.ts` | 全部外部命令通过注入 runner，便于测试 |
| 新远程订阅协议 | `remote/service.ts` | 保持大小上限、超时、ETag/Last-Modified、失败保留上次缓存 |
| 新 hosts 语法 / 指令 | `hosts/parser.ts` + `hosts/render.ts` | 必须保持无损往返；先补夹具测试再改 |
| 新增持久化文件 | `storage/paths.ts` + `storage/json.ts` | 数据文件默认 `0600`；新增目录注意 `mkdir` mode |
| 新增非 hosts 写操作 | `engine/aux-write.ts` 的 `auditAuxWrite`（必要时再 `recordOperation`） | 写成功后补审计；审计失败只标记未审计，不回滚主操作 |

## 6. 数据目录布局

默认 `~/.hostscli`（可用 `HOSSCLI_HOME` 或 `--data-dir` 覆盖）：

```text
config.json          配置（0600）
state.json           运行态：activeLayers / initialized / ttl / lastRender / sessions（0600）
profiles/<id>.json   方案（规则集），紧凑 JSON
history/             写入历史：journal.jsonl + <id>/ 原始字节快照（0700/0600）
backups/             hosts 备份，按 backupKeep 清理
cache/remote/        远程订阅内容与 ETag
audit.log            JSONL 审计（结构化写入记录，0600）
audit-unaudited.jsonl 审计写入失败的补记标记（0600）
logs/run.jsonl       普通运行日志（JSONL，0600，按 logging.keep 轮转）
.git/                可选，git 快照仓库（不包含 cache/backups/history/logs/审计）
```

跨进程锁放在系统临时目录 `hostscli-locks/`，避免系统 hosts 不可写时无法加锁。工作区锁按排序同时获取 `lockPathFor(hostsPath)` 与 `lockPathForDataDir(dataDir)`，覆盖"读 - 改 - 写 - 校验 - 持久化"全过程；配置文件在锁外加载，避免锁内再取锁。

锁按 hosts 路径串行化写入，但**不支持多个 dataDir 共用同一份 hosts**：串行不等于合并，后写者会按自己的 profiles/state 整段重建 hosts，先写者条目消失。需要多套规则时请在同一个 dataDir 内用 profile/layer。
