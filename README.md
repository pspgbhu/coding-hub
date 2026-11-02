# Coding Hub

一个以聊天为中心的本地 AI 编程工作台。通过 Electron 连接 Claude Code、Codex CLI 和 OpenCode CLI，在同一个桌面客户端中管理项目、会话、代码、终端和 Git。

![Coding Hub 工作台](docs/images/workspace-dark.png)

截图来自自动化端到端测试，聊天内容由协议测试夹具生成。

## 开始使用

需要 Node.js 24、pnpm 11，以及 Git。首版面向 macOS 和原生 Windows；请先安装并在终端登录至少一个 coding agent。

```sh
pnpm install
pnpm dev
```

1. 点击「打开项目」，选择本地项目目录。
2. 在「设置 → Agent 连接」检查 CLI 检测结果。通过版本管理器安装的 CLI 或自定义安装位置可以手动填写完整路径。
3. 新建会话，选择 Agent 和模型，开始描述任务。
4. 使用右上角按钮展开代码工作区和终端。

CLI 安装及登录由原工具管理：

| Agent       | 官方说明                                            | 初始集成基线                            |
| ----------- | --------------------------------------------------- | --------------------------------------- |
| Claude Code | [安装与登录](https://code.claude.com/docs/en/setup) | Claude Code 2.1.236 / Agent SDK 0.3.236 |
| Codex       | [CLI 文档](https://developers.openai.com/codex/cli) | Codex CLI 0.151.0 / app-server          |
| OpenCode    | [官方文档](https://opencode.ai/docs/)               | OpenCode 1.19.5 / HTTP + SSE            |

客户端使用本机 CLI 和配置，不代管订阅凭据。Claude 显式加载 user/project/local 配置。Agent 的网络请求仍由各 CLI 发起并遵循其服务条款和用户配置。

新会话会先选中 CLI 模型列表中的首项，创建前会明确展示模型名称；也可以选择「使用 CLI 配置」。模型列表并不保证账号拥有该模型的使用权限；如果原 CLI 配置的模型失效，请在新会话中选择当前账号支持的模型。

## 工作方式

- **会话**：流式回答、可展开的工具记录、授权卡片、用户问答、停止与原生上下文恢复；支持会话重命名、搜索和归档。
- **代码**：按需展开文件树；Monaco 提供标签页、语法高亮、查找、编辑、保存及差异比较。编辑 UTF-8 文本，单文件上限 2 MB。
- **Git**：查看工作区变更、暂存和取消暂存、审阅 diff、提交和切换已有分支。运行任务期间禁止界面提交和切换分支；pull/push 等操作可在终端中完成。
- **终端**：通过本机 PTY 提供真正的交互 shell，支持调整尺寸和输出流控。
- **并行**：多个会话可同时操作同一项目。它们共享文件和 Git 工作区，客户端不自动合并 Agent 之间的修改。编辑器检测到外部变更后提供比较、重新加载和明确覆盖。
- **后台**：关闭窗口后应用留在托盘继续运行；从托盘重新打开。使用应用菜单或托盘「退出 Coding Hub」停止并退出。
- **持久化**：项目、会话记录、原生 session ID 和设置保存在本机 SQLite。中断的任务不会自动重发，发送新消息可以尝试继续原会话。

数据目录使用 Electron 的 `userData`：macOS 默认 `~/Library/Application Support/coding-hub`，Windows 默认 `%APPDATA%/coding-hub`。开发测试可以通过 `CODING_HUB_USER_DATA` 指定独立目录。

## 快捷键

macOS 使用 `⌘`，Windows 使用 `Ctrl`。

| 快捷键                | 操作         |
| --------------------- | ------------ |
| ⌘/Ctrl + N            | 新建会话     |
| ⌘/Ctrl + K            | 搜索会话     |
| ⌘/Ctrl + ,            | 设置         |
| ⌘/Ctrl + B            | 切换侧栏     |
| ⌘/Ctrl + J            | 切换终端     |
| ⌘/Ctrl + S            | 保存当前文件 |
| Enter / Shift + Enter | 发送 / 换行  |

## 开发与验证

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm package:dir
pnpm package:mac
pnpm package:win
```

测试使用 Electron 自带 Node 运行 Vitest，确保 SQLite 和 PTY 的原生模块 ABI 与应用一致。端到端测试使用独立临时目录和可控 CLI 协议夹具，验证 UI → IPC → 后台进程 → 文件/Git/CLI → 持久化；不会向真实模型发送请求。

真实账号连接测试需显式启用 `CODING_HUB_LIVE_SMOKE=1 node scripts/live-smoke.mjs`，会消耗 CLI 账号用量。可用 `CODING_HUB_CODEX_MODEL` 指定测试模型。`scripts/opencode-server-smoke.mjs` 在隔离环境验证官方 OpenCode 二进制的服务接口，不发送模型请求。详见 [验证记录](docs/verification.md)。

`pnpm build` 输出到 `out/`，安装包输出到 `release/`。建议在目标系统打包：macOS 生成 DMG/ZIP，Windows 生成 NSIS。测试包默认未签名；正式分发时需要自行配置代码签名。CI 为 macOS 和 Windows 分别进行构建与测试。

### 架构

```text
React / Monaco / xterm.js
          │ 受控 preload API
Electron Main ── SQLite
          │ request / event
Node Utility Process
  ├─ AgentManager → Claude SDK / Codex app-server / OpenCode server
  ├─ WorkspaceService → 文件系统 / Git
  └─ TerminalService → node-pty
```

适配器协议定义在 `src/shared/`，具体适配器位于 `src/runtime/adapters/`。新增 Agent 应实现检测、发送、取消、回复请求和关闭，并转换为统一事件；保留后端会话 ID，不把终端 ANSI 输出解析成聊天。

## 当前边界

首版不包含 WSL、语言服务器、扩展市场、云同步、worktree 调度、跨 Agent 接力或原 CLI 历史导入。不同 CLI 的模型、审批和用量字段存在差异，界面只展示后端实际返回的信息。

欢迎提交 issue 和 pull request。使用 pnpm，提交遵循 Conventional Commits；修改适配器时补充协议测试，修改桌面流程时运行端到端测试。

## License

[MIT](LICENSE)
