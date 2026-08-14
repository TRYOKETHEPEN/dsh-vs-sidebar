# DeepSeek Harness Sidebar (DSH) — dsh-vs-sidebar

把本地 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 DSH）的 Web 界面嵌入 VS Code **辅助侧边栏**（右侧栏）的零依赖扩展：探测并复用已在运行的 DSH 实例，或以**当前工作区**为 cwd 自动拉起 `dsh web`，然后全屏 iframe 渲染。不改动 DSH 任何代码，HTTP/WebSocket 同源直连。

## 安装需求 / Requirements

| 项 | 要求 |
|---|---|
| VS Code | ≥ 1.90，仅桌面版（secondarySidebar 容器需此版本） |
| DSH CLI | 全局安装 `dsh`（见 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 文档） |
| DSH profile | 已配置，`dsh web` 能正常启动 |

## 安装 / Install

- 开发调试：VS Code 打开本仓库 → `F5` → **Run Extension**
- 打包安装：`npm i -g @vscode/vsce && vsce package --no-dependencies` → `code --install-extension dsh-vs-sidebar-0.2.0.vsix`

## 使用 / Usage

- `Ctrl+Alt+B` 打开辅助侧边栏，点击 **DeepSeek Harness (DSH)** 标签
- 命令：`DeepSeek Harness: Open DSH in Browser` / `Restart DSH Server` / `Focus DSH Sidebar`

## 配置 / Configuration

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh.port` | 3080 | 优先探测/启动的端口 |
| `dsh.host` | 127.0.0.1 | 绑定地址（勿改 `0.0.0.0`） |
| `dsh.autoStart` | true | 无匹配实例时是否自动启动（false = 用户自管实例，只复用不拉起） |

## 兼容性 / Compatibility

- 最低 VS Code **1.90**（`engines.vscode`），低于此版本不会被安装（secondarySidebar 容器自 1.90 起支持）；所用 API 均在 1.90 及以下可用
- **Windows / macOS / Linux**：
  - Windows 自动把 `%APPDATA%\npm` 补进 PATH（开始菜单/资源管理器启动时 PATH 被截断）
  - macOS（Finder/Dock 启动）、Linux（桌面环境启动）PATH 被精简时，自动补入存在的常见 npm 全局 bin：`~/.npm-global/bin`、`~/.local/bin`、`/usr/local/bin`、`/opt/homebrew/bin` 等（仅补实际存在的目录）
  - 进程清理：Windows 用 `taskkill /T` 树杀；POSIX 以 `detached` 启动、`kill(-pid)` 对进程组 SIGTERM，dsh web 的子进程一起被清理
- `activationEvents` 显式声明（onView + 三条命令），不依赖自动生成
- `extensionKind: [workspace]`：远程场景扩展随工作区侧运行，DSH 进程与文件同侧
- 不受信任工作区 / 虚拟工作区**不支持**（会启动本地进程并操作工作区文件），已通过 `capabilities` 声明
- 容器 ID `dsh-sidebar` 与视图 ID `dsh.webview` 是**持久化契约**：升级不可变更，否则用户侧边栏布局会丢失（见 `src/types.js`）
- CI（GitHub Actions）在 ubuntu / macos / windows 三平台跑 `node src/serverManager.js` 自测

## 怎么实现的 / Implementation

> 实现透明，便于其他 AI / 开发者快速看懂并发现 bug。核心只有 4 个文件：`src/extension.js`（接线）、`src/serverManager.js`（实例管理）、`src/webviewHtml.js`（页面）、`src/types.js`（常量契约）。

1. **探测**：向 `http://<host>:<port>` 发 `GET /`，响应体含 `__DSH_BOOT__` 标记即认定为 DSH 实例（3s 超时；探测带 3 次重试，防 DSH 忙时误判而重复拉起）。
2. **按工作区匹配实例**：注册表 `dsh-instances.json`（VS Code 全局存储）记录扩展拉起的每个实例 `{pid, port, cwd}`；只复用 cwd 与当前工作区 `samePath` 匹配（Windows 忽略大小写/尾斜杠）的实例；不匹配或 cwd 未知 → 从 `port+1` 起扫描空闲端口（最多 50 个）另起一个。
3. **自动拉起**：`dsh web --host <host> --port <port>`，cwd = 当前工作区（多根工作区取**活动编辑器**所在目录；无工作区则不指定 cwd，继承父进程目录）。Windows 经 `cmd.exe /c` 调用，并自动把 `%APPDATA%\npm` 补进 PATH。
4. **渲染**：健康检查通过（700ms 轮询，30s 上限）后把 DSH URL 以全屏 iframe 嵌入侧边栏 webview；远程场景（WSL / Remote-SSH）用 `vscode.env.asExternalUri` 建立端口转发。
5. **随工作区更新**：`onDidChangeWorkspaceFolders` / `onDidChangeActiveTextEditor` → `rebindToWorkspace()`：检测到工作区根变化时，停掉本扩展为**旧**根拉起的实例（复用的实例绝不动），然后按新 cwd 重新探测/拉起并渲染（见 `src/extension.js` 的 `scheduleRebind` / `rebindToWorkspace`）。
6. **生命周期**：关闭 VS Code / 重启命令只清理本扩展自己拉起的进程（Windows 用 `taskkill /T` 树级清理）；`cleanupStaleRegistry` 只删除已死进程的注册表条目，绝不杀死其他窗口的存活实例。

## 已知限制 / Known limitations

- 仅桌面版 VS Code（web 版无法启动本地进程）
- VS Code 安全策略：webview 内 iframe 只允许加载 https 或 http://127.0.0.1 / localhost，请保持 `dsh.host = 127.0.0.1`（改为局域网 IP 会导致页面空白）
- 若未来 DSH web 加入 `X-Frame-Options` / `frame-ancestors` CSP，iframe 嵌入会失效（请用"在浏览器打开"）
- 上游目录选择器对含特殊 Unicode 的路径有截断 bug —— 直接用 VS Code 打开目标文件夹即可（扩展会以该文件夹为 cwd 拉起实例，无需在 DSH UI 内切目录）

## 目录结构 / Layout

```
media/dsh.svg        # 侧边栏图标：官方 DeepSeek 品牌鲸鱼（24×24，currentColor 适配主题）
media/dsh.png        # Marketplace 图标：官方 logo 渲染的 512×512 黑鲸鱼
src/extension.js     # 激活/视图提供者/命令/工作区跟随
src/serverManager.js # 探测/复用/启动/注册表/清理（自测：node src/serverManager.js）
src/webviewHtml.js   # iframe 页与状态页 HTML
src/types.js         # 共享常量（端口、BOOT_MARKER、视图 ID）
```

## License

MIT © Xizhi1024
