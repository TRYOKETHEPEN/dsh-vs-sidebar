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

/** Main flow: make sure a DSH web server exists, then show it in the sidebar. */
async function connect(context) {
  if (connecting) return;
  connecting = true;
  try {
    const cfg = config();
    setStatusBar("$(radio-tower) DSH: connecting...");
    render(statusPage({ title: "正在连接 DeepSeek Harness…", detail: "" }));
    const server = await manager.ensureServer({
      host: cfg.host,
      port: cfg.port,
      autoStart: cfg.autoStart,
      cwd: workspaceCwd(),
      registryFile: registryFilePath(context),
    });
    currentServer = server;
    const url = await externalize(server.url);
    const owned = server.owned ? "managed" : "reused";
    setStatusBar("$(radio-tower) DSH:" + server.port + " (" + owned + ")", server.url);
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
  }
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
 * Windows: VS Code often starts with a truncated PATH (launched from the
 * Start menu/Explorer), so the npm global bin dir may be missing and the
 * spawned "dsh" command would fail with "not recognized". Append it if
 * absent so ServerManager can find dsh.cmd.
 */
function ensureDshOnPath() {
  if (process.platform === "win32" && process.env.APPDATA) {
    const node = require("node:path");
    const npmBin = node.join(process.env.APPDATA, "npm");
    const parts = (process.env.PATH || "").split(node.delimiter);
    if (!parts.includes(npmBin)) {
      process.env.PATH = (process.env.PATH || "") + node.delimiter + npmBin;
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

  // Re-connect when the workspace root changes (cwd binding matters to DSH).
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (currentServer && currentServer.owned) connect(context);
    })
  );
}

function deactivate() {
  if (manager) {
    return manager.stop();
  }
  return undefined;
}

module.exports = { activate, deactivate };
