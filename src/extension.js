"use strict";
/**
 * DeepSeek Harness Sidebar — VS Code extension entry point.
 *
 * Wiring layer only:
 *  - reads the dsh.* configuration (host/port/autoStart)
 *  - ensures a local DSH web server exists (reuses a running instance,
 *    spawns one when allowed) via ServerManager
 *  - renders the DSH web UI inside the auxiliary-bar webview via an iframe
 *  - provides the openInBrowser / restartServer / focusSidebar commands
 *
 * Zero npm dependencies. CommonJS.
 */
const vscode = require("vscode");
const { ServerManager } = require("./serverManager");
const { framePage, statusPage } = require("./webviewHtml");
const { DEFAULT_HOST, DEFAULT_PORT, VIEW_ID, CONTAINER_ID } = require("./types");

let manager = null; // ServerManager instance (created in activate)
let currentServer = null; // RunningServer | null
let currentView = null; // vscode.WebviewView | null
let statusBar = null; // vscode.StatusBarItem | null
let connecting = false; // guards against concurrent connect() runs
let connectPromise = null; // in-flight connect() so workspace rebinds can await it
let boundCwd = null; // workspace root the current server is bound to (null = none)
let rebindChain = Promise.resolve(); // serializes workspace-change rebinds

/** Read the user's dsh.* settings. */
function config() {
  const c = vscode.workspace.getConfiguration("dsh");
  return {
    host: c.get("host", DEFAULT_HOST),
    port: c.get("port", DEFAULT_PORT),
    autoStart: c.get("autoStart", true),
  };
}

/**
 * The directory the DSH server should treat as its workspace root.
 * Defaults to the current VS Code workspace: in multi-root setups the
 * workspace of the active editor wins, otherwise the first folder.
 * Returns null when no workspace is open — the spawned process then
 * inherits the extension host's cwd (no forced fallback to a home dir).
 */
function workspaceCwd() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  try {
    const active = vscode.window.activeTextEditor;
    if (active && active.document && active.document.uri) {
      const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
      if (folder) return folder.uri.fsPath;
    }
  } catch (_) { /* fall through to the first workspace folder */ }
  return folders[0].uri.fsPath;
}

/**
 * Shared instances-registry location. All VS Code windows of this extension
 * read/write the same file, so a window can tell which workspace root a
 * running instance was started for (and only reuse matching ones).
 */
function registryFilePath(context) {
  if (context.storageUri) {
    return vscode.Uri.joinPath(context.storageUri, "dsh-instances.json").fsPath;
  }
  return null;
}

/**
 * In remote scenarios (WSL / Remote-SSH) the server runs on the remote side
 * while the webview renders on the local client; asExternalUri sets up VS
 * Code port forwarding and returns the client-reachable URI.
 */
async function externalize(url) {
  try {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    return uri.toString(true);
  } catch (_) {
    return url; // local scenario or forwarding unavailable: keep the raw loopback URL
  }
}

function setStatusBar(text, tooltip) {
  if (!statusBar) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  }
  statusBar.text = text;
  statusBar.tooltip = tooltip || text;
  statusBar.show();
}

/** Push an HTML page into the sidebar webview, if one is open. */
function render(page) {
  if (currentView) {
    currentView.webview.html = page;
  }
}

/**
 * Main flow: make sure a DSH web server exists, then show it in the sidebar.
 * Returns the in-flight promise so callers (retry, openInBrowser, workspace
 * rebinds) can await the same connect instead of racing it. The cwd the
 * server ends up bound to is recorded in boundCwd.
 */
