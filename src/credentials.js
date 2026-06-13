/**
 * credentials.js — Read access tokens, machine IDs from local IDE storage.
 *
 * Supported providers:
 *   - cursor:       ~/.config/Cursor/User/globalStorage/state.vscdb (SQLite) + machineid
 *   - copilot:      GitHub Copilot token stored inside Cursor's state.vscdb
 *   - kiro:         ~/.kiro (if present)
 *   - antigravity:  ~/.gemini/oauth_creds.json
 *   - opencode:     opencode CLI + ~/.local/share/opencode/auth.json (optional)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { log, err } = require("./logger");
const { getOpencodeSettings } = require("./configStore");


const IS_WIN = process.platform === "win32";

// ── Detect real user home (works even under sudo) ─────────────
function getRealHome() {
  // When running via sudo, SUDO_USER is set to the original user
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser) {
    // Read home dir from /etc/passwd for the real user
    try {
      const passwd = fs.readFileSync("/etc/passwd", "utf-8");
      const line = passwd.split("\n").find(l => l.startsWith(sudoUser + ":"));
      if (line) {
        const home = line.split(":")[5];
        if (home && fs.existsSync(home)) return home;
      }
      // Fallback: /home/<user>
      const fallback = `/home/${sudoUser}`;
      if (fs.existsSync(fallback)) return fallback;
    } catch { /* ignore */ }
  }
  return process.env.HOME || require("os").homedir() || "/root";
}

const HOME = getRealHome();


// ── Helpers ───────────────────────────────────────────────────

/**
 * Query a .vscdb (SQLite3) file via CLI sqlite3.
 * Returns the raw string value or null.
 */
/**
 * Query a .vscdb (SQLite3) file using better-sqlite3 (no CLI dependency).
 */
let BetterSqlite3;
function getBetterSqlite3() {
  if (!BetterSqlite3) {
    try { BetterSqlite3 = require("better-sqlite3"); } catch { BetterSqlite3 = null; }
  }
  return BetterSqlite3;
}

const _dbCache = new Map();
function getDb(dbPath) {
  if (_dbCache.has(dbPath)) return _dbCache.get(dbPath);
  const Sqlite = getBetterSqlite3();
  if (!Sqlite) return null;
  try {
    const db = new Sqlite(dbPath, { readonly: true, fileMustExist: true });
    _dbCache.set(dbPath, db);
    return db;
  } catch { return null; }
}

function queryVscdb(dbPath, key) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = getDb(dbPath);
    if (!db) return null;
    const row = db.prepare("SELECT value FROM ItemTable WHERE key=? LIMIT 1").get(key);
    return row?.value?.trim() || null;
  } catch {
    return null;
  }
}

