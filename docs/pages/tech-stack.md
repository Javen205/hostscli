# 技术选型与仓库结构

## 1. 结论

| 项 | 选择 |
| --- | --- |
| 语言 / 运行时 | Node.js（`>=20`）+ TypeScript（ESM） |
| 仓库形态 | pnpm workspace monorepo |
| 构建 | tsup（esbuild） |
| CLI 框架 | commander |
| 参数与数据校验 | zod |
| 测试 | vitest |
| Lint / 格式 | eslint + typescript-eslint + prettier |
| 版本与发布 | Changesets；对外只发布 `@javen205/hostscli` 一个包 |

## 2. 为什么是 Node.js + TypeScript

目标用户是本来就安装 Node 的开发者，分发路径为 `npm i -g @javen205/hostscli` / `npx @javen205/hostscli`。在这个前提下，选择 TypeScript 的理由是：

1. **单语言维护**：领域逻辑、CLI 输出与测试都用同一语言，避免为系统工具单独维护一套分发链路。
2. **迭代成本低**：核心复杂度在 hosts 文件的模型、规则合并、TTL 状态机与诊断语义，不在系统调用；这些用 TS 表达与测试更快。
3. **生态完整**：commander、zod、vitest 等工具的行为稳定，测试与构建链路简单。

代价同样明确：

| 代价 | 表现 | 当前应对 |
| --- | --- | --- |
| 依赖 Node 运行时 | 用户机器必须安装 Node（`engines: node >= 20`） | README 明示；npm 作为主要分发方式 |
| 启动耗时 | 模块加载比静态二进制慢 | 命令清单 + 动态导入；`--version` / `--help` 不加载业务模块 |
| 安装体积 | npm 会展开依赖树 | 依赖精简；core 与 zod 内联进 CLI 产物 |
| 单文件分发弱 | 未提供免 Node 的二进制 | 当前版本未提供独立二进制，不作为承诺 |

如果目标是部署到没有 Node 的机器，Go / Rust 的单文件分发更合适。这个结论绑定在"受众是开发者"这一前提上。

## 3. 依赖取舍

| 类别 | 采用 | 说明 |
| --- | --- | --- |
| 构建 | tsup | 多入口打包；CLI 产物内联 core 与 zod |
| 开发期运行 | tsx | 本地直接运行 TypeScript |
| CLI | commander | 一级命令动态注册，二级子命令在命中后加载 |
| 校验 | zod | 配置、状态、方案条目、远程缓存元数据 |
| 终端颜色 | picocolors | 零依赖；`NO_COLOR` 与非 TTY 自动关闭 |
| 表格 | cli-table3 | `list` / `doctor` 等人类可读输出 |
| 序列化 | yaml | `export --format yaml`；JSON 用原生 `node:fs` |
| HTTP | 原生 `fetch` | 远程订阅，无额外 HTTP 依赖 |
| 系统调用 | `node:child_process` / `node:os` | 全部收敛在 `packages/core/src/system` |
| 持久化 | 自实现 JSON 读写 + zod | 不引入 `conf`；便于控制原子写、schemaVersion 与损坏处理 |
| 加密 / 校验 | `node:crypto` | 文件指纹 `planHash` 等 |

未引入的依赖：语法高亮库、终端图表库、spinner 库、Lerna。`--dry-run` 的 diff 由内部实现生成。

## 4. 仓库结构

