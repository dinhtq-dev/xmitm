/**
 * admin-server.js — Standalone Admin UI server for MITM Proxy control
 *
 * - Runs on http://127.0.0.1:3000
 * - Serves admin.html + REST API
 * - Manages MITM proxy process lifecycle (start/stop via sudo)
 * - Manages DNS hosts entries (add/remove via sudo)
 *
 * npm start → index.js → admin-server.js
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const os = require("os");

const IS_LINUX = process.platform === "linux";
const IS_MAC = process.platform === "darwin";

const { log, err } = require("./logger");
const {
  addDNSEntry,
  removeDNSEntry,
  removeAllDNSEntries,
  checkAllDNSStatus,
  TOOL_HOSTS,
  isSudoAvailable,
  isSudoPasswordRequired,
  isWinElevationRequired,
  execWithPassword,
} = require("./dns/dnsConfig");
const { getMitmAlias } = require("./dbReader");
const { getAllCredentials } = require("./credentials");
const { init: initLogStore, getLogs, clearLogs } = require("./logStore");
const { forwardRequest } = require("./providerRouter");
const { loadAuthStore, saveAuthStore, loadProviders, saveProviders, exportBackup, importBackup, listOAuthConnectionsPublic, removeOAuthConnection, getClientKeys, addClientKey, removeClientKey, getProxies, addProxy, removeProxy } = require("./authStore");
const { listProviderMeta } = require("./providerMeta");
const { listOAuthProvidersPublic } = require("./oauth/registry");
const { buildAuthorizeUrl, handleCallback, refreshConnection } = require("./oauth/flow");
const { listLocalLoginProviders, importLocalOAuth } = require("./oauth/localImport");
const { checkAllProviders, checkProviderKeyAtIndex, clearQuotaCache } = require("./providerQuota");
const opencodeSession = require("./opencode/sessionProvider");
const {
  loadConverterToggles,
  saveConverterToggles,
  setApiProxyClient,
  getApiProxyClient,
  listApiProxyMeta,
  TOGGLES_FILE,
  CLIENT_TOOLS,
} = require("./converters");

// Initialize log store at startup
initLogStore();

// Sync stored DNS config with actual hosts file on startup
function syncDNSConfigWithHosts() {
  try {
    const store = loadAuthStore();
    const actualHosts = checkAllDNSStatus();
    let updated = false;

    if (!store.dns) {
      store.dns = {};
    }

    for (const [tool, isPresent] of Object.entries(actualHosts)) {
      if (isPresent && !store.dns[tool]) {
        store.dns[tool] = true;
        updated = true;
        log(`🔄 [DNS Startup Sync] Detected '${tool}' DNS entries in hosts file — updating config to ON`);
      }
    }

    if (updated) {
      saveAuthStore(store);
    }
  } catch (error) {
    err(`[DNS Startup Sync] Failed: ${error.message}`);
  }
}
syncDNSConfigWithHosts();

// ── Constants ───────────────────────────────────────────────────
const ADMIN_PORT = 3000;
const MITM_PORT = 443;
const IS_WIN = process.platform === "win32";
const HOST = "127.0.0.1";

// ── State ───────────────────────────────────────────────────────
let mitmProcess = null;   // sudo/spawned process reference
let mitmPid = null;        // sudo PID (from spawn)
let mitmRealPid = null;    // actual node process PID (from health check)
let cachedSudoPassword = null;
let mitmStopping = false;  // flag to prevent health check false-positive while stopping
let mitmRestartTimer = null;
let mitmRestartAttempts = 0;
let mitmWasHealthy = false;
const MITM_RESTART_MAX = 5;
const MITM_RESTART_COOLDOWN_MS = 5000;
const MITM_HEALTH_WATCH_MS = 15000;

// ── Utilities ───────────────────────────────────────────────────

function shellQuote(str) {
  if (str == null || str === "") return "''";
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

function collectBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Build a command to kill processes listening on a given port.
 * Uses fuser on Linux, lsof on macOS.
 */
function killPortCmd(port) {
  if (IS_WIN) return `powershell -NonInteractive -WindowStyle Hidden -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`;
  if (IS_LINUX) return `fuser -k ${port}/tcp 2>/dev/null`;
  if (IS_MAC) return `sh -c 'lsof -ti:${port} | xargs kill -9 2>/dev/null || true'`;
  return `fuser -k ${port}/tcp 2>/dev/null || true`;
}

function readEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  try {
    const text = fs.readFileSync(envPath, "utf-8");
    const vars = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^(MITM_ROUTER_BASE|ROUTER_API_KEY)\s*=\s*(.*)$/);
      if (m) vars[m[1]] = m[2].trim();
    }
    return vars;
  } catch {
    return {};
  }
}

