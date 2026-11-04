# 平台支持矩阵

> 状态定义：
> - **已验证**：在本机 macOS（darwin，Node v24.12.0）、CI 或 Docker `linux/amd64` 容器中实际执行过对应命令 / 测试；写操作只使用临时 hosts 文件，不改动真实系统 `/etc/hosts`。
> - **未验证**：代码与单元测试已覆盖，但尚未在真实系统环境执行。
> - **不支持**：代码明确拒绝或没有实现。
> - **不适用**：该平台不存在对应的语义。
>
> CI 的覆盖范围是 install / build / typecheck / lint / test / format:check / smoke / e2e；真实提权写入仍不在覆盖范围内。

## 1. 总览

| 能力 | macOS | Linux | Windows |
| --- | --- | --- | --- |
| hosts 文件路径 | `/etc/hosts`（已验证） | `/etc/hosts`（容器已验证；CI 已验证测试路径） | `%SystemRoot%\System32\drivers\etc\hosts`（CI 已验证路径拼接与 smoke） |
| 路径覆盖 | `--file` / `config.hostsPath`（已验证） | 同左（已验证） | 同左（CI 已验证） |
| 直接写入权限检测 | `access(W_OK)`；提示 `sudo`（已验证） | 同左（容器 root 下跳过权限用例；CI 非 root 已覆盖 PERMISSION 分支） | `access(W_OK)`；提示管理员终端（POSIX 只读分支在 Windows 上跳过；真实提权未验证） |
| 原子写（临时文件 + fsync + rename） | 已验证 | 容器已验证 | CI 已验证基础路径（跳过目录 fsync；rename 遇 EBUSY/EPERM/EACCES 重试 3 次） |
| 权限位保留 | 已验证（0640 夹具） | 容器已验证 | **不适用**（Windows ACL 不等于 POSIX mode） |
| 默认行尾（仅新建行） | `\n`（已验证） | `\n`（已验证） | `\r\n`（CI 已验证） |
| 原有行尾逐行保留 | 已验证（混合 EOL 夹具） | 已验证 | CI 已验证（冒烟用 CRLF 初始文件并做字节比对） |
| UTF-8 BOM 保留 | 已验证 | 已验证 | CI 已验证 |
| UTF-16 自动转换 | 不支持（抛出 `UNSUPPORTED_ENCODING`，exit 7） | 同左 | 同左 |
| DNS 缓存刷新 | `dscacheutil -flushcache` + `killall -HUP mDNSResponder`（命令选择已验证；未在真实系统执行 flush） | `resolvectl flush-caches` → `systemd-resolve --flush-caches` → `nscd -i hosts`（仅单测；容器无 systemd） | `ipconfig /flushdns`（命令选择已验证，真实刷新未验证） |
| DNS 服务器读取（doctor） | `scutil --dns`（未验证） | `/etc/resolv.conf` → `resolvectl status`（未验证） | PowerShell `Get-DnsClientServerAddress`（未验证） |
| Wi-Fi SSID 识别 | `networksetup -getairportnetwork <device>`（未验证） | `iwgetid` → `nmcli`（未验证） | **不支持**（返回 `unsupported`；`network auto` 以 `NETWORK` 错误退出（6），不写配置、不做切换） |
| 解析验证（`--verify`） | `getaddrinfo`（已验证，测试注入 lookup） | 已验证（测试注入 lookup，未真实联网） | CI 已验证（测试注入 lookup） |
| 跨进程锁 | 系统临时目录 `hostscli-locks/`（已验证） | 已验证 | CI 已验证 |
| Git 快照 | 调用外部 `git`（已验证） | 已验证（镜像内 git） | CI 已验证（runner 自带 git） |
| Shell 补全 | `bash` / `zsh` / `fish`（脚本输出已验证） | 已验证（脚本输出 + 单测） | **不支持**（无 PowerShell 补全脚本） |
| 任何其他平台（freebsd 等） | — | — | 抛出 `UNSUPPORTED_PLATFORM`，exit 2 |

