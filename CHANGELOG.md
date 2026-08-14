# Changelog / 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-08-14

### Changed / 变更

- **图标换为官方 DeepSeek 品牌图标**：media/dsh.svg 改用官方 24×24 品牌鲸鱼图标（deepseek.svg，currentColor 单色、符合 VS Code 视图容器图标规范）；media/dsh.png 为官方 logo（deepseek-logo.webp，WIC 解码 + GDI+ 合成）生成的 512×512 黑鲸鱼，SVG 与 PNG 均出自 DeepSeek 官方素材。
  Icon replaced with the official DeepSeek 24×24 brand whale (media/dsh.svg, monochrome currentColor per VS Code view-container icon spec); media/dsh.png stays a 512×512 black whale rendered from the official logo (deepseek-logo.webp via WIC + GDI+) — both files come from official DeepSeek artwork.

- **跨平台（Windows / macOS / Linux）**：PATH 袒底扩展到 POSIX —— macOS（Finder/Dock 启动）、Linux（桌面启动）被精简时自动补入存在的常见 npm 全局 bin（~/.npm-global/bin、~/.local/bin、/usr/local/bin、/opt/homebrew/bin 等）；POSIX 下 dsh 以 detached 启动，清理时对进程组 SIGTERM（kill(-pid)），子进程一起清理；CI 新增 ubuntu / macos / windows 三平台自测矩阵（node src/serverManager.js）。
  Cross-platform (Windows / macOS / Linux): PATH fallback extended to POSIX — macOS (Finder/Dock launch) and Linux (desktop launch) get the common npm-global bin dirs appended when missing (~/.npm-global/bin, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin, existing dirs only); on POSIX dsh is spawned detached and cleanup SIGTERMs the whole process group (kill(-pid)) so worker children die too; CI gained a ubuntu/macos/windows self-test matrix (node src/serverManager.js).

- **向上/向下兼容（按 VS Code 开发者手册）**：显式声明 activationEvents（onView + 三条命令，不依赖自动生成）；extensionKind 固定为 workspace（远程场景扩展随工作区侧运行，DSH 进程与文件同侧）；capabilities 明确不支持不受信任工作区与虚拟工作区（扩展会启动本地进程并操作工作区文件）；容器/视图 ID（dsh-sidebar / dsh.webview）标注为持久化契约——升级时不可变更，否则用户侧边栏布局会丢失。
  Forward/backward compatibility per the VS Code developer docs: explicit activationEvents (onView + 3 commands, no reliance on auto-generation); extensionKind fixed to workspace (remote sessions run the extension on the workspace side so the DSH process and files stay on the same side); capabilities declare untrusted and virtual workspaces as unsupported (the extension spawns a local process and touches workspace files); container/view ids (dsh-sidebar / dsh.webview) documented as a persistent contract — never change them in a release or users lose their sidebar layout.

## [0.2.0] - 2026-08-14

### Added / 新增

- **侧边栏随工作区更新**：工作区文件夹增删或活动编辑器切换目录（多根工作区）时，侧边栏自动停止旧工作区的实例（仅限本扩展拉起的，复用实例不动）并按新 cwd 重新探测/拉起/渲染（rebindToWorkspace / scheduleRebind，见 src/extension.js）。
  Sidebar follows the workspace: on folder add/remove or active-editor moves to another root (multi-root), the sidebar stops the old workspace's owned instance and re-probes/re-spawns for the new cwd (rebindToWorkspace / scheduleRebind in src/extension.js).

### Changed / 变更

- **名称与图标**：扩展显示名改为 **DeepSeek Harness Sidebar (DSH)**，侧边栏标签改为 **DeepSeek Harness (DSH)**；图标换成 DeepSeek Harness 官方黑鲸鱼（media/dsh.svg 为官方 favicon 图形、currentColor 适配主题，media/dsh.png 为官方 logo 的 512x512 PNG）。
  Name & icon: display name is now **DeepSeek Harness Sidebar (DSH)**, sidebar tab label is **DeepSeek Harness (DSH)**; icons replaced with the official DeepSeek Harness black whale (media/dsh.svg = official favicon artwork, theme-adaptive currentColor; media/dsh.png = 512x512 PNG from the official logo).