```text
hostscli/
├── packages/
│   ├── core/                  # 领域逻辑与平台适配，不发布
│   │   └── src/
│   │       ├── hosts/         # 解析、渲染、模型、校验（纯函数）
│   │       ├── engine/        # CRUD、方案、栈、TTL、备份、网络、git、导出、审计
│   │       ├── stack/         # 合并、优先级、冲突裁决
│   │       ├── profiles/      # 方案存储与 schema
│   │       ├── storage/       # config / state / 路径 / JSON I/O
│   │       ├── system/        # 平台路径、权限、原子写、锁、DNS 刷新
│   │       ├── diagnostics/   # doctor 三路解析对比
│   │       ├── remote/        # 远程订阅与 ETag 缓存
│   │       └── network/       # Wi-Fi SSID 识别
│   └── cli/                   # 对外包 hostscli
│       └── src/
│           ├── index.ts       # 入口：解析 argv，按需加载命令
│           ├── command-manifest.ts
│           ├── commands/      # 每个一级命令一个模块
│           ├── output/        # 表格与 JSON 输出
│           └── errors.ts      # 错误码 → 退出码
├── scripts/                   # verify / smoke / e2e / bench
├── docker/                    # Linux 容器验证
├── .github/workflows/ci.yml   # 三平台 CI
└── .changeset/                # 版本与发布配置
```

依赖方向严格单向：`cli → core`，`core` 不反向依赖 `cli`。

## 5. core 的导出与按需加载

`packages/core` 通过 `exports` 暴露子路径（`/crud`、`/profiles`、`/stack`、`/ttl`、`/system`、`/storage` 等）。CLI 的每个一级命令只导入自己需要的域：

- `command-manifest.ts` 保存命令名称、描述与动态加载器。
- 入口只对即将执行的命令执行 `await import()`；`--version`、`--help` 与未知命令只注册占位命令。
- 因此 `list` 不会顺带加载 git、远程订阅、DNS 等模块。

新增一级命令时，需要同时修改 `command-manifest.ts` 与 `commands/<name>.ts`；测试会断言清单与真实注册的命令名称、描述一致。

## 6. 数据存储

- 配置文件、状态文件、备份与审计日志使用文件系统实现，不依赖数据库。
- 配置与状态写入前经 zod 校验；读取失败时拒绝继续并提示修复。
- hosts、config、state、备份统一走原子写：同目录临时文件 → fsync → rename（Windows 对占用错误重试）。
- 配置 / 状态 / 审计文件权限固定 `0600`；hosts 文件保留原有权限位。
- `planHash` 记录应用变更后的文件指纹，用于检测外部改动，避免误覆盖。

## 7. 命名与发布

| 层级 | 名称 | 是否发布 |
| --- | --- | --- |
| npm 包 | `hostscli` | 是 |
| CLI 命令 | `hostscli` | — |
| 内部库 | `@hostscli/core` | 否，构建时内联进 CLI |
| 仓库包目录 | `packages/cli` / `packages/core` | — |

只承诺一个裸名包 `hostscli`，避免 scoped 包的组织名归属风险。`hostsctl` 与既有 Go 工具 `hostctl` 过于接近，已否决。

发布链路使用 Changesets：`changeset` → `version-packages` → `release`（`pnpm -r publish --access public`）。

## 8. 质量与验证

所有检查都有统一入口：

```bash
pnpm install --frozen-lockfile
pnpm verify            # install → build → typecheck → lint → test → format:check → smoke → e2e
pnpm verify:fast       # 跳过 install
```

单独执行：

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
node scripts/smoke-ci.mjs
node scripts/e2e-commands.mjs
```

CI 在 `ubuntu-latest`、`windows-latest`、`macos-latest` 上运行；Linux 还可用 `bash docker/run-linux-verify.sh` 在容器内复现。

## 9. 当前取舍

| 取舍 | 原因 |
| --- | --- |
| 不提供 GUI / TUI | 命令行与脚本化是主线；图形外壳不在当前范围内 |
| 不提供常驻 daemon | 需要 root 常驻，安全面与安装复杂度高；TTL 用惰性结算 + `ttl tick` |
| 不提供独立二进制 | 需要额外打包与跨平台验证；当前以 npm 分发 |
| 不自造版本库 | git 快照复用外部 `git`，避免维护存储协议 |
| 不修改系统 DNS 配置 | 只做缓存刷新与只读诊断，避免引入系统网络故障 |
