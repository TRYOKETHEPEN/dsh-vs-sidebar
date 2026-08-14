'use strict';

/**
 * serverManager.js — manages the local DeepSeek Harness (DSH) web service
 * from a VS Code auxiliary sidebar.
 *
 * Responsibilities:
 *   - probe a host:port to detect whether the DSH web UI is running there
 *     (its index.html body contains the BOOT_MARKER symbol).
 *   - reuse an already-running DSH instance, or start one via the globally
 *     installed `dsh` CLI on a free port (scanning forward from the
 *     configured port).
 *   - keep a JSON instance registry (per-workspace DSH instances) so each
 *     VS Code window binds to its own workspace's instance.
 *   - report lifecycle transitions through an `onStatus` callback.
 *
 * Zero external dependencies: only Node built-ins are used.
 */

const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Shared contract constants normally come from ./types (written in parallel
// by another agent). If that module is not ready yet, fall back to local
// defaults so this file stays independently testable. A half-written module
// (missing file, syntax error, undefined export) all resolve to the fallback.
let typesModule = null;
try {
  typesModule = require('./types');
} catch {
  // types.js not available yet — local constants below are used instead.
}
const DEFAULT_PORT = typesModule && typesModule.DEFAULT_PORT != null ? typesModule.DEFAULT_PORT : 3080;
const DEFAULT_HOST = typesModule && typesModule.DEFAULT_HOST != null ? typesModule.DEFAULT_HOST : '127.0.0.1';
const BOOT_MARKER = typesModule && typesModule.BOOT_MARKER != null ? typesModule.BOOT_MARKER : '__DSH_BOOT__';

const PROBE_TIMEOUT_MS = 3000;   // per-probe socket timeout (generous for a busy DSH)
const PORT_SCAN_LIMIT = 50;      // max ports scanned forward when the target is busy
const HEALTH_POLL_MS = 700;      // interval between health checks after spawn
const HEALTH_TIMEOUT_MS = 30000; // overall wait for the spawned service to become ready
const MAX_BODY_BYTES = 5 * 1024 * 1024; // bound on the probe response body we buffer

class ServerManager {
  constructor({ onStatus } = {}) {
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this._child = null;   // ChildProcess spawned by THIS instance (owned)
    this._registryFile = null; // registry merged on ready (own entry removed on stop)
    this._stopping = false; // true while a deliberate stop() is in progress
    this._lastSpawnPort = null; // last port we spawned on; forces a fresh port each spawn
    // Per-PROCESS random base so consecutive VS Code runs don't reuse the same
    // origin (see ensureServer); keeps DSH webview localStorage fresh per launch.
    this._spawnFloor = null;
  }

  /**
   * Report a lifecycle transition. Callback errors are swallowed so a broken
   * UI listener can never break the manager.
   */
  _emit(state, message, server) {
    try {
      const payload = { state, message };
      if (server) payload.server = server;
      this.onStatus(payload);
    } catch {
      // ignore listener errors
    }
  }

  /**
   * Probe host:port with GET / and a 3s timeout. Redirects are never
   * followed (http.request default behavior — no manual following either).
   * Returns:
   *   { reachable: true,  isDsh: true  } — HTTP 200 + BOOT_MARKER in body
   *   { reachable: true,  isDsh: false } — responded, but no BOOT_MARKER
   *   { reachable: false }               — connection failed / timed out
   */
  async probe(host, port) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (!done) { done = true; resolve(result); }
      };

      const req = http.request(
        {
          host,
          port,
          path: '/',
          method: 'GET',
          timeout: PROBE_TIMEOUT_MS,
          // One-off agent: sockets are not pooled, so probes never keep a
          // server (or the extension process) alive after they finish.
          agent: false,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < MAX_BODY_BYTES) body += chunk; // bounded read
          });
          res.on('end', () => {
            finish({
              reachable: true,
              isDsh: res.statusCode === 200 && body.includes(BOOT_MARKER),
            });
          });
          res.on('error', () => finish({ reachable: true, isDsh: false }));
        }
      );

      req.on('timeout', () => {
        // Timed out: destroy the socket so 'error' fires and we resolve as unreachable.
        req.destroy(new Error('probe timeout'));
      });
      req.on('error', () => finish({ reachable: false }));
      req.end();
    });
  }

  /**
   * Probe with retries: call probe() up to `attempts` times. The first result
   * with reachable===true (regardless of isDsh) is returned immediately — a
   * reachable answer is definitive, so a busy-but-alive service is never
   * classified as unreachable. Only when every attempt is unreachable is the
   * last result returned. Used by ensureServer before deciding to spawn, to
   * prevent duplicate instances when DSH is busy (e.g. streaming a reply) and
   * a single probe would time out.
   */
  async probeWithRetry(host, port, { attempts = 3, delayMs = 400 } = {}) {
    const n = Math.max(1, attempts); // at least one attempt, even for 0/negative input
    let last = null;
    for (let i = 0; i < n; i++) {
      last = await this.probe(host, port);
      if (last.reachable) return last;
      if (i < n - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return last;
  }

  /**
   * Equivalent to probe(), but returns a simple boolean: is this URL a live DSH?
   * Single-shot by design — meant for fast, cheap polling (e.g. the health
   * poll after spawn); use probeWithRetry() when a definitive answer is needed.
   */
  async healthCheck(url) {
    let host;
    let port;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    } catch {
      return false;
    }
    const result = await this.probe(host, port);
    return Boolean(result.isDsh);
  }

  /**
   * Ensure a DSH web service is available at host:port, matched to the
   * calling VS Code window's workspace via the instance registry.
   *  - Read the registry first (dead entries filtered; nothing is killed).
   *  - If DSH is already running on host:port:
   *      a) autoStart === false → always reuse (the user manages instances);
   *      b) cwd is null/undefined/empty (this window has no workspace) → reuse;
   *      c) otherwise reuse ONLY when the registry has a port-matching entry
   *         whose cwd is non-empty and samePath(entry.cwd, cwd). A mismatch
   *         or a missing entry (e.g. manually started instance, cwd unknown)
   *         → do NOT reuse: spawn on the next free port (scan from port + 1).
   *  - Non-DSH occupant → spawn (scan from port + 1); unreachable → spawn
   *    (scan from port itself).
   *  - autoStart === false when reuse is impossible (non-DSH occupant or
   *    unreachable) → throw the original error message.
   *  - On spawn success the { pid, port, host, cwd, at } entry is merged into
   *    the registry (same-port entry replaced, others kept).
   *  - cwd: DSH workspace root directory (used as the spawn cwd); null /
   *    undefined / empty string = not specified — the child inherits the
   *    parent process's cwd (no fallback to the user home directory).
   *  - registryFile: path of the instance registry (JSON array of entries).
   *  - Returns a RunningServer: { url, host, port, pid, owned }.
   */
  async ensureServer({ host = DEFAULT_HOST, port = DEFAULT_PORT, autoStart = true, cwd, registryFile } = {}) {
    this._emit('probing', `正在探测 DSH 服务: http://${host}:${port} …`);

    // Step 1: read the registry (dead entries filtered in memory, no kills).
    const registry = registryFile ? ServerManager._readRegistry(registryFile) : [];

    // Step 2: probe the configured port (with retries against transient busyness).
    const r = await this.probeWithRetry(host, port);

    // Step 3: decide reuse vs spawn.
    if (r.reachable && r.isDsh) {
      const noWorkspace = cwd === null || cwd === undefined || cwd === '';
      if (!autoStart || noWorkspace) {
        // (a) user-managed instance, or (b) this window has no workspace.
        this._emit('reusing', `检测到本地 DSH web 服务: http://${host}:${port}，直接复用`);
        return { url: `http://${host}:${port}`, host, port, pid: null, owned: false };
      }
      // (c) reuse only when the registry proves this port belongs to our cwd.
      const entry = registry.find((e) => e && e.port === port);
      if (entry && typeof entry.cwd === 'string' && entry.cwd !== '' && ServerManager.samePath(entry.cwd, cwd)) {
        this._emit('reusing', `检测到匹配工作区的 DSH 实例: http://${host}:${port}，复用`);
        return { url: `http://${host}:${port}`, host, port, pid: null, owned: false };
      }
      // No matching entry (e.g. manually started DSH whose cwd is unknown) →
      // treat it as NOT ours and spawn a dedicated instance below.
    }

    if (!autoStart) {
      throw new Error('DSH 服务未运行且 dsh.autoStart 已关闭');
    }

    // Occupied port (DSH-with-wrong-workspace or a non-DSH service) must not
    // be reused → scan from port + 1; a dead port → scan from port itself.
    // Also avoid reusing a port we already spawned on this session: DSH's web
    // UI keeps its "current workspace" in localStorage keyed by origin (=port),
    // so a reused port would carry a stale active folder into the new instance
    // and the freshly-bound cwd would not surface. A fresh port each spawn
    // yields a fresh origin (empty localStorage) → the bound workspace wins.
    let scanStart = r.reachable ? port + 1 : port;
    if (this._spawnFloor === null) {
      // Randomize the first spawn upward so different VS Code runs (and thus
      // webview origins) don't collide → the DSH UI's per-origin localStorage
      // "current workspace" stays empty, letting our bound cwd surface.
      this._spawnFloor = port + 1 + Math.floor(Math.random() * 60);
    }
    if (this._spawnFloor > scanStart) scanStart = this._spawnFloor;
    if (this._lastSpawnPort !== null && this._lastSpawnPort >= scanStart) {
      scanStart = this._lastSpawnPort + 1; // never reuse a port this process rented
    }
    const freePort = await this._findFreePort(host, scanStart);
    this._lastSpawnPort = freePort;
    this._spawnFloor = freePort + 1;
    return this._spawnAndWait(host, freePort, cwd, registryFile);
  }

  /**
   * Scan forward from startPort (inclusive) for up to PORT_SCAN_LIMIT ports;
   * the first port where probe() reports reachable:false is considered free.
   */
  async _findFreePort(host, startPort) {
    for (let i = 0; i < PORT_SCAN_LIMIT; i++) {
      const candidate = startPort + i;
      const probeResult = await this.probe(host, candidate);
      if (!probeResult.reachable) return candidate;
    }
    throw new Error(`在 ${startPort} 起向后 ${PORT_SCAN_LIMIT} 个端口内未找到空闲端口`);
  }

  /**
   * Resolve the spawn working directory from the caller-provided cwd.
   * null / undefined / empty string mean "not specified" → undefined, so the
   * spawned child inherits the parent process's cwd; any other value passes
   * through unchanged. There is deliberately NO fallback to USERPROFILE/HOME.
   */
  _resolveSpawnCwd(cwd) {
    return cwd === null || cwd === undefined || cwd === '' ? undefined : cwd;
  }

  /**
   * Compare two paths for "same directory". Windows: path.resolve-normalized
   * and case-insensitive (tolerates drive-case and trailing-slash
   * differences); other platforms: plain path.resolve equality.
   */
  static samePath(a, b) {
    if (a === b) return true;
    if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
    try {
      if (process.platform === 'win32') {
        return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
      }
      return path.resolve(a) === path.resolve(b);
    } catch {
      return false;
    }
  }

  /**
   * Existence check for a pid. NEVER kills anything — the process may belong
   * to another VS Code window. Windows: tasklist /FI is the primary check; if
   * tasklist cannot run (e.g. a sandboxed test environment), fall back to the
   * portable process.kill(pid, 0) probe. ESRCH ⇒ definitely gone (false);
   * anything undeterminable (EPERM, tasklist failure) ⇒ keep (true).
   */
  static _isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (process.platform === 'win32') {
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        // CSV line looks like "node.exe","1234",... — the pid appears quoted.
        return out.includes(`,"${pid}",`);
      } catch {
        // tasklist unavailable: use the portable existence probe instead.
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return !(err && err.code === 'ESRCH');
        }
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return !(err && err.code === 'ESRCH');
    }
  }

  /** Parse the registry file as-is; [] when missing/unparseable; a legacy single-object file is wrapped. */
  static _readRegistryRaw(registryFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
      return [];
    } catch {
      return [];
    }
  }

  /** Read the registry, dropping entries whose process is dead (never kills). */
  static _readRegistry(registryFile) {
    return ServerManager._readRegistryRaw(registryFile).filter(
      (e) => e && ServerManager._isProcessAlive(e.pid)
    );
  }

  /** Best-effort write of the registry array (creates the parent directory). */
  static _writeRegistry(registryFile, entries) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(registryFile)), { recursive: true });
      fs.writeFileSync(registryFile, JSON.stringify(entries, null, 2) + '\n');
    } catch {
      // registry persistence is best-effort bookkeeping
    }
  }

  /** Merge one entry into the registry: replaces any same-port entry, keeps the rest. */
  static _mergeRegistry(registryFile, entry) {
    if (!registryFile) return;
    const entries = ServerManager._readRegistry(registryFile).filter(
      (e) => !(e && e.port === entry.port)
    );
    entries.push(entry);
    ServerManager._writeRegistry(registryFile, entries);
  }

  /** Remove ONLY the entry with the given pid; other windows' entries stay. */
  static _removeRegistryEntry(registryFile, pid) {
    if (!registryFile) return;
    const entries = ServerManager._readRegistryRaw(registryFile).filter(
      (e) => !(e && e.pid === pid)
    );
    ServerManager._writeRegistry(registryFile, entries);
  }

  /**
   * Spawn the `dsh` CLI (cmd shim on Windows) and poll until the service is
   * ready, the process exits early, or the 30s deadline passes. The spawn cwd
   * follows the ensureServer contract: only an explicitly provided cwd is
   * used; otherwise the child inherits the extension host's current directory.
   */
  _spawnAndWait(host, port, cwd, registryFile) {
    const isWindows = process.platform === 'win32';
    const spawnCwd = this._resolveSpawnCwd(cwd);
    // On Windows `dsh` is a cmd shim, so it must go through cmd.exe /c.
    // Include the cwd option ONLY when explicitly requested; otherwise omit it
    // entirely so the child inherits the parent process's current directory
    // (no fallback to the user home directory).
    const opts = {
      stdio: 'ignore',
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
    };
    const child = isWindows
      ? spawn('cmd.exe', ['/c', 'dsh', 'web', '--host', host, '--port', String(port)], {
          ...opts,
          windowsHide: true,
        })
      : // POSIX: detached puts the child in its own process group so the whole
        // tree (dsh web and any workers it spawns) can be SIGTERMed via
        // kill(-pid) in _killChild. The child keeps running if the extension
        // host dies, exactly like the Windows taskkill-tree behavior.
        spawn('dsh', ['web', '--host', host, '--port', String(port)], {
          ...opts,
          detached: true,
        });

    this._child = child;
    this._emit('starting', `正在启动 DSH web 服务 (pid=${child.pid}, port=${port}) …`);

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      let settled = false;

      // Persistent listener: any exit NOT caused by stop() is unexpected and
      // reported through onStatus (e.g. the service crashed after becoming ready).
      const onUnexpectedExit = (code, signal) => {
        if (this._stopping) return;        // deliberate stop()
        if (this._child !== child) return; // already detached (timeout cleanup)
        this._child = null;
        this._emit('error', `DSH 进程意外退出 (pid=${child.pid}, code=${code}, signal=${signal})`);
      };
      child.on('exit', onUnexpectedExit);

      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        this._emit('error', `启动 dsh 失败: ${err.message}`);
        reject(new Error(`启动 dsh 失败: ${err.message}`));
      });

      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        const reason = this._stopping ? '已被手动停止' : `提前退出 (code=${code}, signal=${signal})`;
        reject(new Error(`DSH 进程${reason}`));
      });

      const poll = async () => {
        if (settled) return;
        const probeResult = await this.probe(host, port);
        if (settled) return;

        if (probeResult.reachable && probeResult.isDsh) {
          settled = true;
          resolve(this._finalizeReady(host, port, cwd, child.pid, registryFile));
          return;
        }

        if (Date.now() >= deadline) {
          settled = true;
          this._child = null;
          child.removeListener('exit', onUnexpectedExit);
          await this._killChild(child); // best-effort cleanup of the hung process
          const exitInfo = child.exitCode !== null ? `, exit code=${child.exitCode}` : '';
          reject(new Error(`DSH 服务启动超时（${HEALTH_TIMEOUT_MS / 1000}s 内未就绪），已终止进程 (pid=${child.pid}${exitInfo})`));
          return;
        }

        setTimeout(poll, HEALTH_POLL_MS);
      };

      poll();
    });
  }

  /**
   * After the service is healthy: merge this instance's entry into the
   * registry (same-port entry replaced, others kept), emit {state:"ready"}
   * and return the RunningServer object.
   */
  _finalizeReady(host, port, cwd, pid, registryFile) {
    this._registryFile = registryFile || null;
    if (registryFile) {
      const entryCwd = cwd === null || cwd === undefined || cwd === '' ? null : cwd;
      ServerManager._mergeRegistry(registryFile, { pid, port, host, cwd: entryCwd, at: Date.now() });
    }
    const server = { url: `http://${host}:${port}`, host, port, pid, owned: true };
    this._emit('ready', `DSH web 服务已就绪: http://${host}:${port} (pid=${pid})`, server);
    return server;
  }

  /**
   * Kill a child process. On Windows the spawned dsh is a cmd.exe wrapper,
   * so taskkill /T /F kills the whole tree and the promise resolves when
   * taskkill exits. On POSIX the child was spawned detached (its pid is the
   * process-group id), so SIGTERM the group first — dsh web and any workers
   * it spawned all die — then fall back to the single process.
   */
  _killChild(child) {
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('error', () => resolve());
        killer.once('exit', () => resolve());
      });
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
    return Promise.resolve();
  }

  /**
   * Stop the instance: kill whatever this instance spawned, remove ONLY this
   * instance's entry from the registry (other windows' entries stay) and
   * clear internal records. Safe to call when nothing was spawned.
   */
  async stop() {
    this._emit('stopping', '正在停止 DSH 进程 …');
    this._stopping = true;

    const child = this._child;
    if (child) {
      await this._killChild(child);
      // Fallback: if the child has not exited yet (e.g. taskkill failed),
      // force-kill it directly.
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* ignore */ }
      }
    }

    // Remove ONLY our own entry (matched by the pid we spawned); entries of
    // other VS Code windows must survive.
    if (this._registryFile && child) {
      ServerManager._removeRegistryEntry(this._registryFile, child.pid);
    }

    this._child = null;
    this._registryFile = null;
    this._stopping = false;

    this._emit('stopped', child ? 'DSH 进程已停止' : '没有由本实例启动的进程');
  }

  /**
   * Clean up a stale registry file: read it, write back only the entries
   * whose process is still alive, and NEVER kill any process (a live DSH may
   * belong to another VS Code window). A missing or corrupt file is removed.
   */
  static cleanupStaleRegistry(registryFile) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    } catch {
      parsed = null; // missing or unparseable
    }
    if (!Array.isArray(parsed)) {
      // Missing / corrupt / legacy single-object file: nothing to salvage —
      // remove it (best effort). A missing file raises ENOENT — ignored.
      try { fs.unlinkSync(registryFile); } catch { /* ignore */ }
      return;
    }
    const alive = parsed.filter((e) => e && ServerManager._isProcessAlive(e.pid));
    if (alive.length !== parsed.length) {
      ServerManager._writeRegistry(registryFile, alive);
    }
  }

  /**
   * Backward-compatible alias of cleanupStaleRegistry (legacy name used by
   * extension.js). NOTE: unlike the old behavior it never kills anything.
   */
  static cleanupStalePid(registryFile) {
    return ServerManager.cleanupStaleRegistry(registryFile);
  }
}