// ── MITM Health Check ──────────────────────────────────────────

function pollMitmHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: MITM_PORT,
          path: "/_mitm_health",
          method: "GET",
          rejectUnauthorized: false,
        },
        (res) => {
          let body = "";
          res.on("data", (d) => {
            body += d;
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(body);
              if (json.ok === true) resolve({ ok: true, pid: json.pid });
              else reject(new Error("Health check returned not OK"));
            } catch {
              reject(new Error("Invalid health response"));
            }
          });
        }
      );
      req.on("error", () => {
        if (Date.now() < deadline) setTimeout(check, 500);
        else reject(new Error("MITM health timeout"));
      });
      req.end();
    };
    check();
  });
}

// ── MITM Status ────────────────────────────────────────────────

async function getMitmStatus() {
  if (mitmStopping) {
    return { running: false, pid: null };
  }
  // Always verify via health — spawn handle can be stale after crash or admin restart
  try {
    const result = await pollMitmHealth(2000);
    if (result?.pid) mitmRealPid = result.pid;
    return { running: true, pid: result.pid || mitmPid || mitmRealPid };
  } catch {
    if (mitmProcess && !mitmProcess.killed) {
      return { running: true, pid: mitmPid };
    }
    return { running: false, pid: null };
  }
}

function clearMitmRestartTimer() {
  if (mitmRestartTimer) {
    clearTimeout(mitmRestartTimer);
    mitmRestartTimer = null;
  }
}

function scheduleMitmAutoRestart(reason) {
  if (mitmStopping || mitmRestartTimer) return;
  if (mitmRestartAttempts >= MITM_RESTART_MAX) {
    err(`MITM auto-restart gave up after ${MITM_RESTART_MAX} attempts (${reason})`);
    return;
  }
  mitmRestartAttempts++;
  const delay = MITM_RESTART_COOLDOWN_MS * mitmRestartAttempts;
  log(`🔄 MITM stopped unexpectedly (${reason}) — auto-restart in ${delay / 1000}s (${mitmRestartAttempts}/${MITM_RESTART_MAX})`);
  mitmRestartTimer = setTimeout(async () => {
    mitmRestartTimer = null;
    try {
      await startMitmServer(cachedSudoPassword);
      mitmRestartAttempts = 0;
      log("✅ MITM auto-restart succeeded");
    } catch (e) {
      err(`MITM auto-restart failed: ${e.message}`);
      scheduleMitmAutoRestart(e.message);
    }
  }, delay);
}

async function watchMitmHealth() {
  if (mitmStopping || mitmRestartTimer) return;
  const hadManagedProcess = mitmProcess || mitmRealPid;
  if (!hadManagedProcess) return;
  try {
    const health = await pollMitmHealth(3000);
    if (health?.pid) mitmRealPid = health.pid;
  } catch {
    if (mitmStopping) return;
    log("⚠️ MITM health check failed — process may have crashed");
    mitmProcess = null;
    mitmPid = null;
    mitmRealPid = null;
    if (mitmWasHealthy) {
      mitmWasHealthy = false;
      scheduleMitmAutoRestart("health check failed");
    }
  }
}

// ── Start MITM Server ──────────────────────────────────────────

