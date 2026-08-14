# DeepSeek Harness Sidebar (dsh-vs-sidebar)

[![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/Xizhi1024.dsh-vs-sidebar?label=Marketplace%20Version&color=0e639c)](https://marketplace.visualstudio.com/items?itemName=Xizhi1024.dsh-vs-sidebar)
[![VS Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/Xizhi1024.dsh-vs-sidebar?label=Installs)](https://marketplace.visualstudio.com/items?itemName=Xizhi1024.dsh-vs-sidebar)
[![VS Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/Xizhi1024.dsh-vs-sidebar?label=Downloads)](https://marketplace.visualstudio.com/items?itemName=Xizhi1024.dsh-vs-sidebar)
[![License: MIT](https://img.shields.io/github/license/Xizhi1024/dsh-vs-sidebar)](https://github.com/Xizhi1024/dsh-vs-sidebar/blob/main/LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/Xizhi1024/dsh-vs-sidebar?display_name=release&label=Release)](https://github.com/Xizhi1024/dsh-vs-sidebar/releases)

> 把本地 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 DSH）的 Web 界面直接嵌入 VS Code 的**辅助侧边栏**（右侧栏，与 Copilot Chat 并列）的零依赖扩展。它只做两件事：**探测并复用**你机器上已在运行的 DSH 实例，或者以**当前 VS Code 工作区**为 cwd 自动拉起一个 `dsh web` 服务，然后以全屏 iframe 把它渲染进侧边栏。扩展不改动 DSH 的任何代码、插件或配置，也不经手任何代理——HTTP/WebSocket 同源直连。

> **English:** A zero-dependency VS Code extension that embeds your local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web UI directly into the **auxiliary sidebar** (the right-hand bar, alongside Copilot Chat). It does exactly two things: **detect and reuse** a DSH instance already running on your machine, or **start a fresh `dsh web` service rooted at your current VS Code workspace**, then render it in the sidebar as a full-screen iframe. The extension never modifies DSH code, plugins, or config and routes no traffic through a proxy — HTTP/WebSocket connect directly (same origin).

---

## 目录 / Table of Contents

- [Features / 功能](#features--功能)
- [Requirements / 要求](#requirements--要求)
- [Install / 安装](#install--安装)
- [Usage / 使用](#usage--使用)
- [Configuration / 配置](#configuration--配置)
- [Commands / 命令](#commands--命令)
- [How it works / 原理](#how-it-works--原理)
- [Known limitations / 已知限制](#known-limitations--已知限制)
- [Troubleshooting / 常见问题](#troubleshooting--常见问题)
- [Publishing / 发布与上游 issue](#publishing--发布与上游-issue)
- [Repository layout / 目录结构](#repository-layout--目录结构)
- [License](#license)

---

## Features / 功能

**中文**

- **即插即用**：安装后按 `Ctrl+Alt+B` 打开辅助侧边栏即可看到 DSH，无需任何额外配置；
- **按工作区匹配实例**：每个 VS Code 窗口只复用"属于自己工作区"的实例，多窗口各自绑定自己的项目目录，互不干扰；
- **自动拉起**：没有匹配实例时，以当前工作区为 cwd 自动启动 `dsh web`（多根工作区优先活动编辑器所在目录），DSH 的 agent 直接操作你的项目文件；
- **端口自适应**：目标端口被无关程序占用时，自动向后寻找空闲端口；
- **生命周期隔离**：关闭 VS Code 只清理本扩展自己拉起的进程（Windows 用 `taskkill /T` 树级清理），复用的实例与其他窗口的实例绝不动；
- **远程场景**：WSL / Remote-SSH 下自动用 `vscode.env.asExternalUri` 建立端口转发；
- **零依赖**：纯 Node.js 内置模块实现，无任何 npm 依赖。

**English**

- **Plug & play** — press `Ctrl+Alt+B` to open the auxiliary sidebar and DSH is right there; no extra setup.
- **Workspace-matched instances** — each VS Code window reuses only an instance registered to its own workspace root, so multiple windows stay bound to their own project folders.
- **Auto-start** — when no matching instance exists, the extension starts `dsh web` with your current workspace as its cwd (multi-root: the active editor's folder wins), so the DSH agent works directly on your project files.
- **Adaptive ports** — if the target port is occupied by an unrelated process, the extension scans forward for a free one.
- **Lifecycle isolation** — closing VS Code cleans up only the processes this extension spawned (tree kill via `taskkill /T` on Windows); reused instances and other windows' instances are never touched.
- **Remote support** — automatic port forwarding via `vscode.env.asExternalUri` under WSL / Remote-SSH.
- **Zero dependencies** — built purely on Node.js built-ins; no npm packages at runtime.

---

## Requirements / 要求

| 中文 | English |
|---|---|
| VS Code **≥ 1.90.0**（仅桌面版；`secondarySidebar` 视图容器自该版本起支持） | VS Code **≥ 1.90.0**, desktop edition only (the `secondarySidebar` view container needs this version) |
| **全局安装** DSH 命令行工具 `dsh`（见 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 文档） | `dsh` CLI installed **globally** (see the DeepSeek Harness docs) |
| 已配置的 DSH web 环境（profile），`dsh web` 能正常启动 | A configured DSH web environment (profile) so `dsh web` can start |
| Windows：无额外要求（扩展会自动把 `%APPDATA%\npm` 补进 PATH） | Windows: nothing extra needed (the extension appends `%APPDATA%\npm` to PATH automatically) |

---

## Install / 安装

### 方式一：F5 开发调试（推荐先这样验证） / Method 1: F5 development debugging (recommended first step)

1. 用 VS Code 打开本仓库目录； / Open this repository in VS Code.
2. 按 `F5` 选择 **Run Extension**； / Press `F5` and choose **Run Extension**.
3. 在弹出来的扩展开发宿主窗口里，按 `Ctrl+Alt+B` 打开右侧辅助栏，即可看到 **DeepSeek Harness** 标签。 / In the Extension Development Host window, press `Ctrl+Alt+B` to open the auxiliary bar — the **DeepSeek Harness** tab appears.

### 方式二：复制安装（无需打包） / Method 2: Copy install (no packaging)

1. 运行任务 `Tasks: Run Task` → `dev-install`（或手动把本目录复制到 `%USERPROFILE%\.vscode\extensions\dsh-vs-sidebar`）； / Run the `Tasks: Run Task` → `dev-install` task (or copy this folder to `%USERPROFILE%\.vscode\extensions\dsh-vs-sidebar`).
2. 重启 VS Code（或执行 `Developer: Reload Window`），在任意项目中打开右侧栏即可。 / Restart VS Code (or run `Developer: Reload Window`) and open the auxiliary bar in any project.

### 方式三：VSIX 打包 / Method 3: VSIX package

```bash
npm i -g @vscode/vsce
vsce package --no-dependencies
code --install-extension dsh-vs-sidebar-0.1.0.vsix
```

---

## Usage / 使用

### 打开侧边栏 / Opening the sidebar

- 快捷键 `Ctrl+Alt+B` 打开辅助侧边栏，点击 **DeepSeek Harness** 标签；或运行命令 `DeepSeek Harness: Focus DSH Sidebar`（`dsh.focusSidebar`）。
- Shortcut `Ctrl+Alt+B` opens the auxiliary bar; click the **DeepSeek Harness** tab, or run the `DeepSeek Harness: Focus DSH Sidebar` (`dsh.focusSidebar`) command.

### 连接阶段说明 / Connection stages

侧边栏内会依次显示连接阶段（来自生命周期状态机）： / The sidebar shows each connection stage as it happens:

| 阶段 / Stage | 中文提示 | English message |
|---|---|---|
| probing | 探测 DSH 服务… | Probing for DSH at the configured host:port |
| reusing | 发现运行中的实例，正在复用… | Found a running instance, reusing it |
| starting | 未发现本工作区的实例，正在启动 dsh web… | No instance for this workspace, starting dsh web |
| ready | 服务就绪 | Service ready |
| stopping / stopped | 正在停止… / 已停止 | Stopping… / Stopped (shown when restarting) |

### 状态栏含义 / Status bar semantics

VS Code 状态栏右侧会出现 `DSH:<端口>` 图标，括号内标明实例来源： / A `DSH:<port>` item appears in the status bar; the suffix tells you where the instance came from:

| 显示 / Display | 含义 / Meaning |
|---|---|
| `DSH:3080 (managed)` | 由本扩展在当前工作区拉起，关闭本窗口/重启命令会清理它 / Spawned by this extension for this workspace; cleaned up on window close / restart |
| `DSH:3080 (reused)` | 复用了已有实例（其他窗口或用户自管），本扩展不管理其生命周期 / An existing instance was reused (another window or user-managed); this extension does not manage it |
| `DSH: unavailable` | 连接失败（悬停可看原因；侧栏内有"在浏览器打开 / 重试"按钮） / Connection failed (hover for the reason; the sidebar offers "Open in Browser / Retry") |

---

## Configuration / 配置

设置中搜索 `dsh`（或直接编辑 `settings.json` 里的 `dsh.*`）： / Search `dsh` in settings (or set `dsh.*` directly in `settings.json`):

| 配置 | 默认 | 中文说明 | Description |
|---|---|---|---|
| `dsh.port` | `3080` | 优先探测/启动的端口 | Preferred port to probe and start |
| `dsh.host` | `127.0.0.1` | 绑定地址（**请勿改为 `0.0.0.0`**，DSH 自身也拒绝） | Bind address (**do not use `0.0.0.0`** — DSH itself refuses) |
| `dsh.autoStart` | `true` | 没有匹配实例时是否自动启动 dsh web | Auto-start dsh web when no matching instance is found |

> **`dsh.autoStart = false` 的语义**：视为"实例由用户自己管理"——只要探测到 DSH 实例就**无条件挂接复用**（不再检查工作区是否匹配）；若端口上没有 DSH 实例，则直接报错，不会自动拉起。 / **Semantics of `dsh.autoStart = false`:** instances are considered user-managed — any detected DSH instance is reused unconditionally (workspace matching is skipped); if nothing is running on the port, the extension errors out instead of starting a server.

---

## Commands / 命令

| 命令 ID | 中文标题 | English title | 说明 / Description |
|---|---|---|---|
| `dsh.openInBrowser` | 在浏览器打开 DSH | Open DSH in Browser | 在系统默认浏览器打开当前实例的地址 / Opens the current instance URL in your default browser |
| `dsh.restartServer` | 重启 DSH 服务 | Restart DSH Server | 只重启本扩展启动的实例，复用的实例不受影响 / Restarts only the instance this extension spawned; reused instances are untouched |
| `dsh.focusSidebar` | 聚焦 DSH 侧栏 | Focus DSH Sidebar | 打开并聚焦辅助侧边栏 / Opens and focuses the auxiliary sidebar |

---

## How it works / 原理

扩展本身是纯粹的「查看器 + 启动器」，不改动 DSH 的任何代码、插件或配置。核心流程： / The extension is a pure "viewer + launcher"; it never touches DSH code, plugins, or config:

1. **探测（Probe）**：侧边栏激活时，向 `http://<dsh.host>:<dsh.port>`（默认 `127.0.0.1:3080`）发起 `GET /`，以响应体中的 `__DSH_BOOT__` 标记识别 DSH 实例（3s 超时）。探测带 **3 次重试**（间隔 400ms）：只要有一次"可达"就立即返回结论——**防止 DSH 正忙（如正在流式回复）时被误判为不可达，从而避免重复拉起实例**。
2. **按工作区匹配（Registry matching）**：实例注册表 `dsh-instances.json`（位于 VS Code 全局存储目录）记录每个由扩展拉起的实例的 `pid / port / cwd`。路径比较 `samePath` 在 Windows 上忽略大小写与尾斜杠差异。
3. **自动拉起（Auto-start）**：无匹配实例且 `dsh.autoStart = true` 时，以**当前工作区**为 cwd 运行 `dsh web --host 127.0.0.1 --port <空闲端口>`（多根工作区优先活动编辑器所在目录；无工作区则不指定 cwd，子进程沿用扩展宿主所在目录，**不再回退到用户主目录**）。端口被无关程序占用时自动向后扫描（最多 50 个端口）。Windows 下经 `cmd.exe /c` 调用 `dsh` 命令。
4. **就绪与渲染**：健康检查通过（700ms 轮询，30s 上限）后，把 DSH Web UI 以**全屏 iframe** 渲染进侧边栏 webview——HTTP/WebSocket 同源直连，无代理、无数据搬移。

**注册表匹配语义 / Registry matching semantics**

| 探测结果 / Probe result | 条件 / Condition | 行为 / Behavior |
|---|---|---|
| DSH 可达 | `dsh.autoStart = false` | **无条件复用**（实例由用户自管） / always reuse |
| DSH 可达 | 本窗口无工作区（cwd 为空） | 复用现有实例 / reuse |
| DSH 可达 | 注册表有同端口条目，且条目 cwd 与当前工作区 `samePath` 匹配 | 复用（`owned: false`） / reuse |
| DSH 可达 | 注册表无该端口条目，或 cwd 不匹配（如手动启动、cwd 未知） | **不复用**，从 `port+1` 起扫描空闲端口，拉起属于自己的实例 / spawn a dedicated instance |
| 端口被非 DSH 程序占用 | — | 从 `port+1` 起扫描空闲端口拉起 / scan forward and spawn |
| 端口不可达 | — | 从 `port` 本身起扫描空闲端口拉起 / scan from `port` and spawn |
| 不可达 / 被占用 | `dsh.autoStart = false` | 报错，不拉起 / throw, do not spawn |

**架构图 / Architecture**

```
┌──────────────────────────────────────────────┐
│  VS Code（桌面版，≥ 1.90）                    │
│  ┌────────────────────────────────────────┐  │
│  │ 辅助侧边栏 secondary sidebar (Ctrl+Alt+B)│  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │ dsh.webview  <iframe>            │  │  │
│  │  │  HTTP / WebSocket 同源直连        │  │  │
│  │  └──────────────┬───────────────────┘  │  │
│  └─────────────────┼───────────────────────┘  │
└────────────────────┼──────────────────────────┘
                     │ http://127.0.0.1:<port>
             ┌───────▼────────┐
             │  DSH web 服务    │  cwd = 当前 VS Code 工作区
             │ (pid, port, cwd) │
             └───────┬────────┘
                     │
             ┌───────▼────────┐
             │  项目文件 / 文件系统 │
             └────────────────┘
```

**生命周期与清理 / Lifecycle & cleanup**

- 关闭 VS Code（或执行 `dsh.restartServer`）时，**只清理本扩展自己启动的进程**：Windows 用 `taskkill /T` 树级清理，POSIX 用 `SIGTERM`；被复用的实例不受影响。
- 注册表清理（`cleanupStaleRegistry`）**只删除已死进程的条目，绝不杀死其他窗口的存活实例**；`stop()` 也只移除自己 pid 对应的条目。
- 工作区变更时（`onDidChangeWorkspaceFolders`），若当前实例是本扩展拉起的，会自动按新工作区重新连接。

---

## Known limitations / 已知限制

- **仅桌面版 VS Code**：`vscode.dev` / Web 版无法启动本地进程。 / **Desktop VS Code only** — `vscode.dev`/web cannot spawn local processes.
- **远程场景（WSL / Remote-SSH）**：DSH 跑在远端，扩展用 `vscode.env.asExternalUri` 自动建立端口转发；若转发不可用会显示错误页（可用"在浏览器打开"兜底）。 / **Remote (WSL / Remote-SSH):** DSH runs on the remote side; the extension sets up forwarding via `vscode.env.asExternalUri`. If forwarding is unavailable, an error page is shown ("Open in Browser" is the fallback).
- **iframe 兼容性**：若未来 DSH web 加入 `X-Frame-Options` / `frame-ancestors` CSP，嵌入会失效（当前版本无此限制），届时请用"在浏览器打开"或向 DSH 提 issue。 / **iframe compatibility:** if a future DSH web build adds `X-Frame-Options` / `frame-ancestors` CSP, embedding breaks (no such header today); use "Open in Browser" or file an issue upstream.
- **上游目录选择器截断 bug**：DSH 的原生目录选择器对含特定 Unicode 字符的路径有截断 bug。**规避方式：直接用 VS Code 打开目标文件夹**，由扩展以该文件夹为 cwd 拉起实例，无需在 DSH UI 内切换工作区（详见 Troubleshooting 中 `workspace-invalid-path` 条目）。 / **Upstream directory-picker truncation bug:** DSH's native directory picker truncates paths containing certain Unicode characters. **Workaround: open the target folder directly in VS Code** — the extension launches the instance with that folder as cwd, so no in-UI workspace switching is needed (see `workspace-invalid-path` under Troubleshooting).
- **侧边栏宽度较窄**：复杂界面建议临时拉宽右侧栏，或使用"在浏览器打开"。 / **Narrow sidebar:** for complex UIs, widen the auxiliary bar or use "Open in Browser".

---

## Troubleshooting / 常见问题

### 没有切换工作区 / "The workspace didn't switch"

**现象 / Symptom**：打开其他项目后，DSH 侧栏仍在操作旧目录。 / After opening another project, the DSH sidebar still works on the old directory.

**原因 / Cause**：实例是**按工作区匹配**的——当前窗口复用的是注册表中 cwd 匹配的实例。 / Instances are matched **by workspace** — the current window reuses the registry entry whose cwd matches.

**解决 / Fix**：执行 `Developer: Reload Window`（或重新 F5 启动扩展宿主）。扩展会为新工作区重新匹配/拉起实例。若当前实例是本扩展拉起的，切换工作区时会自动重连；保险起见重载窗口一次即可。 / Run `Developer: Reload Window` (or relaunch the extension host via F5) so the extension re-matches for the new workspace. If the current server was spawned by this extension, switching workspaces triggers an automatic reconnect; a reload is the deterministic fallback.

### `workspace-invalid-path`（DSH 上游目录选择器截断 bug）

**现象 / Symptom**：在 DSH UI 内用原生目录选择器选择含特定 Unicode 字符（如中文、全角字符等）的路径时，路径被截断，agent 无法找到目标目录。 / Using DSH's native directory picker on a path containing certain Unicode characters truncates the path and the agent cannot find the folder.

**原因 / Cause**：这是 **DSH 上游**的 bug（原生目录选择器的路径处理问题），不是本扩展的问题。 / This is an **upstream DSH** bug in the native directory picker's path handling, not this extension.

**解决 / Fix**：**直接用 VS Code 打开目标文件夹**，本扩展会把该文件夹作为 cwd 拉起 DSH 实例——DSH 的工作区根 = 你的项目目录，agent 直接操作项目文件，**无需在 UI 内切换工作区**。 / **Open the target folder directly in VS Code** — the extension launches DSH with that folder as its cwd, so DSH's workspace root equals your project directory and the agent works on your files directly — **no in-UI workspace switching required**.

### 其他 / Others

| 现象 / Symptom | 解决 / Fix |
|---|---|
| 提示 `dsh: command not found` | 确认已全局安装 DSH CLI；Windows 上扩展会自动把 `%APPDATA%\npm` 补进 PATH（若仍失败请重启 VS Code 后重试） / Make sure the DSH CLI is installed globally; on Windows the extension appends `%APPDATA%\npm` to PATH automatically (restart VS Code and retry if it still fails) |
| 端口被其他程序占用 | 扩展会自动向后扫描空闲端口（最多 50 个）；若仍未找到，请检查占用进程 / The extension scans forward automatically (up to 50 ports); if it still fails, check what occupies the port |
| `autoStart=false` 且无实例运行 | 侧栏显示错误页，提供"在浏览器打开"与"重试"按钮；请自行启动 DSH 后点重试 / The sidebar shows an error page with "Open in Browser" / "Retry"; start DSH yourself and retry |
| 远程（WSL/SSH）页面打不开 | 依赖 `asExternalUri` 端口转发；转发不可用时显示错误页，可用"在浏览器打开" / Relies on `asExternalUri` forwarding; if unavailable, use "Open in Browser" |
| 界面显示不全/太窄 | 拉宽辅助侧边栏，或"在浏览器打开" / Widen the auxiliary bar or open in the browser |

---

## Publishing / 发布与上游 issue

**发布到 VS Code Marketplace / Publishing to the VS Code Marketplace**

```bash
npm i -g @vscode/vsce
vsce login Xizhi1024          # 与 package.json 的 publisher 保持一致
vsce publish --no-dependencies
```

也可先 `vsce package --no-dependencies` 生成 VSIX，再在 [Marketplace 管理门户](https://marketplace.visualstudio.com/manage) 上传。 / Alternatively run `vsce package --no-dependencies` and upload the VSIX via the Marketplace management portal.

> **⚠️ Publisher 确认 / Verify your publisher id**：README 徽章、发布命令与本仓库 `package.json` 中的 `publisher` 字段均假定为 `Xizhi1024`。**若你的实际 Marketplace publisher 与此不同，请自行替换**：`package.json` 的 `publisher` 行、README 顶部全部 shields.io 徽章 URL（`Xizhi1024.dsh-vs-sidebar` → 你的 `publisher.dsh-vs-sidebar`），以及 `vsce login` 的发布者名。徽章在首次发布前会显示占位（not found / 0），发布后自动变为真实数据。

**上游 issue / Upstream issue**

- 目录选择器截断 bug 属于 **DSH 上游**（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）：请向上游仓库提交 issue，附上触发路径与复现步骤（详见 [Troubleshooting](#troubleshooting--常见问题) 中的 `workspace-invalid-path` 条目）。本扩展侧的规避方式已内置（以 VS Code 工作区为 cwd 拉起）。
- 其他 DSH web 相关（如未来加入 `X-Frame-Options` CSP 导致无法嵌入）也请反馈到上游仓库。

---

## Repository layout / 目录结构

```
dsh-vs-sidebar/
├─ package.json        # 清单：secondarySidebar 容器 + webview 视图 + 命令 + 配置
├─ media/dsh.svg       # 侧边栏容器图标（源文件 SVG）
├─ media/dsh.png       # Marketplace 图标（PNG，发布必需）
└─ src/
   ├─ extension.js     # 接线：activate/provider/命令/远程转发/状态栏
   ├─ serverManager.js # 探测/复用/换端口/启动/健康检查/清理（含自测）
   ├─ webviewHtml.js   # iframe 页与状态页 HTML
   └─ types.js         # 共享常量与契约
```

---

## License

MIT © Xizhi1024 — 见 [LICENSE](LICENSE)。