## 2. 关键实现位置

| 能力 | 文件 |
| --- | --- |
| 平台枚举、路径解析、默认 EOL | `packages/core/src/system/platform.ts` |
| macOS / Linux hosts 路径 | `packages/core/src/system/darwin.ts`、`linux.ts` |
| Windows 路径（`SystemRoot` / `windir`） | `packages/core/src/system/win32.ts` |
| 写权限与提权提示 | `packages/core/src/system/privilege.ts` |
| 原子写、Windows rename 重试、目录 fsync | `packages/core/src/system/atomic-write.ts` |
| DNS 刷新命令表与回退 | `packages/core/src/system/dns-flush.ts` |
| DNS 服务器读取 | `packages/core/src/diagnostics/dns-servers.ts` |
| SSID 识别 | `packages/core/src/network/detect.ts` |
| 行尾 / BOM / 编码 | `packages/core/src/hosts/tokenizer.ts`、`render.ts` |

## 3. 平台行为细节

### 3.1 macOS

- hosts 路径固定 `/etc/hosts`；`/etc` 是符号链接，`atomicWriteFile` 在**解析后的目录**创建临时文件并 rename，避免跨设备 rename。
- 刷新 DNS 需要 root；普通用户写入后若 flush 失败，命令仍成功，只返回 warning。
- `doctor` 通过 `scutil --dns` 读取系统 DNS；当前以单测夹具验证解析。

### 3.2 Linux

- hosts 路径固定 `/etc/hosts`；容器 / 只读 rootfs 下可能无法写，权限检测会返回 `PERMISSION`。
- Docker 容器里的 `/etc/hosts` 是 bind mount，`rename()` 会 `EBUSY`；因此容器验证**从不写 `/etc/hosts`**，统一用 `config set hostsPath` 指向 `/tmp` 下的普通文件。
- 刷新 DNS 按 `resolvectl` → `systemd-resolve` → `nscd` 依次尝试，首个成功即停止；全部失败只 warning。
- `doctor` 优先 `/etc/resolv.conf`；若只有 `127.0.0.53` 桩地址，回退 `resolvectl status`。
- SSID 识别依赖 `iwgetid` 或 `nmcli`；没有无线工具时返回 `supported: false` 与说明，不阻断其他命令。

### 3.3 Windows

- hosts 路径用 `SystemRoot`（或 `windir`）拼接，默认 `C:\Windows`；不硬编码盘符。
- 写入必须管理员权限；普通终端会得到 `PERMISSION` 与"以管理员身份打开终端"的提示。
- 原子写：临时文件 + rename；`fsync` 目录在 Windows 上跳过；rename 被占用时最多重试 3 次（50/100/150 ms）。
- 不保留 POSIX 权限位；配置文件仍以 `mode: 0o600` 创建，但实际以 ACL 为准。只读属性对 `W_OK` 的影响由 CI 冒烟观察。
- 换行：新建行用 `\r\n`；已有文件逐行保留原行尾（CRLF/LF 混用也可无损往返）。
- SSID 识别与 PowerShell 补全不支持；`doctor` 的 DNS 服务器读取需要 PowerShell 可用。

## 4. 已知限制与验证建议

1. 容器默认 root，会绕过 `chmod` 只读限制；权限拒绝分支（exit 4）只能在非 root 真机或 CI 上验证。
2. 容器无 systemd、无真实 DNS 服务，`dns flush` / DNS 服务器读取仅验证命令选择与解析，不代表真实环境可用。
3. 真实系统 hosts 写入未在 Linux / Windows 上验证；发布前应在两平台各跑一次 `init → add → disable --for → restore` 冒烟，并记录 `--dry-run` diff。
4. Windows 的 `chmod` 不影响权限语义；若需要严格权限，应在发行说明中说明以 ACL 为准。
5. 平台矩阵变更时，同步更新本文件与对应测试。