function connect(context) {
  if (connectPromise) return connectPromise; // one connect at a time
  connectPromise = (async () => {
    connecting = true;
    try {
      const cfg = config();
      const cwd = workspaceCwd();
      setStatusBar("$(radio-tower) DSH: connecting...");
      render(statusPage({ title: "正在连接 DeepSeek Harness…", detail: "" }));
      const server = await manager.ensureServer({
        host: cfg.host,
        port: cfg.port,
        autoStart: cfg.autoStart,
        cwd,
        registryFile: registryFilePath(context),
      });
      currentServer = server;
      boundCwd = cwd;
      const url = await externalize(server.url);
      const owned = server.owned ? "managed" : "reused";
      setStatusBar(
        "$(radio-tower) DSH:" + server.port + " (" + owned + ")",
        server.url + (cwd ? " | cwd: " + cwd : "")
      );
      render(framePage({ url }));
    } catch (err) {
      currentServer = null;
      setStatusBar("$(error) DSH: unavailable");
      const cfg = config();
      const url = "http://" + cfg.host + ":" + cfg.port;
      try {
        render(statusPage({
          title: "DeepSeek Harness 不可用",
          detail: String(err && err.message ? err.message : err),
          url,
          showOpenBrowser: true,
          showRetry: true,
        }));
      } catch (_) { /* never throw out of connect() */ }
    } finally {
      connecting = false;
      connectPromise = null;
    }
  })();
  return connectPromise;
}

/** Re-connect: stops only servers this extension spawned, never a reused one. */
async function reconnect(context) {
  if (currentServer && currentServer.owned) {
    await manager.stop();
  }
  currentServer = null;
  await connect(context);
}

/**
 * True when two cwd values denote the same root. Null-safe: both null means
 * "no workspace" on both sides; samePath handles Windows case/trailing-slash
 * differences.
 */
function sameRoot(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return ServerManager.samePath(a, b);
}

/**
 * Re-bind the sidebar to the current workspace root. Called whenever the
 * workspace changed — folders added/removed, or the active editor moved to
 * another folder in a multi-root workspace — so the embedded DSH instance
 * always matches the workspace the user is looking at.
 *
 * Stops a server this extension spawned for the OLD root (reused instances
 * are never touched), resets the view to a "connecting" state and re-runs
 * the whole probe/reuse/spawn flow for the new cwd. No-ops when the root did
 * not effectively change.
 */
async function rebindToWorkspace(context) {
  const cwd = workspaceCwd();
  if (sameRoot(cwd, boundCwd)) return; // no effective workspace change

  // Let an in-flight connect settle first so its result is never clobbered
  // by the stop below (the stop kills whatever the running connect spawned).
  if (connectPromise) {
    try { await connectPromise; } catch (_) { /* errors are handled inside connect */ }
    if (sameRoot(cwd, boundCwd)) return; // it already bound to the new root
  }

  if (currentServer && currentServer.owned) {
    try { await manager.stop(); } catch (_) { /* never break the rebind */ }
  }
  currentServer = null;
  boundCwd = cwd;
  render(statusPage({
    title: "正在连接 DeepSeek Harness…",
    detail: "工作区已变更，正在为新工作区匹配 DSH 实例…",
  }));
  await connect(context);
}

/**
 * Queue a workspace-driven rebind. Chained so rapid workspace switches are
 * processed one after another instead of racing each other.
 */
function scheduleRebind(context) {
  rebindChain = rebindChain
    .then(() => rebindToWorkspace(context))
    .catch((err) => console.error("dsh-vs-sidebar: workspace rebind failed:", err));
}

/**
 * Ensure the dsh CLI is findable when VS Code was launched with a trimmed
 * PATH:
 *  - Windows: launched from the Start menu/Explorer, the npm global bin dir
 *    (%APPDATA%\npm, where dsh.cmd lives) may be missing from PATH.
 *  - macOS: launched from Finder/Dock, the launchd PATH (/usr/bin:/bin:
 *    /usr/sbin:/sbin) lacks the npm global bin (~/.npm-global/bin,
 *    /usr/local/bin, /opt/homebrew/bin).
 *  - Linux: desktop-launched sessions often lack the user npm prefix
 *    (~/.local/bin, ~/.npm-global/bin).
 * Only directories that actually exist are appended (POSIX), so a terminal
 * launch with a full PATH is never polluted.
 */