- **README 精简**：只保留安装需求、使用/配置要点与实现说明（实现透明，便于其他 AI 发现 bug）。
  README slimmed down to install requirements, key usage/config and the implementation notes (transparency for AI bug-hunting).

[Unreleased]: https://github.com/Xizhi1024/dsh-vs-sidebar
[0.2.0]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.2.0
[0.1.0]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.1.0

### Added / 新增

- **辅助侧边栏嵌入**：以全屏 iframe 把本地 DeepSeek Harness (DSH) web UI 嵌入 VS Code 辅助侧边栏（secondarySidebar 容器，与 Copilot Chat 同处右侧栏）。
  Embed the local DeepSeek Harness (DSH) web UI via a full-bleed iframe inside the VS Code auxiliary sidebar (secondarySidebar container, same rail as Copilot Chat).

- **按工作区匹配实例**：实例注册表 `dsh-instances.json` 记录每个由扩展拉起的实例（pid/端口/cwd）；只复用 cwd 与本窗口工作区一致的实例，其余情况为本窗口拉起独立实例。
  Per-workspace instance matching: the `dsh-instances.json` registry records every instance the extension spawned (pid/port/cwd); only instances whose cwd matches the current workspace are reused, otherwise the window gets its own instance.

- **自动拉起 / 复用 dsh web**：端口探测（默认 `dsh.port`=3080）以响应体中的 `__DSH_BOOT__` 标记识别 DSH 实例；探测带重试（防止 DSH 繁忙时误判导致多开）；端口被占用时自动向后寻找空闲端口。
  Auto-start / reuse of dsh web: port probing (default `dsh.port`=3080) identifies a DSH instance by the `__DSH_BOOT__` marker in the response body; probes retry so a busy DSH is never misjudged as absent (which would spawn a duplicate instance); occupied ports are scanned forward for a free one.

- **cwd 绑定当前 VS Code 工作区**：以当前工作区作为 DSH 的工作区根（多根工作区优先活动编辑器所在目录）；未打开工作区时进程 cwd 空置（继承父进程目录，不回退用户主目录）。
  cwd bound to the current VS Code workspace: the workspace root becomes the DSH workspace root (in multi-root setups the active editor's folder wins); with no workspace open the spawned process cwd is left unset (inherits the parent's cwd, no fallback to the home directory).

- **Windows PATH 修复**：Windows 下从开始菜单/资源管理器启动 VS Code 时 PATH 常被截断，现自动把 npm 全局 bin 目录（`%APPDATA%\npm`）补进 PATH，确保能找到 `dsh` 命令。
  Windows PATH fix: VS Code launched from the Start menu/Explorer often gets a truncated PATH; the npm global bin dir (`%APPDATA%\npm`) is now appended if missing so the `dsh` command can be found.

- **远程场景支持**：WSL / Remote-SSH 下通过 `vscode.env.asExternalUri` 自动建立端口转发，侧边栏可访问远端 DSH web。
  Remote support: in WSL / Remote-SSH scenarios the extension uses `vscode.env.asExternalUri` to set up port forwarding so the sidebar can reach the remote DSH web.

- **三条命令与三项配置**：命令 `dsh.openInBrowser`（浏览器打开）、`dsh.restartServer`（重启本扩展启动的服务）、`dsh.focusSidebar`（聚焦侧栏）；配置 `dsh.port`、`dsh.host`、`dsh.autoStart`。
  Three commands and three settings: commands `dsh.openInBrowser`, `dsh.restartServer`, `dsh.focusSidebar`; settings `dsh.port`, `dsh.host`, `dsh.autoStart`.

- **安全的实例清理**：关闭 VS Code 时只清理本扩展自行启动的进程（Windows 用 `taskkill /T` 树级清理）；注册表清理只删除已死进程的条目，绝不杀死其他窗口复用的存活实例。
  Safe instance cleanup: on VS Code close only processes this extension spawned are stopped (tree-kill via `taskkill /T` on Windows); registry cleanup deletes only dead entries and never kills live instances reused by other windows.

[Unreleased]: https://github.com/Xizhi1024/dsh-vs-sidebar
[0.1.0]: https://github.com/Xizhi1024/dsh-vs-sidebar/releases/tag/v0.1.0