async function startMitmServer(sudoPassword) {
  clearMitmRestartTimer();

  if (mitmProcess && !mitmProcess.killed) {
    throw new Error("MITM server is already running");
  }

  // Reattach if MITM is already listening (e.g. survived admin-server restart)
  try {
    const existing = await pollMitmHealth(2000);
    if (existing?.ok) {
      mitmRealPid = existing.pid || null;
      mitmRestartAttempts = 0;
      mitmWasHealthy = true;
      log(`✅ MITM already running — reattached (PID: ${mitmRealPid || "unknown"})`);
      return { running: true, pid: mitmRealPid, reattached: true };
    }
  } catch {
    // Not running — proceed to spawn
  }

  const password = sudoPassword || cachedSudoPassword;

  // Step 1: Validate sudo password before doing anything
  if (isSudoAvailable() && password) {
    try {
      await execWithPassword("echo ok", password);
    } catch (e) {
      throw new Error("Wrong sudo password. Please check and try again.");
    }
  }

  // Step 2: Build env for MITM child
  const envVars = readEnv();
  const mitmEnv = {
    ...process.env,
    NODE_ENV: "production",
  };
  if (envVars.MITM_ROUTER_BASE) mitmEnv.MITM_ROUTER_BASE = envVars.MITM_ROUTER_BASE;
  if (envVars.ROUTER_API_KEY) mitmEnv.ROUTER_API_KEY = envVars.ROUTER_API_KEY;

  // Step 2: Spawn MITM server
  const serverPath = path.join(__dirname, "server.js");
  log(`🚀 Spawning MITM server: ${serverPath}`);

  const projectRoot = path.join(__dirname, "..");
  if (IS_WIN) {
    mitmProcess = spawn(process.execPath, [serverPath], {
      detached: true,
      windowsHide: true,
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: mitmEnv,
    });
    mitmProcess.unref();
  } else if (isSudoAvailable()) {
    const inlineCmd = [
      `HOME=${shellQuote(os.homedir())}`,
      `NODE_ENV=production`,
      envVars.MITM_ROUTER_BASE ? `MITM_ROUTER_BASE=${shellQuote(envVars.MITM_ROUTER_BASE)}` : "",
      envVars.ROUTER_API_KEY ? `ROUTER_API_KEY=${shellQuote(envVars.ROUTER_API_KEY)}` : "",
      `exec ${shellQuote(process.execPath)}`,
      shellQuote(serverPath),
    ]
      .filter(Boolean)
      .join(" ");
    // Use sudo -S (no -E: preserve-env flag triggers extra auth checks that break piped passwords)
    // The env vars are already set inline in the command string.
    // Linux: `setsid sh -c 'inlineCmd'` creates a new session so process survives parent exit.
    //         inlineCmd already contains `exec` (a shell built-in) to replace sh with node.
    // macOS: no setsid command; `detached:true` in spawn + `exec` is sufficient.
    const shellCmd = IS_MAC ? `exec ${inlineCmd}` : `setsid sh -c ${shellQuote(inlineCmd)}`;
    mitmProcess = spawn("sudo", ["-S", "sh", "-c", shellCmd], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    mitmProcess.stdin.write(`${password}\n`);
    mitmProcess.stdin.end();
  } else {
    // No sudo (Docker/minimal env)
    mitmProcess = spawn(process.execPath, [serverPath], {
      detached: true,
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: mitmEnv,
    });
    mitmProcess.unref();
  }

  mitmPid = mitmProcess.pid;
  log(`🔧 MITM process spawned (PID: ${mitmPid})`);

  // Track password errors from stderr for API feedback
  let spawnPasswordError = false;

  // Forward stdout/stderr
  mitmProcess.stdout.on("data", (data) => {
    process.stdout.write(data);
  });
  mitmProcess.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    // Detect wrong password from sudo's stderr
    if (msg.includes("incorrect password") || msg.includes("Sorry, try again") || msg.includes("no password was provided")) {
      spawnPasswordError = true;
      cachedSudoPassword = null;
      return; // don't forward sudo's password noise to visible stderr
    }
    // Filter sudo password prompt noise
    if (msg && !msg.includes("Password:") && !msg.includes("password for")) {
      process.stderr.write(data);
    }
  });

  let spawnExitCode = null;
  mitmProcess.on("exit", (code, signal) => {
    spawnExitCode = code;
    const sig = signal ? `, signal: ${signal}` : "";
    log(`MITM server exited (code: ${code}${sig})`);
    mitmProcess = null;
    mitmPid = null;
    mitmRealPid = null;
    if (!mitmStopping && mitmWasHealthy) {
      mitmWasHealthy = false;
      scheduleMitmAutoRestart(`exit code ${code}${sig}`);
    }
  });

  // Step 3: Wait for health
  log("⏳ Waiting for MITM server to become healthy...");
  let health;
  try {
    health = await pollMitmHealth(12000);
    if (!health) throw new Error("Health check returned no result");
  } catch (e) {
    // If password was wrong, give clear feedback
    if (spawnPasswordError) {
      throw new Error("Wrong sudo password. Please check and try again.");
    }
    // If process exited early (e.g. wrong password), skip timeout wait
    if (spawnExitCode !== null) {
      throw new Error(`MITM server failed to start (exit code: ${spawnExitCode})`);
    }
    // Kill if startup failed
    if (mitmProcess && !mitmProcess.killed) {
      try {
        mitmProcess.kill("SIGKILL");
      } catch { /* ignore */ }
    }
    mitmProcess = null;
    mitmPid = null;
    mitmRealPid = null;
    throw new Error(`MITM server failed to start: ${e.message}`);
  }

  // Store real node PID from health check response
  if (health && health.pid) {
    mitmRealPid = health.pid;
    log(`✅ MITM real node PID: ${mitmRealPid}`);
  }

  if (password) cachedSudoPassword = password;
  mitmRestartAttempts = 0;
  mitmWasHealthy = true;
  log(`✅ MITM server healthy (PID: ${mitmRealPid || mitmPid})`);
  return { running: true, pid: mitmRealPid || mitmPid };
}

