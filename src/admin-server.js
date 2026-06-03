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
  execWithPassword,
} = require("./dns/dnsConfig");
const { getMitmAlias } = require("./dbReader");
const { getAllCredentials } = require("./credentials");
const { init: initLogStore, getLogs, clearLogs } = require("./logStore");

// Initialize log store at startup
initLogStore();

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
  if (mitmProcess && !mitmProcess.killed) {
    return { running: true, pid: mitmPid };
  }
  // Fallback: check via health endpoint (for externally running MITM)
  try {
    const result = await pollMitmHealth(2000);
    return { running: true, pid: result.pid };
  } catch {
    return { running: false, pid: null };
  }
}

// ── Start MITM Server ──────────────────────────────────────────

async function startMitmServer(sudoPassword) {
  if (mitmProcess && !mitmProcess.killed) {
    throw new Error("MITM server is already running");
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

  // Step 2: Add DNS entries for all tools
  log("🌐 Configuring DNS entries...");
  for (const tool of Object.keys(TOOL_HOSTS)) {
    await addDNSEntry(tool, password);
  }
  log("🌐 All DNS entries configured");

  // Step 3: Build env for MITM child
  const envVars = readEnv();
  const mitmEnv = {
    ...process.env,
    NODE_ENV: "production",
  };
  if (envVars.MITM_ROUTER_BASE) mitmEnv.MITM_ROUTER_BASE = envVars.MITM_ROUTER_BASE;
  if (envVars.ROUTER_API_KEY) mitmEnv.ROUTER_API_KEY = envVars.ROUTER_API_KEY;

  // Step 3: Spawn MITM server
  const serverPath = path.join(__dirname, "server.js");
  log(`🚀 Spawning MITM server: ${serverPath}`);

  if (IS_WIN) {
    mitmProcess = spawn(process.execPath, [serverPath], {
      detached: false,
      windowsHide: true,
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: mitmEnv,
    });
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
      detached: false,
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: mitmEnv,
    });
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
  mitmProcess.on("exit", (code) => {
    spawnExitCode = code;
    log(`MITM server exited (code: ${code})`);
    mitmProcess = null;
    mitmPid = null;
    mitmRealPid = null;
  });

  // Step 4: Wait for health
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
  log(`✅ MITM server healthy (PID: ${mitmPid})`);
  return { running: true, pid: mitmPid };
}

// ── Stop MITM Server ───────────────────────────────────────────

async function stopMitmServer(sudoPassword) {
  const password = sudoPassword || cachedSudoPassword;
  mitmStopping = true;

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

  // ── Step 3: Force-kill anything still listening on port 443 (via sudo) ──
  if (password) {
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

  // ── Step 4: Wait and verify MITM is actually dead ──
  for (let i = 0; i < 12; i++) {
    try {
      await pollMitmHealth(1500);
      // Still alive — try once more
      if (password) {
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

  // ── Step 5: Remove all DNS entries ──
  log("🌐 Removing all DNS entries...");
  try {
    await removeAllDNSEntries(password);
    log("🌐 All DNS entries removed");
  } catch (e) {
    err(`Failed to remove DNS entries: ${e.message}`);
  }

  mitmStopping = false;
  return { running: false, pid: null };
}

// ── HTTP Router ────────────────────────────────────────────────

async function handleRequest(req, res) {
  // CORS for localhost
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    // ── Serve admin.html ──────────────────────────────────────────
    if (pathname === "/" || pathname === "/admin") {
      const html = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    // ── Status API ────────────────────────────────────────────────
    if (pathname === "/api/admin/status" && req.method === "GET") {
      const mitm = await getMitmStatus();
      const dns = checkAllDNSStatus();
      const mappings = {
        antigravity: getMitmAlias("antigravity") || {},
        copilot: getMitmAlias("copilot") || {},
        kiro: getMitmAlias("kiro") || {},
        cursor: getMitmAlias("cursor") || {},
      };
      
      // Get current version from package.json
      let currentVersion = "1.0.0";
      try {
        const pkg = require("../package.json");
        currentVersion = pkg.version || "1.0.0";
      } catch {}

      // Check for updates (mock check for 1.1.0 or online source in production)
      // Since currentVersion is 1.0.0, we can report 1.1.0 as update available
      const latestVersion = "1.1.0";
      const updateAvailable = latestVersion !== currentVersion;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          mitmRunning: mitm.running,
          pid: mitm.pid,
          dns,
          mappings,
          sudoRequired: isSudoPasswordRequired(),
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

    // ── DNS Toggle ────────────────────────────────────────────────
    if (pathname === "/api/admin/dns/toggle" && req.method === "POST") {
      const bodyBuffer = await collectBodyRaw(req);
      try {
        const { tool, enable, sudoPassword } = JSON.parse(bodyBuffer.toString());
        const password = sudoPassword || cachedSudoPassword;
        if (enable) await addDNSEntry(tool, password);
        else await removeDNSEntry(tool, password);
        if (sudoPassword) cachedSudoPassword = sudoPassword;
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
        const aliasFile = path.join(__dirname, "..", "aliases.json");
        fs.writeFileSync(aliasFile, JSON.stringify(mappings, null, 2), "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
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
  await stopMitmServer().catch(() => {});
  const forceExit = setTimeout(() => process.exit(0), 2000);
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