function readFileText(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

function readJsonFile(filePath) {
  const text = readFileText(filePath);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ── Per-provider extractors ──────────────────────────────────

function getCursorCredentials() {
  const configBase = IS_WIN
    ? path.join(HOME, "AppData", "Roaming", "Cursor")
    : path.join(HOME, ".config", "Cursor");
  const dbPath = path.join(configBase, "User", "globalStorage", "state.vscdb");
  const machineIdPath = path.join(configBase, "machineid");

  const accessToken = queryVscdb(dbPath, "cursorAuth/accessToken");
  const refreshToken = queryVscdb(dbPath, "cursorAuth/refreshToken");
  const machineId = readFileText(machineIdPath);
  const email = queryVscdb(dbPath, "cursorAuth/cachedEmail");
  const membershipType = queryVscdb(dbPath, "cursorAuth/stripeMembershipType");
  const subscriptionStatus = queryVscdb(dbPath, "cursorAuth/stripeSubscriptionStatus");

  return {
    provider: "cursor",
    label: "Cursor IDE",
    accessToken,
    refreshToken,
    machineId,
    extra: {
      email,
      membershipType,
      subscriptionStatus,
    },
    paths: {
      db: dbPath,
      machineId: machineIdPath,
    },
  };
}

function getCodexAuthPath() {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(HOME, ".codex");
  return path.join(codexHome, "auth.json");
}

function getChatGPTCredentials() {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(HOME, ".codex");
  const authPath = getCodexAuthPath();
  const data = readJsonFile(authPath);

  if (!data) {
    return {
      provider: "chatgpt",
      error: `Khong tim thay ${authPath}. Chay: codex login`,
      paths: { auth: authPath, codexHome },
    };
  }

  const authMode = String(data.auth_mode || data.authMode || "").toLowerCase();

  if (authMode === "apikey" && data.OPENAI_API_KEY) {
    return {
      provider: "chatgpt",
      authMode: "apikey",
      accessToken: data.OPENAI_API_KEY,
      refreshToken: null,
      extra: { authMode: "apikey" },
      paths: { auth: authPath, codexHome },
    };
  }

  const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : data;
  const accessToken = tokens.access_token || tokens.accessToken || null;
  const refreshToken = tokens.refresh_token || tokens.refreshToken || null;
  const accountId = tokens.account_id || tokens.accountId || data.account_id || null;

  if (accessToken) {
    let expiresAt = null;
    const exp = tokens.expires_at || tokens.expiresAt || data.expires_at;
    if (exp) {
      expiresAt = typeof exp === "number"
        ? new Date(exp > 1e12 ? exp : exp * 1000).toISOString()
        : String(exp);
    }
    return {
      provider: "chatgpt",
      authMode: "oauth",
      accessToken,
      refreshToken,
      extra: {
        authMode: authMode || "chatgpt",
        accountId,
        email: data.email || accountId,
        expiresAt,
      },
      paths: { auth: authPath, codexHome },
    };
  }

  if (data.OPENAI_API_KEY) {
    return {
      provider: "chatgpt",
      authMode: "apikey",
      accessToken: data.OPENAI_API_KEY,
      refreshToken: null,
      extra: { authMode: "apikey-fallback" },
      paths: { auth: authPath, codexHome },
    };
  }

  return {
    provider: "chatgpt",
    error: "auth.json khong co token. Chay: codex login (ChatGPT) hoac them OPENAI_API_KEY",
    paths: { auth: authPath, codexHome },
  };
}

function resolveOpencodeBinaryPath() {
  const oc = getOpencodeSettings();
  if (oc.bin && fs.existsSync(oc.bin)) return oc.bin;
  try {
    return execSync("command -v opencode", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function getOpenCodeCredentials() {
  const oc = getOpencodeSettings();
  const authPath = path.join(HOME, ".local", "share", "opencode", "auth.json");
  const authData = readJsonFile(authPath);
  const configKey = oc.apiKey || null;
  const fileKey = authData?.key || authData?.apiKey || authData?.token || null;
  const binary = resolveOpencodeBinaryPath();
  const projectDir = oc.projectDir || process.cwd();
  const port = Number(oc.servePort || 4096);

  if (!binary) {
    return {
      provider: "opencode",
      error: "Khong tim thay opencode CLI trong PATH",
      paths: { auth: authPath },
    };
  }

  return {
    provider: "opencode",
    label: "OpenCode Session",
    accessToken: configKey || fileKey || "local-session",
    refreshToken: null,
    extra: {
      binary,
      projectDir,
      baseUrl: `http://127.0.0.1:${port}`,
      hasApiKey: Boolean(configKey || fileKey),
    },
    paths: {
      auth: fs.existsSync(authPath) ? authPath : null,
    },
  };
}

function getCopilotCredentials() {
  // Copilot stores its data inside the host IDE's globalStorage (e.g. Cursor or VS Code).
  // We check Cursor's state.vscdb first, then VS Code.
  const candidates = IS_WIN
    ? [
        path.join(HOME, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
        path.join(HOME, "AppData", "Roaming", "Code", "User", "globalStorage", "state.vscdb"),
      ]
    : [
        path.join(HOME, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
        path.join(HOME, ".config", "Code", "User", "globalStorage", "state.vscdb"),
      ];

  let copilotData = null;
  let usedDb = null;
  for (const dbPath of candidates) {
    const raw = queryVscdb(dbPath, "GitHub.copilot");
    if (raw) {
      copilotData = raw;
      usedDb = dbPath;
      break;
    }
  }

  // Also check for standalone hosts.json / apps.json
  const copilotConfigDir = path.join(HOME, ".config", "github-copilot");
  const hostsJson = readJsonFile(path.join(copilotConfigDir, "hosts.json"));
  const appsJson = readJsonFile(path.join(copilotConfigDir, "apps.json"));

  // Extract OAuth token from hosts.json if available
  let oauthToken = null;
  if (hostsJson) {
    const key = Object.keys(hostsJson).find(k => k.includes("github.com"));
    if (key) oauthToken = hostsJson[key]?.oauth_token || null;
  }

  return {
    provider: "copilot",
    label: "GitHub Copilot",
    accessToken: oauthToken,
    refreshToken: null,
    machineId: null,
    extra: {
      installedVersion: copilotData ? (() => { try { return JSON.parse(copilotData).installedVersion; } catch { return null; } })() : null,
      hostsJson: hostsJson ? "(found)" : null,
      appsJson: appsJson ? "(found)" : null,
    },
    paths: {
      db: usedDb,
      configDir: copilotConfigDir,
    },
  };
}

function getKiroCredentials() {
  const kiroBase = path.join(HOME, ".kiro");
  // Kiro uses VS Code-like storage
  const dbCandidates = [
    path.join(kiroBase, "User", "globalStorage", "state.vscdb"),
    path.join(kiroBase, "data", "User", "globalStorage", "state.vscdb"),
  ];

  let accessToken = null;
  let usedDb = null;
  for (const dbPath of dbCandidates) {
    const token = queryVscdb(dbPath, "kiroAuth/accessToken") || queryVscdb(dbPath, "aws.toolkit.auth.profile");
    if (token) {
      accessToken = token;
      usedDb = dbPath;
      break;
    }
  }

  const machineIdPath = path.join(kiroBase, "machineid");
  const machineId = readFileText(machineIdPath);

  // Check for AWS SSO / Builder ID credentials
  const awsDir = path.join(HOME, ".aws");
  const ssoCache = path.join(awsDir, "sso", "cache");
  let awsSsoToken = null;
  if (fs.existsSync(ssoCache)) {
    try {
      const files = fs.readdirSync(ssoCache).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const data = readJsonFile(path.join(ssoCache, f));
        if (data?.accessToken) {
          awsSsoToken = data.accessToken;
          break;
        }
      }
    } catch { /* ignore */ }
  }

  return {
    provider: "kiro",
    label: "AWS Kiro",
    accessToken: accessToken || awsSsoToken,
    refreshToken: null,
    machineId,
    extra: {
      kiroDir: fs.existsSync(kiroBase) ? "(found)" : "(not found)",
      awsSsoToken: awsSsoToken ? "(found)" : null,
    },
    paths: {
      db: usedDb,
      kiroBase,
      awsSsoCache: ssoCache,
    },
  };
}

function getAntigravityCredentials() {
  const geminiDir = path.join(HOME, ".gemini");
  const oauthPath = path.join(geminiDir, "oauth_creds.json");
  const oauthData = readJsonFile(oauthPath);

  const antigravityBase = path.join(HOME, ".antigravity");
  const machineIdPath = path.join(antigravityBase, "machineid");
  const machineId = readFileText(machineIdPath);

  // Also check google_accounts.json for account info
  const googleAccounts = readJsonFile(path.join(geminiDir, "google_accounts.json"));

  return {
    provider: "antigravity",
    label: "Google Antigravity",
    accessToken: oauthData?.access_token || null,
    refreshToken: oauthData?.refresh_token || null,
    machineId,
    extra: {
      tokenType: oauthData?.token_type || null,
      scope: oauthData?.scope || null,
      expiryDate: oauthData?.expiry_date || null,
      googleAccounts: googleAccounts ? "(found)" : null,
    },
    paths: {
      oauth: oauthPath,
      machineId: machineIdPath,
      geminiDir,
    },
  };
}

// ── Public API (with cache to avoid blocking event loop) ─────

const PROVIDERS = {
  cursor: getCursorCredentials,
  chatgpt: getChatGPTCredentials,
  opencode: getOpenCodeCredentials,
  copilot: getCopilotCredentials,
  kiro: getKiroCredentials,
  antigravity: getAntigravityCredentials,
};

const CACHE_TTL = 30_000; // 30 seconds
let _credCache = null;
let _credCacheTs = 0;

function _loadAll() {
  const now = Date.now();
  if (_credCache && now - _credCacheTs < CACHE_TTL) return _credCache;
  const result = {};
  for (const [tool, fn] of Object.entries(PROVIDERS)) {
    try {
      result[tool] = fn();
    } catch (e) {
      err(`[credentials] Error reading ${tool}: ${e.message}`);
      result[tool] = { provider: tool, error: e.message };
    }
  }
  _credCache = result;
  _credCacheTs = now;
  return result;
}

/**
 * Get credentials for a single provider (cached).
 */
function getCredentials(toolName) {
  const fn = PROVIDERS[toolName];
  if (!fn) return { error: `Unknown provider: ${toolName}` };
  const all = _loadAll();
  return all[toolName];
}

/**
 * Get credentials for all providers (cached).
 */
function getAllCredentials() {
  return _loadAll();
}

module.exports = { getCredentials, getAllCredentials };