// ── Stop MITM Server ───────────────────────────────────────────

async function stopMitmServer(sudoPassword) {
  const password = sudoPassword || cachedSudoPassword;
  mitmStopping = true;
  clearMitmRestartTimer();
  mitmRestartAttempts = 0;
  mitmWasHealthy = false;

  // ── Step 1: Kill actual node process via sudo (it runs as root) ──
  if (mitmRealPid) {
    log(`⏹ Killing MITM node process (real PID: ${mitmRealPid})...`);
    if (password) {
      // Use sudo kill — process.kill cannot kill root-owned processes
      try {
        execSync(
          `echo ${shellQuote(password)} | sudo -S kill ${mitmRealPid} 2>/dev/null; ` +
          `sleep 0.3; ` +
          `echo ${shellQuote(password)} | sudo -S kill -9 ${mitmRealPid} 2>/dev/null || true`,
          { stdio: "ignore", timeout: 5000 }
        );
      } catch { /* best effort */ }
    } else {
      // Try regular kill (may fail for root processes)
      try { process.kill(mitmRealPid, "SIGTERM"); await new Promise(r => setTimeout(r, 200)); } catch {}
      try { process.kill(mitmRealPid, "SIGKILL"); } catch {}
    }
    mitmRealPid = null;
  }

  // ── Step 2: Kill sudo process group (sudo→sh chain) ──
  if (mitmProcess && !mitmProcess.killed) {
    log(`⏹ Stopping MITM sudo process (PID: ${mitmPid})...`);
    try { process.kill(-mitmPid, "SIGTERM"); } catch { try { mitmProcess.kill("SIGTERM"); } catch {} }
    await new Promise(r => setTimeout(r, 300));
    if (mitmProcess && !mitmProcess.killed) {
      try { process.kill(-mitmPid, "SIGKILL"); } catch { try { mitmProcess.kill("SIGKILL"); } catch {} }
    }
    mitmProcess = null;
    mitmPid = null;
  }

  // ── Step 3: Force-kill anything still listening on port 443 ──
  if (IS_WIN) {
    try {
      log("🔪 Force-killing any remaining process on port 443 (Windows)...");
      execSync(killPortCmd(443), { stdio: "ignore", timeout: 5000, windowsHide: true });
    } catch {}
  } else if (password) {
    try {
      log("🔪 Force-killing any remaining process on port 443...");
      const cmd = `echo ${shellQuote(password)} | sudo -S ${killPortCmd(443)}`;
      execSync(cmd, { stdio: "ignore", timeout: 5000 });
    } catch {}
  } else if (IS_LINUX || IS_MAC) {
    try {
      execSync(killPortCmd(443), { stdio: "ignore", timeout: 3000 });
    } catch {}
  }

  // ── Step 4: Wait and verify MITM is actually dead (max 3 attempts) ──
  for (let i = 0; i < 3; i++) {
    try {
      await pollMitmHealth(1000);
      // Still alive — try force-kill once more
      if (IS_WIN) {
        try { execSync(killPortCmd(443), { stdio: "ignore", timeout: 3000, windowsHide: true }); } catch {}
      } else if (password) {
        try {
          execSync(
            `echo ${shellQuote(password)} | sudo -S ${killPortCmd(443)}`,
            { stdio: "ignore", timeout: 3000 }
          );
        } catch {}
      }
    } catch {
      // Health check failed — MITM is down
      break;
    }
  }

  mitmStopping = false;
  return { running: false, pid: null };
}

// ── HTTP Router ────────────────────────────────────────────────

