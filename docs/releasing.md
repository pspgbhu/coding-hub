# 内部打包、签名候选与更新源

本仓库区分内部测试包和签名发行候选。当前版本仍为 0.1.1；代码、构建脚本与 CI 配置完成，不等于生产证书、更新 feed、目标机安装或升级已验收。逐项结果以[验证记录](verification.md)和[产品交付清单](product-plan.md)为准。

## 内部测试包

默认 `electron-builder.yml` 将 `releaseChannel` 标记为 `internal`，没有生产更新 feed。它配置 macOS DMG / ZIP 与 Windows NSIS；正常开发和内部验证使用：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm format:check
pnpm package:dir
pnpm test:packaged
```

需要完整安装器时，在原生目标系统使用 `pnpm package:mac` 或 `pnpm package:win`。内部构建不会强制要求生产签名；无有效证书时不能把产物称为已正式签名。`package:dir` 和 `test:packaged` 验证解包后的应用可执行文件，不执行 DMG / NSIS 的真实安装、卸载与升级向导。

`scripts/packaged-e2e.mjs` 按当前原生系统和架构，从 `release/mac`、`release/mac-arm64` 或 `release/win-unpacked` 选择应用并打印实际路径；本架构产物缺失时直接报错，不回退到其他架构的旧包。

本机 macOS 另有独立 DMG 安装升级验证。确认旧、新 DMG 都已完整生成，且没有打包进程正在替换这些文件后运行：

```sh
node scripts/macos-install-smoke.mjs \
  --old-dmg 'release/Coding Hub-0.1.0.dmg' \
  --new-dmg 'release/Coding Hub-0.1.1.dmg' \
  --output coverage/installation/macos-x64.json