function ensureDshOnPath() {
  const node = require("node:path");
  const parts = (process.env.PATH || "").split(node.delimiter);
  const append = (dir) => {
    if (dir && !parts.includes(dir)) {
      process.env.PATH = (process.env.PATH || "") + node.delimiter + dir;
    }
  };
  if (process.platform === "win32") {
    if (process.env.APPDATA) append(node.join(process.env.APPDATA, "npm"));
    return;
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    const fs = require("node:fs");
    const home = process.env.HOME || "";
    const candidates = [];
    if (home) {
      candidates.push(node.join(home, ".npm-global", "bin"));
      candidates.push(node.join(home, ".local", "bin"));
      candidates.push(node.join(home, ".yarn", "bin"));
    }
    candidates.push("/usr/local/bin", "/opt/homebrew/bin");
    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir)) append(dir);
      } catch (_) { /* stat errors are non-fatal */ }
    }
  }
}

function activate(context) {
  ensureDshOnPath();
  manager = new ServerManager({
    onStatus: (s) => {
      // Surface each lifecycle stage inside the sidebar so the user can see
      // whether we reused an instance or started a new one (multi-instance
      // transparency).
      const stage = {
        probing: "探测 DSH 服务…",
        reusing: "发现运行中的实例，正在复用…",
        starting: "未发现本工作区的实例，正在启动 dsh web…",
        ready: "服务就绪",
        stopping: "正在停止…",
        stopped: "已停止",
      }[s.state];
      if (stage && s.state !== "ready" && s.state !== "stopped" && s.state !== "stopping") {
        try {
          render(statusPage({ title: "正在连接 DeepSeek Harness…", detail: stage + (s.message ? " (" + s.message + ")" : "") }));
        } catch (_) { /* non-fatal */ }
      }
      if (s.state === "error" && s.message) {
        setStatusBar("$(error) DSH: " + s.message);
      } else if (s.state === "ready") {
        setStatusBar("$(radio-tower) DSH:" + (s.server ? s.server.port : "?"));
      }
    },
  });

  // Prune dead registry entries (best effort). NEVER kills live instances —
  // they may belong to another VS Code window with its own workspace.
  try {
    ServerManager.cleanupStaleRegistry(registryFilePath(context));
  } catch (_) { /* best effort */ }

  const provider = {
    resolveWebviewView(view) {
      // VS Code shows "Error restoring view: <id>" whenever this function
      // throws or rejects, so it must never propagate an exception.
      try {
        currentView = view;
        view.webview.options = { enableScripts: true };
        // Synchronous first paint: the webview always has content, even if
        // the async connect below fails later.
        view.webview.html = statusPage({ title: "正在连接 DeepSeek Harness…", detail: "" });
        // NOTE: onDidReceiveMessage lives on the Webview, not the WebviewView.
        view.webview.onDidReceiveMessage((msg) => {
          if (msg && msg.type === "openBrowser" && currentServer) {
            vscode.env.openExternal(vscode.Uri.parse(currentServer.url));
          } else if (msg && msg.type === "retry") {
            connect(context).catch(() => {});
          }
        });
        view.onDidDispose(() => { currentView = null; });
        // Run the (async) attach outside the resolve call; connect() handles
        // its own errors and only mutates view.webview.html via render().
        setImmediate(() => { connect(context).catch(() => {}); });
      } catch (err) {
        console.error("dsh-vs-sidebar: resolveWebviewView failed:", err);
      }
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.openInBrowser", async () => {
      if (currentServer) {
        await vscode.env.openExternal(vscode.Uri.parse(currentServer.url));
      } else {
        await connect(context);
        if (currentServer) {
          await vscode.env.openExternal(vscode.Uri.parse(currentServer.url));
        }
      }
    }),
    vscode.commands.registerCommand("dsh.restartServer", () => reconnect(context)),
    vscode.commands.registerCommand("dsh.focusSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension." + CONTAINER_ID);
      await vscode.commands.executeCommand(VIEW_ID + ".focus");
    })
  );

  // Follow the workspace: when folders are added/removed or the active
  // editor moves to another root (multi-root), rebind the sidebar to the new
  // root's DSH instance. sameRoot() inside rebindToWorkspace keeps unrelated
  // editor switches (same folder) a no-op.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRebind(context)),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleRebind(context))
  );
}

function deactivate() {
  if (manager) {
    return manager.stop();
  }
  return undefined;
}

module.exports = { activate, deactivate };