async function handleRequest(req, res) {
  // CORS for localhost
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    // ── Favicon ───────────────────────────────────────────────────
    if (pathname === "/favicon.png" || pathname === "/favicon.ico") {
      const favPath = path.join(__dirname, "favicon.png");
      if (fs.existsSync(favPath)) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
        res.end(fs.readFileSync(favPath));
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    // ── Serve admin.html ──────────────────────────────────────────
    if (pathname === "/" || pathname === "/admin") {
      const html = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      res.end(html);
      return;
    }

    // ── Status API ────────────────────────────────────────────────
    if (pathname === "/api/admin/status" && req.method === "GET") {
      const mitm = await getMitmStatus();
      const dns = checkAllDNSStatus();
      const mappings = {
        cli: getMitmAlias("cli") || {},
        antigravity: getMitmAlias("antigravity") || {},
        copilot: getMitmAlias("copilot") || {},
        kiro: getMitmAlias("kiro") || {},
        cursor: getMitmAlias("cursor") || {},
      };
      
      // Get current version from local package.json (read fresh, no cache)
      let currentVersion = "1.0.0";
      try {
        const pkgRaw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8");
        currentVersion = JSON.parse(pkgRaw).version || "1.0.0";
      } catch {}

      // Fetch the latest version from the master/main package.json on GitHub
      const fetchLatestVersion = () => {
        return new Promise((resolve) => {
          const options = {
            hostname: 'raw.githubusercontent.com',
            port: 443,
            path: '/dinhtq-dev/xmitm/main/package.json',
            method: 'GET',
            headers: {
              'User-Agent': 'xmitm-update-checker'
            },
            timeout: 2500 // Bounded timeout so UI doesn't hang
          };

          const request = https.get(options, (response) => {
            if (response.statusCode !== 200) {
              resolve(currentVersion);
              return;
            }
            let data = "";
            response.on("data", chunk => data += chunk);
            response.on("end", () => {
              try {
                const parsed = JSON.parse(data);
                resolve(parsed.version || currentVersion);
              } catch {
                resolve(currentVersion);
              }
            });
          });

          request.on("error", () => resolve(currentVersion));
          request.on("timeout", () => {
            request.destroy();
            resolve(currentVersion);
          });
        });
      };

      const latestVersion = await fetchLatestVersion();
      const updateAvailable = latestVersion !== currentVersion;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          mitmRunning: mitm.running,
          pid: mitm.pid,
          dns,
          mappings,
          sudoRequired: isSudoPasswordRequired(),
          dnsElevationRequired: isWinElevationRequired(),
          sudoCached: !!cachedSudoPassword,
          version: currentVersion,
          latestVersion,
          updateAvailable
        })
      );
      return;
    }

    // ── Config API (.env) ─────────────────────────────────────────
    if (pathname === "/api/admin/config" && req.method === "GET") {
      const envPath = path.join(__dirname, "..", ".env");
      const envVars = { MITM_ROUTER_BASE: "", ROUTER_API_KEY: "" };
      try {
        const text = fs.readFileSync(envPath, "utf-8");
        for (const line of text.split("\n")) {
          const m = line.match(/^(MITM_ROUTER_BASE|ROUTER_API_KEY)\s*=\s*(.*)$/);
          if (m) envVars[m[1]] = m[2].trim();
        }
      } catch { /* file missing */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(envVars));
      return;
    }

    if (pathname === "/api/admin/config" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const { MITM_ROUTER_BASE, ROUTER_API_KEY } = JSON.parse(bodyBuffer.toString());
        const envPath = path.join(__dirname, "..", ".env");
        const content = [
          "# 9Router MITM Server configuration",
          "",
          "# The base URL of the 9Router server that this MITM proxy should forward requests to.",
          `MITM_ROUTER_BASE=${MITM_ROUTER_BASE || ""}`,
          "",
          "# The authorization API Key to authenticate requests with 9Router.",
          `ROUTER_API_KEY=${ROUTER_API_KEY || ""}`,
          "",
        ].join("\n");
        fs.writeFileSync(envPath, content, "utf-8");
        if (MITM_ROUTER_BASE) process.env.MITM_ROUTER_BASE = MITM_ROUTER_BASE;
        if (ROUTER_API_KEY) process.env.ROUTER_API_KEY = ROUTER_API_KEY;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── Converter — một active client (native REQ+RES) ─────────────
    if (pathname === "/api/admin/converters" && req.method === "GET") {
      const toggles = loadConverterToggles();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        clients: CLIENT_TOOLS,
        meta: listApiProxyMeta(),
        toggles,
        apiProxyClient: getApiProxyClient(),
        activeClient: getApiProxyClient(),
        configFile: TOGGLES_FILE,
      }));
      return;
    }

    if (pathname === "/api/admin/converters/activate" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const { client } = JSON.parse(bodyBuffer.toString());
        const toggles = setApiProxyClient(client || null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          toggles,
          apiProxyClient: toggles.apiProxyClient || null,
          activeClient: toggles.apiProxyClient || null,
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/converters/toggle" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const { client, enabled } = JSON.parse(bodyBuffer.toString());
        const toggles = enabled ? setApiProxyClient(client) : setApiProxyClient(null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          toggles,
          apiProxyClient: toggles.apiProxyClient || null,
          activeClient: toggles.apiProxyClient || null,
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/converters" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const incoming = JSON.parse(bodyBuffer.toString());
        const toggles = saveConverterToggles(incoming.toggles || incoming);
        const store = loadAuthStore();
        store.converters = toggles;
        saveAuthStore(store);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, toggles, configFile: TOGGLES_FILE }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── DNS Toggle ────────────────────────────────────────────────
    if (pathname === "/api/admin/dns/toggle" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const { tool, enable, sudoPassword } = JSON.parse(bodyBuffer.toString());
        const password = sudoPassword || cachedSudoPassword;
        if (enable) await addDNSEntry(tool, password);
        else await removeDNSEntry(tool, password);
        if (sudoPassword) cachedSudoPassword = sudoPassword;

        // Persist DNS state in authStore
        const store = loadAuthStore();
        if (!store.dns) store.dns = {};
        store.dns[tool] = !!enable;
        saveAuthStore(store);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── Mappings ──────────────────────────────────────────────────
    if (pathname === "/api/admin/mappings" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const { mappings } = JSON.parse(bodyBuffer.toString());
        if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
          throw new Error("Invalid mappings payload");
        }
        const aliasFile = path.join(__dirname, "..", "aliases.json");
        fs.writeFileSync(aliasFile, JSON.stringify(mappings, null, 2), "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, file: aliasFile }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── MITM Start ────────────────────────────────────────────────
    if (pathname === "/api/admin/mitm/start" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const { sudoPassword } = JSON.parse(bodyBuffer.toString());
        const result = await startMitmServer(sudoPassword || null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        const isPasswordError = e.message && (
          e.message.includes("Wrong sudo password") ||
          e.message.includes("incorrect password")
        );
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: e.message,
          passwordError: isPasswordError
        }));
      }
      return;
    }

    // ── MITM Stop ─────────────────────────────────────────────────
    if (pathname === "/api/admin/mitm/stop" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const { sudoPassword } = JSON.parse(bodyBuffer.toString());
        const result = await stopMitmServer(sudoPassword || null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── Admin Shutdown ────────────────────────────────────────────
    if (pathname === "/api/admin/shutdown" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Admin server shutting down..." }));
      log("⏹ Admin shutdown requested — stopping MITM + DNS cleanup...");
      setTimeout(async () => {
        try {
          await stopMitmServer().catch(() => {});
        } catch { /* best effort */ }
        process.exit(0);
      }, 500);
      return;
    }

    // ── Credentials ───────────────────────────────────────────────
    if (pathname === "/api/admin/credentials" && req.method === "GET") {
      const creds = getAllCredentials();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(creds));
      return;
    }

    // ── Console Logs ─────────────────────────────────────────────
    if (pathname === "/api/admin/console/logs" && req.method === "GET") {
      const logs = getLogs();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(logs));
      return;
    }

    if (pathname === "/api/admin/console/clear" && req.method === "POST") {
      clearLogs();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── Provider meta + auth backup ───────────────────────────────
    if (pathname === "/api/admin/providers/meta" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ providers: listProviderMeta(), oauth: listOAuthProvidersPublic() }));
      return;
    }

    if (pathname === "/api/admin/auth/backup/export" && req.method === "GET") {
      const backup = exportBackup();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="xmitm-auth-backup-${stamp}.json"`,
      });
      res.end(JSON.stringify(backup, null, 2));
      return;
    }

    if (pathname === "/api/admin/auth/backup/import" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const incoming = JSON.parse(bodyBuffer.toString());
        const merge = url.searchParams.get("merge") === "1";
        const store = importBackup(incoming, { merge });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, updatedAt: store.updatedAt, merge }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── Full Config Export (all-in-one) ───────────────────────────
    if (pathname === "/api/admin/config/export" && req.method === "GET") {
      try {
        const authStore = exportBackup();
        const aliasFile = path.join(__dirname, "..", "aliases.json");
        const aliases = fs.existsSync(aliasFile)
          ? JSON.parse(fs.readFileSync(aliasFile, "utf8"))
          : {};
        const envVars = readEnv();
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const fullConfig = {
          _xmitm: true,
          version: 1,
          exportedAt: new Date().toISOString(),
          env: {
            MITM_ROUTER_BASE: envVars.MITM_ROUTER_BASE || "",
            ROUTER_API_KEY: envVars.ROUTER_API_KEY || "",
          },
          authStore,
          aliases,
        };
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="xmitm-config-${stamp}.json"`,
        });
        res.end(JSON.stringify(fullConfig, null, 2));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── Full Config Import (all-in-one) ───────────────────────────
    if (pathname === "/api/admin/config/import" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const incoming = JSON.parse(bodyBuffer.toString());
        if (!incoming._xmitm) throw new Error("Invalid config file — missing _xmitm marker");

        const results = [];

        // 1. Restore auth store (providers + OAuth)
        if (incoming.authStore) {
          importBackup(incoming.authStore, { merge: false });
          results.push("auth-store restored");
        }

        // 2. Restore aliases (model routing)
        if (incoming.aliases) {
          const aliasFile = path.join(__dirname, "..", "aliases.json");
          fs.writeFileSync(aliasFile, JSON.stringify(incoming.aliases, null, 2), "utf8");
          results.push("aliases restored");
        }

        // 3. Restore .env
        if (incoming.env) {
          const { MITM_ROUTER_BASE, ROUTER_API_KEY } = incoming.env;
          const envPath = path.join(__dirname, "..", ".env");
          const content = [
            "# 9Router MITM Server configuration",
            "",
            `MITM_ROUTER_BASE=${MITM_ROUTER_BASE || ""}`,
            "",
            `ROUTER_API_KEY=${ROUTER_API_KEY || ""}`,
            "",
          ].join("\n");
          fs.writeFileSync(envPath, content, "utf-8");
          if (MITM_ROUTER_BASE) process.env.MITM_ROUTER_BASE = MITM_ROUTER_BASE;
          if (ROUTER_API_KEY) process.env.ROUTER_API_KEY = ROUTER_API_KEY;
          results.push("env restored");
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, restored: results }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── Client API Keys (Create/List/Delete API Keys for Client) ────────────────────
    if (pathname === "/api/admin/client-keys" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, keys: getClientKeys() }));
      return;
    }

    if (pathname === "/api/admin/client-keys" && req.method === "POST") {
      try {
        const bodyBuffer = await collectBodyRaw(req);
        const { label } = JSON.parse(bodyBuffer.toString() || "{}");
        const newKey = addClientKey(label);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, key: newKey }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/client-keys" && req.method === "DELETE") {
      try {
        const id = url.searchParams.get("id");
        if (!id) throw new Error("Missing key ID");
        const success = removeClientKey(id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/proxies" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxies: getProxies() }));
      return;
    }

    if (pathname === "/api/admin/proxies" && req.method === "POST") {
      try {
        const bodyBuffer = await collectBodyRaw(req);
        const { label, url, type } = JSON.parse(bodyBuffer.toString() || "{}");
        const newProxy = addProxy(label, url, type);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, proxy: newProxy }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/proxies" && req.method === "DELETE") {
      try {
        const id = url.searchParams.get("id");
        if (!id) throw new Error("Missing proxy ID");
        const success = removeProxy(id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/oauth/connections" && req.method === "GET") {
      const provider = url.searchParams.get("provider") || null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connections: listOAuthConnectionsPublic(provider) }));
      return;
    }

    if (pathname === "/api/admin/oauth/import-local" && req.method === "POST") {
      const provider = url.searchParams.get("provider");
      if (!provider) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing provider" }));
        return;
      }
      try {
        const result = importLocalOAuth(provider);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/oauth/cursor/import-local" && req.method === "POST") {
      try {
        const result = importLocalOAuth("cursor");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          providerId: "cursor",
          connectionId: result.id,
          label: result.label,
          email: result.email,
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/oauth/chatgpt/import-local" && req.method === "POST") {
      try {
        const result = importLocalOAuth("chatgpt");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/oauth/authorize" && req.method === "GET") {
      const provider = url.searchParams.get("provider");
      if (!provider) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing provider" }));
        return;
      }
      try {
        const { url: authUrl } = buildAuthorizeUrl(provider, req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, url: authUrl }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/oauth/callback" && req.method === "GET") {
      try {
        const query = Object.fromEntries(url.searchParams.entries());
        const result = await handleCallback(query, req);
        res.writeHead(302, { Location: `/?oauth=ok&provider=${encodeURIComponent(result.providerId)}&tab=providers` });
        res.end();
      } catch (e) {
        res.writeHead(302, { Location: `/?oauth=error&msg=${encodeURIComponent(e.message)}&tab=providers` });
        res.end();
      }
      return;
    }

    if (pathname.startsWith("/api/admin/oauth/connections/") && req.method === "DELETE") {
      const connectionId = pathname.split("/").pop();
      const ok = removeOAuthConnection(connectionId);
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    if (pathname.startsWith("/api/admin/oauth/connections/") && pathname.endsWith("/refresh") && req.method === "POST") {
      const parts = pathname.split("/");
      const connectionId = parts[parts.length - 2];
      try {
        await refreshConnection(connectionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── Providers API ─────────────────────────────────────────────
    if (pathname === "/api/admin/providers" && req.method === "GET") {
      const data = loadProviders();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    if (pathname === "/api/admin/providers/quota" && req.method === "GET") {
      const data = loadProviders();
      const refresh = url.searchParams.get("refresh") === "1";
      const singleProvider = url.searchParams.get("provider");
      const keyIndexRaw = url.searchParams.get("index");
      if (refresh && singleProvider && keyIndexRaw != null) {
        const keyIndex = parseInt(keyIndexRaw, 10);
        if (!Number.isNaN(keyIndex)) {
          const keyStat = await checkProviderKeyAtIndex(data, singleProvider, keyIndex);
          if (!keyStat) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Key not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, provider: singleProvider, key: keyStat }));
          return;
        }
      }
      if (refresh) clearQuotaCache();
      const quota = await checkAllProviders(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, quota, cached: !refresh }));
      return;
    }

    if (pathname === "/api/admin/providers" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const incoming = JSON.parse(bodyBuffer.toString());
        const existing = loadProviders();
        const previousActive = existing.activeProvider;
        if (Object.prototype.hasOwnProperty.call(incoming, "activeProvider")) {
          existing.activeProvider = incoming.activeProvider || null;
        }
        if (incoming.providers) {
          for (const [pid, pdata] of Object.entries(incoming.providers)) {
            if (!existing.providers[pid]) {
              existing.providers[pid] = { baseUrl: pdata.baseUrl || "", keys: [], enabled: false };
            }
            if (pdata.keys !== undefined) existing.providers[pid].keys = pdata.keys;
            if (pdata.baseUrl !== undefined) existing.providers[pid].baseUrl = pdata.baseUrl;
            if (pdata.enabled !== undefined) existing.providers[pid].enabled = pdata.enabled === true;
            if (pdata.responseFormat !== undefined) existing.providers[pid].responseFormat = pdata.responseFormat;
          }
        }
        // Sync enabled flags with activeProvider (only one active)
        for (const [pid, prov] of Object.entries(existing.providers)) {
          prov.enabled = pid === existing.activeProvider;
        }
        saveProviders(existing);

        let opencodeStatus = null;
        if (previousActive !== existing.activeProvider
          || previousActive === "opencode"
          || existing.activeProvider === "opencode") {
          opencodeStatus = await opencodeSession.syncProviderActivation(previousActive, existing.activeProvider);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, data: existing, opencode: opencodeStatus }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/opencode/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, status: opencodeSession.getPublicStatus() }));
      return;
    }

    if (pathname === "/api/admin/opencode/session/create" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const incoming = JSON.parse(bodyBuffer.toString() || "{}");
        const result = await opencodeSession.createNewSession({
          title: incoming.title || undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          session: result.session,
          status: result.status,
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/opencode/session/export" && req.method === "GET") {
      try {
        const sessionId = url.searchParams.get("sessionId") || opencodeSession.getPublicStatus().sessionId;
        const body = await opencodeSession.exportSession(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, sessionId, body }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    if (pathname === "/api/admin/opencode/session/chat" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const incoming = JSON.parse(bodyBuffer.toString() || "{}");
        const text = incoming.text || incoming.message || "";
        if (!text) throw new Error("Missing text/message");
        const reply = await opencodeSession.sendMessage(text, {
          sessionId: incoming.sessionId,
          agent: incoming.agent,
          model: incoming.model,
        });
        const exportBody = await opencodeSession.exportSession(reply?.info?.sessionID || incoming.sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          reply,
          export: exportBody,
          status: opencodeSession.getPublicStatus(),
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ── Provider Router /v1/* ─────────────────────────────────────
    // This is the main router endpoint — MITM_ROUTER_BASE should point here.
    // Receives requests from MITM, forwards to the active provider.
    if (
      pathname.startsWith("/v1") ||
      pathname === "/responses" ||
      pathname === "/chat/completions" ||
      pathname === "/messages"
    ) {
      const bodyBuffer = await collectBodyRaw(req);
      await forwardRequest(req, res, bodyBuffer);
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    err(`API error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
}

// ── Start Server ────────────────────────────────────────────────

const server = http.createServer(handleRequest);
server.listen(ADMIN_PORT, HOST, () => {
  log(`🚀 Admin UI ready at http://${HOST}:${ADMIN_PORT}`);
});

// ── Graceful Shutdown ───────────────────────────────────────────

const shutdown = async () => {
  log("⏹ Shutting down admin server...");
  await opencodeSession.deactivateProvider().catch(() => {});
  await stopMitmServer().catch(() => {});
  const forceExit = setTimeout(() => process.exit(0), 2000);
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

setInterval(() => {
  watchMitmHealth().catch(() => {});
}, MITM_HEALTH_WATCH_MS);

process.on("uncaughtException", (e) => {
  err(`Uncaught exception in admin server (keeping alive): ${e.message}`);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  err(`Unhandled rejection in admin server (keeping alive): ${msg}`);
});