```

脚本只读挂载两个本地 DMG，用 `ditto` 复制到私有临时 `Applications/Coding Hub.app`，实际启动旧版后在同一路径替换并启动新版。它验证隔离 v1 数据的迁移、中文历史、原生会话 ID、项目路径和设置保留，以及新版草稿与未保存编辑缓冲区的退出恢复；删除临时应用后，另行核对独立用户数据仍保留，最后才清理测试数据。所有 CLI 路径均指向私有不存在的文件，并过滤常见凭据环境变量；不使用真实 Agent 账号、用户应用目录或默认用户数据。JSON 记录实际版本、架构、DMG SHA256、断言与清理结果，截图写入 `coverage/installation/`。

每份报告覆盖其记录架构上的原生 macOS 复制、替换与删除应用流程，不覆盖 Finder 拖放操作、Gatekeeper、隔离属性、公证、生产签名、更新 feed 下载、Windows NSIS 或人工辅助技术验收。某个架构的通过结果不能替代另一架构的实际运行记录。

## 签名候选配置

`electron-builder.release.yml` 继承默认配置，启用强制签名、macOS hardened runtime / notarization、Windows 更新签名校验，并将构建通道设为 `stable`。它从 `CODING_HUB_UPDATE_URL` 写入 generic HTTPS 更新源。

在目标系统的安全环境中注入凭据后运行：

```sh
pnpm release:mac
```

或在原生 Windows 中：

```powershell
pnpm release:win
```

`scripts/release.mjs` 会先构建，再用签名配置打包；缺少 HTTPS 更新地址、签名身份或 macOS 公证凭据时拒绝继续；更新地址不得包含嵌入凭据、查询参数或片段。此脚本使用 `--publish never`，不部署更新服务器或发布下载文件。构建成功后仍需检查实际签名、公证、安装包和更新元数据。

本地签名使用 `CSC_LINK` 与对应的 `CSC_KEY_PASSWORD`；macOS 也可以通过 `CSC_NAME` 选择钥匙串中的身份。仓库现有 GitHub Actions 的凭据映射如下：

| GitHub 配置                                                                  | 用途                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| environment `production-release`                                             | `Signed release candidates` 工作流使用的发行环境                                   |
| variables `MAC_X64_UPDATE_URL`、`MAC_ARM64_UPDATE_URL`、`WIN_X64_UPDATE_URL` | 各平台 / 架构独立的 generic HTTPS feed；矩阵将对应值映射为 `CODING_HUB_UPDATE_URL` |
| secret `MAC_CSC_LINK`                                                        | macOS 签名证书，工作流映射为 `CSC_LINK`                                            |
| secret `MAC_CSC_KEY_PASSWORD`                                                | macOS 证书密码，映射为 `CSC_KEY_PASSWORD`                                          |
| secret `WIN_CSC_LINK`                                                        | Windows 签名证书，映射为 `CSC_LINK`                                                |
| secret `WIN_CSC_KEY_PASSWORD`                                                | Windows 证书密码，映射为 `CSC_KEY_PASSWORD`                                        |
| secrets `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`           | 当前工作流采用的 macOS 公证身份                                                    |

macOS 两种架构共用 macOS 签名身份，Windows 使用自己的证书。证书文件和密码通过秘密存储注入，不写入仓库、Issue、普通日志或客户端配置。macOS 公证的 API key 也是 electron-builder 的可选方式，但当前工作流提供的是上表中的 Apple ID 方式，不能把脚本接受一个变量视为整套凭据已经配置完整。[electron-builder v26 签名文档](https://www.electron.build/v26/docs/features/code-signing/)解释证书和环境变量的实际要求。

## CI 产物与平台证据

`.github/workflows/ci.yml` 配置 macOS x64、macOS arm64 和原生 Windows x64 的检查、内部打包、packaged E2E、原生安装升级验证与校验和。`.github/workflows/release.yml` 是手动触发的签名候选构建，输出带平台标识的 Actions artifacts。

2026-11-03 的[CI run 41568623697](https://github.com/pspgbhu/coding-hub/actions/runs/41568623697)对应提交 `15bb76a`，两套原生 macOS runner 均已完成实际运行：

| 目标架构    | 单元测试                        | 源码 E2E  | 安装包 E2E | 0.1.0 安装 → 0.1.1 升级 → 卸载保留数据 |
| ----------- | ------------------------------- | --------- | ---------- | -------------------------------------- |
| macOS x64   | 226 项通过                      | 17 项通过 | 17 项通过  | 13 项断言通过                          |
| macOS arm64 | 226 项通过                      | 17 项通过 | 17 项通过  | 13 项断言通过                          |
| Windows x64 | 11 项失败，209 项通过，6 项跳过 | 未进入    | 未进入     | 未进入                                 |

Windows 的进程快照和 PTY 修复等待下一轮原生 CI；不能把修复代码或本机回归视为 Windows 已通过。两套 macOS 通过的是内部构建和隔离安装流程，仍不代表生产签名、公证、Gatekeeper、SmartScreen、更新 feed 或人工辅助技术验收完成。

安装基线由 `scripts/build-install-baseline.mjs` 在 `runner.temp` 的独立 worktree 构建，固定源提交为 `9610d035cab6f85232972c8f9960d7282526af68`，不会替换当前源码。报告记录当前提交、实际架构、安装路径、新旧安装器摘要及清理结果；完成后移除旧版源码和临时安装 fixture。Windows 的 `scripts/windows-install-smoke.mjs` 仅允许显式启用的 GitHub-hosted CI，拒绝已存在的应用注册、快捷方式、默认数据和安装缓存；执行真实 NSIS 安装器与卸载器，不以删除目录代替卸载成功。

每个平台的 `desktop-evidence-*` artifact 包含 `coverage/installation/` 中的基线与安装 JSON、截图，以及性能报告和 E2E 证据。上述两套 macOS 安装报告均已独立核对 13 项断言、新旧摘要、实际架构与清理结果，截图中的旧历史和新版草稿 / 编辑缓冲区均可见。产物文件、CI YAML 或其他架构的成功结果不能替代本平台的运行证据。

生成校验和：

```sh
node scripts/checksums.mjs
```

脚本为 `release/` 中的安装器、更新 YAML 和 blockmap 生成 `SHA256SUMS.txt`。它证明文件是否与某份清单一致，不替代代码签名、发行者身份或安装验收。

## 部署更新 feed

当前工作流只保留候选产物，不自动上传 generic feed。electron-builder 的 generic provider 需要维护者自行部署安装文件和更新元数据；打包应用内的 `app-update.yml` 是客户端配置，不是可直接拿来替代服务器 `latest*.yml` 的更新清单。[electron-builder v26 更新文档](https://www.electron.build/v26/docs/features/auto-update/)说明这一区别。

正式部署前需要完成：

1. 确定长期可访问的 HTTPS 地址，并确认版本号高于已安装版本。URL 会进入客户端配置，不能承担凭据保管职责。
2. 保留实际生成的安装器、macOS 更新所需 ZIP、blockmap 和对应 YAML，核对 YAML 中的路径、版本、摘要与服务器文件一致。
3. 明确架构路由。当前矩阵使用三个独立 feed 变量；部署时应实际配置不同地址，并把各架构产物发布到对应目录。分别构建的 macOS 候选可能生成同名 `latest-mac.yml`，不能混放后互相覆盖。修改为统一 feed 时需另行正确生成合并的多架构元数据。
4. 先部署被引用的产物，再切换对应更新清单；保留上一个可用版本及其完整文件，便于服务端恢复。
5. 从一份已安装且正确签名的旧版本，测试“检查 → 下载 → 重启安装”，并核对会话、草稿、缓冲区、原生 ID 和备份。
6. 验证无更新、离线 / 超时、损坏下载、签名不匹配、运行任务阻止重启、用户推迟安装等结果。

应用关闭自动下载、普通退出时自动安装和自动降级。只有下载完成并由用户明确要求重启后，才进入安装流程。构建中的 `stable` 标识不能代替这些服务端配置和实机证据。

## 对外分发前的验收记录

每个目标架构应分别记录应用版本、提交、构建来源、安装器摘要、签名 / 公证结果及以下结果：首次安装、从上一版本升级、数据保留、启动 / 后台恢复、三 CLI 离线协议场景、备份恢复、更新成功 / 失败、卸载与用户数据选择。真实账号测试仍按需显式启用，不能在普通发行流水线中意外消耗账号。

在生产证书、可用 feed 或目标系统验收缺失时，继续把产物作为内部测试 / 发行候选，并将缺少的证据明确列出；不要据此宣布正式 1.0 已发布。