module.exports = { ServerManager };

// ---------------------------------------------------------------------------
// Self-test (only runs when this file is executed directly):
//   node src/serverManager.js
// Verifies probe detection (DSH vs non-DSH vs closed port), probeWithRetry
// recovery from a busy/hanging DSH, the forward port scan, registry-based
// workspace matching (reuse vs spawn branch), dead-entry filtering, samePath,
// _resolveSpawnCwd, cleanupStaleRegistry safety and the no-op stop(). It
// NEVER spawns a real dsh process and never touches port 3080.
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const assert = require('node:assert');
    const os = require('node:os');

    // --- Fixture servers on random high ports (listen(0) => OS-assigned).
    const dshServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><script>window.__DSH_BOOT__={config:{}}</script></head></html>');
    });
    await new Promise((resolve) => dshServer.listen(0, '127.0.0.1', resolve));
    const dshPort = dshServer.address().port;
    assert.notStrictEqual(dshPort, 3080, 'self-test port must never collide with the real DSH web port');

    const plainServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    await new Promise((resolve) => plainServer.listen(0, '127.0.0.1', resolve));
    const plainPort = plainServer.address().port;
    assert.notStrictEqual(plainPort, 3080);
    assert.notStrictEqual(plainPort, dshPort);

    // Guaranteed-closed port: bind, note the port, close, then probe it.
    const temp = http.createServer();
    await new Promise((resolve) => temp.listen(0, '127.0.0.1', resolve));
    const closedPort = temp.address().port;
    await new Promise((resolve) => temp.close(resolve));

    const mgr = new ServerManager();

    // 1. probe: DSH, non-DSH, closed port.
    const pDsh = await mgr.probe('127.0.0.1', dshPort);
    assert.deepStrictEqual(pDsh, { reachable: true, isDsh: true });
    const pPlain = await mgr.probe('127.0.0.1', plainPort);
    assert.deepStrictEqual(pPlain, { reachable: true, isDsh: false });
    const pClosed = await mgr.probe('127.0.0.1', closedPort);
    assert.deepStrictEqual(pClosed, { reachable: false });

    // 2. healthCheck mirrors probe as a boolean.
    assert.strictEqual(await mgr.healthCheck(`http://127.0.0.1:${dshPort}/`), true);
    assert.strictEqual(await mgr.healthCheck(`http://127.0.0.1:${plainPort}/`), false);

    // 3. Port scan skips the occupied port and finds a free one.
    const freePort = await mgr._findFreePort('127.0.0.1', plainPort);
    assert.ok(freePort > plainPort && freePort <= plainPort + PORT_SCAN_LIMIT, `free=${freePort}`);
    const pFree = await mgr.probe('127.0.0.1', freePort);
    assert.strictEqual(pFree.reachable, false);

    // 4. ensureServer reuses a detected DSH (no spawn).
    const statuses = [];
    const mgr2 = new ServerManager({ onStatus: (s) => statuses.push(s.state) });
    const reused = await mgr2.ensureServer({ host: '127.0.0.1', port: dshPort, autoStart: false });
    assert.deepStrictEqual(reused, { url: `http://127.0.0.1:${dshPort}`, host: '127.0.0.1', port: dshPort, pid: null, owned: false });
    assert.deepStrictEqual(statuses, ['probing', 'reusing']);

    // 5. autoStart:false on a non-DSH port throws the contract error.
    await assert.rejects(
      mgr2.ensureServer({ host: '127.0.0.1', port: plainPort, autoStart: false }),
      /autoStart/
    );

    // 6. cleanupStalePid is safe on a missing / unparseable pid file.
    const missingPid = path.join(os.tmpdir(), `dsh-stale-missing-${process.pid}-${Date.now()}.json`);
    assert.doesNotThrow(() => ServerManager.cleanupStalePid(missingPid));
    const badPid = path.join(os.tmpdir(), `dsh-stale-bad-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(badPid, 'this is not json');
    assert.doesNotThrow(() => ServerManager.cleanupStalePid(badPid));
    assert.strictEqual(fs.existsSync(badPid), false, 'stale pid file should be deleted');

    // 7. stop() is a safe no-op when nothing was spawned.
    const stopStatuses = [];
    const mgr3 = new ServerManager({ onStatus: (s) => stopStatuses.push(s.state) });
    await mgr3.stop();
    assert.deepStrictEqual(stopStatuses, ['stopping', 'stopped']);

    // 8. probeWithRetry recovers where a single probe misjudges: the fixture
    //    hangs the FIRST request (past the 3s probe timeout) and only answers
    //    the SECOND with the DSH boot marker (added time ~3s).
    let slowHits = 0;
    const slowDshServer = http.createServer((req, res) => {
      slowHits += 1;
      if (slowHits === 1) {
        return; // first request: never respond — the client probe times out
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><script>window.__DSH_BOOT__={}</script>');
    });
    await new Promise((resolve) => slowDshServer.listen(0, '127.0.0.1', resolve));
    const slowDshPort = slowDshServer.address().port;
    assert.notStrictEqual(slowDshPort, 3080);

    const singleProbe = await mgr.probe('127.0.0.1', slowDshPort); // hits the hang -> unreachable
    assert.deepStrictEqual(singleProbe, { reachable: false });
    const retried = await mgr.probeWithRetry('127.0.0.1', slowDshPort, { attempts: 3, delayMs: 400 });
    assert.deepStrictEqual(retried, { reachable: true, isDsh: true });

    // 9. Unit-check the retry loop itself (no network): the first two probe()
    //    attempts are unreachable, the third succeeds -> reachable is returned.
    class FlakyProbe extends ServerManager {
      constructor() {
        super();
        this.calls = 0;
      }
      async probe() {
        this.calls += 1;
        if (this.calls < 3) return { reachable: false };
        return { reachable: true, isDsh: true };
      }
    }
    const flaky = new FlakyProbe();
    const flakyResult = await flaky.probeWithRetry('127.0.0.1', 1, { attempts: 3, delayMs: 10 });
    assert.deepStrictEqual(flakyResult, { reachable: true, isDsh: true });
    assert.strictEqual(flaky.calls, 3, 'retry loop must call probe() attempts times');

    // 10. _resolveSpawnCwd: null/undefined/empty string -> undefined (inherit
    //     parent cwd); real paths pass through unchanged.
    const spawnCwdCases = [
      [null, undefined],
      [undefined, undefined],
      ['', undefined],
      ['D:\\ws', 'D:\\ws'],
      ['/home/user/ws', '/home/user/ws'],
    ];
    for (const [input, expected] of spawnCwdCases) {
      assert.strictEqual(
        mgr._resolveSpawnCwd(input),
        expected,
        `_resolveSpawnCwd(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`
      );
    }

    // 11. samePath: normalize + (win32) case-insensitive comparison.
    if (process.platform === 'win32') {
      assert.strictEqual(ServerManager.samePath('D:\\Coding', 'D:\\Coding\\'), true);
      assert.strictEqual(ServerManager.samePath('D:\\Coding', 'd:\\coding'), true);
      assert.strictEqual(ServerManager.samePath('D:\\Coding', 'D:\\Other'), false);
      assert.strictEqual(ServerManager.samePath('D:\\Coding', ''), false);
    } else {
      assert.strictEqual(ServerManager.samePath('/home/u/ws', '/home/u/ws/'), true);
      assert.strictEqual(ServerManager.samePath('/home/u/ws', '/home/u/other'), false);
    }

    // 12. Registry-based workspace matching (fixture DSH + pre-seeded registry):
    //     matching cwd -> reuse; different cwd -> spawn branch (NoSpawnMgr
    //     proves the branch is entered WITHOUT spawning); no cwd -> reuse.
    const regFile = path.join(os.tmpdir(), `dsh-registry-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(regFile, JSON.stringify([
      { pid: process.pid, port: dshPort, host: '127.0.0.1', cwd: 'D:\\A', at: Date.now() },
    ], null, 2));
    class NoSpawnMgr extends ServerManager {
      constructor() {
        super();
        this.spawnBranch = false;
      }
      async _spawnAndWait() {
        this.spawnBranch = true;
        throw new Error('spawn-branch-reached');
      }
    }
    const noSpawn = new NoSpawnMgr();
    const reusedMatch = await noSpawn.ensureServer({ host: '127.0.0.1', port: dshPort, cwd: 'D:\\A', registryFile: regFile });
    assert.deepStrictEqual(reusedMatch, { url: `http://127.0.0.1:${dshPort}`, host: '127.0.0.1', port: dshPort, pid: null, owned: false });
    assert.strictEqual(noSpawn.spawnBranch, false, 'matching workspace must reuse, not spawn');
    await assert.rejects(
      noSpawn.ensureServer({ host: '127.0.0.1', port: dshPort, cwd: 'D:\\B', registryFile: regFile }),
      /spawn-branch-reached/
    );
    assert.strictEqual(noSpawn.spawnBranch, true, 'cwd mismatch must enter the spawn branch');
    noSpawn.spawnBranch = false; // reset the sticky flag before the reuse-only call
    const reusedNull = await noSpawn.ensureServer({ host: '127.0.0.1', port: dshPort, cwd: null, registryFile: regFile });
    assert.deepStrictEqual(reusedNull, { url: `http://127.0.0.1:${dshPort}`, host: '127.0.0.1', port: dshPort, pid: null, owned: false });
    assert.strictEqual(noSpawn.spawnBranch, false, 'no workspace must reuse unconditionally');

    // 13. Dead-entry filtering + cleanupStaleRegistry (never kills anything).
    const deadPid = 99999999; // (almost certainly) not running
    const regDead = path.join(os.tmpdir(), `dsh-registry-dead-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(regDead, JSON.stringify([
      { pid: deadPid, port: 32000, host: '127.0.0.1', cwd: null, at: Date.now() },
    ], null, 2));
    assert.deepStrictEqual(ServerManager._readRegistry(regDead), [], 'dead entry must be filtered out');

    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    sleeper.unref();
    const regLive = path.join(os.tmpdir(), `dsh-registry-live-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(regLive, JSON.stringify([
      { pid: sleeper.pid, port: 32001, host: '127.0.0.1', cwd: 'D:\\Live', at: Date.now() },
    ], null, 2));
    const liveEntries = ServerManager._readRegistry(regLive);
    assert.strictEqual(liveEntries.length, 1, 'live entry must be kept');
    assert.strictEqual(liveEntries[0].pid, sleeper.pid);
    assert.strictEqual(sleeper.exitCode, null, 'reading the registry must never kill a live process');
    ServerManager.cleanupStaleRegistry(regLive);
    assert.strictEqual(JSON.parse(fs.readFileSync(regLive, 'utf8')).length, 1, 'cleanup keeps live entries');
    assert.strictEqual(sleeper.exitCode, null, 'cleanup must never kill live processes');
    ServerManager.cleanupStaleRegistry(regDead);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(regDead, 'utf8')), [], 'cleanup rewrites registry without dead entries');

    // 14. stop() removes ONLY this instance's registry entry.
    const regStop = path.join(os.tmpdir(), `dsh-registry-stop-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(regStop, JSON.stringify([
      { pid: 41001, port: 32010, host: '127.0.0.1', cwd: 'D:\\Own', at: 1 },
      { pid: 41002, port: 32011, host: '127.0.0.1', cwd: 'D:\\Other', at: 2 },
    ], null, 2));
    const fakeChild = { pid: 41001, exitCode: 1, signalCode: null, kill() {} };
    class NoKillMgr extends ServerManager {
      async _killChild() { /* never really kill */ }
    }
    const noKill = new NoKillMgr();
    noKill._child = fakeChild;
    noKill._registryFile = regStop;
    await noKill.stop();
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(regStop, 'utf8')),
      [{ pid: 41002, port: 32011, host: '127.0.0.1', cwd: 'D:\\Other', at: 2 }],
      "stop() must keep other windows' entries"
    );

    // --- Cleanup: close fixture servers, stop the helper child, drop temp files.
    await new Promise((resolve) => plainServer.close(resolve));
    await new Promise((resolve) => dshServer.close(resolve));
    await new Promise((resolve) => {
      slowDshServer.close(() => resolve());
      slowDshServer.closeAllConnections?.(); // force-close any lingering probe sockets
    });
    if (sleeper && sleeper.exitCode === null) {
      try { sleeper.kill(); } catch { /* ignore */ }
    }
    for (const p of [regFile, regDead, regLive, regStop]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }

    console.log('All self-tests passed.');
    console.log(`  probe DSH    (port ${dshPort}) = ${JSON.stringify(pDsh)}`);
    console.log(`  probe plain  (port ${plainPort}) = ${JSON.stringify(pPlain)}`);
    console.log(`  probe closed (port ${closedPort}) = ${JSON.stringify(pClosed)}`);
    console.log('  healthCheck DSH = true, non-DSH = false');
    console.log(`  port scan skipped occupied ${plainPort} -> free ${freePort}`);
    console.log(`  ensureServer reuse statuses = ${JSON.stringify(statuses)}`);
    console.log('  autoStart:false on non-DSH port rejected as expected');
    console.log('  cleanupStalePid safe (missing + unparseable), stale file removed');
    console.log(`  stop() no-op statuses = ${JSON.stringify(stopStatuses)}`);
    console.log(`  probeWithRetry: single probe misjudged hanging DSH as ${JSON.stringify(singleProbe)}, retried -> ${JSON.stringify(retried)} (port ${slowDshPort})`);
    console.log(`  probeWithRetry retry loop: ${flaky.calls} probe() calls, first two unreachable -> ${JSON.stringify(flakyResult)}`);
    console.log('  _resolveSpawnCwd: null/undefined/"" -> undefined (inherit), paths pass through (5 cases OK)');
    console.log('  samePath: win32 case/trailing-slash-insensitive, other platforms resolve-equal (cases OK)');
    console.log('  registry matching: cwd match -> reuse, mismatch -> spawn branch, no cwd -> reuse');
    console.log('  dead-entry filtering: dead pid dropped, live pid kept & never killed; cleanupStaleRegistry rewrites');
    console.log('  stop() removed only its own registry entry, kept others');
  })().catch((err) => {
    console.error('Self-test FAILED:', err);
    process.exitCode = 1;
  });
}
