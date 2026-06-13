/**
 * configStore.js — Single config.json DB for entire XMITM system.
 * Path: data/config.json (fallback: ./config.json)
 */
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");
const { defaultProviderEntries } = require("./providerMeta");

const CONFIG_VERSION = 1;
const FALLBACK_CONFIG_PATH = path.join(__dirname, "..", "config.json");
const LEGACY_ENV_PATH = path.join(__dirname, "..", ".env");
const LEGACY_ALIASES_PATH = path.join(__dirname, "..", "aliases.json");
const LEGACY_AUTH_PATHS = [
  path.join(DATA_DIR, "auth-store.json"),
  path.join(__dirname, "..", "auth-store.json"),
];
const LEGACY_PROVIDERS_PATH = path.join(__dirname, "..", "providers.json");

let _resolvedConfigPath = null;
let _configCache = null;

function nowIso() {
  return new Date().toISOString();
}

function defaultAliases() {
  return {
    cli: {},
    antigravity: { "gemini-default": "gemini-3-flash" },
    copilot: {},
    kiro: {},
    cursor: {},
  };
}

function defaultOAuthApps() {
  return {
    redirectBase: "http://127.0.0.1:3000",
    google: { clientId: "", clientSecret: "" },
    github: { clientId: "", clientSecret: "" },
    anthropic: { clientId: "", clientSecret: "" },
    cursor: { clientId: "", clientSecret: "" },
  };
}

function defaultSystem() {
  return {
    antigravityProjectId: "",
    opencode: {
      bin: "",
      apiKey: "",
      servePort: 4096,
      serveHost: "127.0.0.1",
      projectDir: "",
      serverUsername: "opencode",
      serverPassword: "",
    },
    tlsInsecure: false,
  };
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    updatedAt: nowIso(),
    router: {
      mitmRouterBase: "http://localhost:20128",
      routerApiKey: "",
    },
    oauthApps: defaultOAuthApps(),
    system: defaultSystem(),
    activeProvider: null,
    providers: defaultProviderEntries(),
    oauth: { connections: [] },
    clientKeys: [],
    proxies: [],
    dns: {},
    aliases: defaultAliases(),
  };
}

function getConfigPath() {
  if (_resolvedConfigPath) return _resolvedConfigPath;
  const primary = path.join(DATA_DIR, "config.json");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    _resolvedConfigPath = primary;
  } catch {
    _resolvedConfigPath = FALLBACK_CONFIG_PATH;
    console.warn(`[configStore] Khong ghi duoc ${DATA_DIR} — dung ${FALLBACK_CONFIG_PATH}`);
  }
  return _resolvedConfigPath;
}

function parseDotEnvFile(filePath) {
  const vars = {};
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
  } catch { /* missing */ }
  return vars;
}

function applyEnvToConfig(cfg, env) {
  if (!env || typeof env !== "object") return;
  if (env.MITM_ROUTER_BASE) cfg.router.mitmRouterBase = env.MITM_ROUTER_BASE;
  if (env.ROUTER_API_KEY) cfg.router.routerApiKey = env.ROUTER_API_KEY;
  if (env.OAUTH_REDIRECT_BASE) cfg.oauthApps.redirectBase = env.OAUTH_REDIRECT_BASE;
  if (env.OAUTH_GOOGLE_CLIENT_ID) cfg.oauthApps.google.clientId = env.OAUTH_GOOGLE_CLIENT_ID;
  if (env.OAUTH_GOOGLE_CLIENT_SECRET) cfg.oauthApps.google.clientSecret = env.OAUTH_GOOGLE_CLIENT_SECRET;
  if (env.OAUTH_GITHUB_CLIENT_ID) cfg.oauthApps.github.clientId = env.OAUTH_GITHUB_CLIENT_ID;
  if (env.OAUTH_GITHUB_CLIENT_SECRET) cfg.oauthApps.github.clientSecret = env.OAUTH_GITHUB_CLIENT_SECRET;
  if (env.OAUTH_ANTHROPIC_CLIENT_ID) cfg.oauthApps.anthropic.clientId = env.OAUTH_ANTHROPIC_CLIENT_ID;
  if (env.OAUTH_ANTHROPIC_CLIENT_SECRET) cfg.oauthApps.anthropic.clientSecret = env.OAUTH_ANTHROPIC_CLIENT_SECRET;
  if (env.OAUTH_CURSOR_CLIENT_ID) cfg.oauthApps.cursor.clientId = env.OAUTH_CURSOR_CLIENT_ID;
  if (env.OAUTH_CURSOR_CLIENT_SECRET) cfg.oauthApps.cursor.clientSecret = env.OAUTH_CURSOR_CLIENT_SECRET;
  if (env.ANTIGRAVITY_PROJECT_ID) cfg.system.antigravityProjectId = env.ANTIGRAVITY_PROJECT_ID;
  const oc = cfg.system.opencode;
  if (env.OPENCODE_BIN) oc.bin = env.OPENCODE_BIN;
  if (env.OPENCODE_API_KEY) oc.apiKey = env.OPENCODE_API_KEY;
  if (env.OPENCODE_SERVE_PORT) oc.servePort = Number(env.OPENCODE_SERVE_PORT) || oc.servePort;
  if (env.OPENCODE_SERVE_HOST) oc.serveHost = env.OPENCODE_SERVE_HOST;
  if (env.OPENCODE_PROJECT_DIR) oc.projectDir = env.OPENCODE_PROJECT_DIR;
  if (env.OPENCODE_SERVER_USERNAME) oc.serverUsername = env.OPENCODE_SERVER_USERNAME;
  if (env.OPENCODE_SERVER_PASSWORD) oc.serverPassword = env.OPENCODE_SERVER_PASSWORD;
}

function mergeAuthSlice(cfg, authSlice) {
  if (!authSlice || typeof authSlice !== "object") return;
  if (authSlice.activeProvider != null) cfg.activeProvider = authSlice.activeProvider;
  if (authSlice.providers) cfg.providers = { ...cfg.providers, ...authSlice.providers };
  if (authSlice.oauth?.connections) cfg.oauth.connections = authSlice.oauth.connections;
  if (authSlice.clientKeys) cfg.clientKeys = authSlice.clientKeys;
  if (authSlice.proxies) cfg.proxies = authSlice.proxies;
  if (authSlice.dns) cfg.dns = { ...cfg.dns, ...authSlice.dns };
}

function migrateLegacyIntoConfig() {
  const cfg = defaultConfig();

  for (const p of LEGACY_AUTH_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      mergeAuthSlice(cfg, JSON.parse(fs.readFileSync(p, "utf8")));
      console.log(`[configStore] Migrated auth store from ${p}`);
      break;
    } catch { /* try next */ }
  }

  if (fs.existsSync(LEGACY_PROVIDERS_PATH)) {
    try {
      mergeAuthSlice(cfg, JSON.parse(fs.readFileSync(LEGACY_PROVIDERS_PATH, "utf8")));
      console.log("[configStore] Migrated providers.json");
    } catch { /* ignore */ }
  }

  if (fs.existsSync(LEGACY_ALIASES_PATH)) {
    try {
      cfg.aliases = JSON.parse(fs.readFileSync(LEGACY_ALIASES_PATH, "utf8"));
      console.log("[configStore] Migrated aliases.json");
    } catch { /* ignore */ }
  }

  applyEnvToConfig(cfg, parseDotEnvFile(LEGACY_ENV_PATH));
  if (fs.existsSync(LEGACY_ENV_PATH)) {
    console.log("[configStore] Migrated .env");
  }

  return cfg;
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const cfg = {
    version: raw?.version || CONFIG_VERSION,
    updatedAt: raw?.updatedAt || nowIso(),
    router: { ...base.router, ...(raw?.router || {}) },
    oauthApps: {
      ...defaultOAuthApps(),
      ...(raw?.oauthApps || {}),
      google: { ...base.oauthApps.google, ...(raw?.oauthApps?.google || {}) },
      github: { ...base.oauthApps.github, ...(raw?.oauthApps?.github || {}) },
      anthropic: { ...base.oauthApps.anthropic, ...(raw?.oauthApps?.anthropic || {}) },
      cursor: { ...base.oauthApps.cursor, ...(raw?.oauthApps?.cursor || {}) },
    },
    system: {
      ...defaultSystem(),
      ...(raw?.system || {}),
      opencode: { ...base.system.opencode, ...(raw?.system?.opencode || {}) },
    },
    activeProvider: raw?.activeProvider ?? null,
    providers: { ...base.providers, ...(raw?.providers || {}) },
    oauth: {
      connections: Array.isArray(raw?.oauth?.connections) ? raw.oauth.connections : [],
    },
    clientKeys: Array.isArray(raw?.clientKeys) ? raw.clientKeys : [],
    proxies: Array.isArray(raw?.proxies) ? raw.proxies : [],
    dns: raw?.dns && typeof raw.dns === "object" ? { ...raw.dns } : {},
    aliases: raw?.aliases && typeof raw.aliases === "object" ? { ...raw.aliases } : defaultAliases(),
  };

  // Legacy full export: { env, authStore, aliases }
  if (raw?.env) {
    applyEnvToConfig(cfg, {
      MITM_ROUTER_BASE: raw.env.MITM_ROUTER_BASE,
      ROUTER_API_KEY: raw.env.ROUTER_API_KEY,
    });
  }
  if (raw?.authStore) mergeAuthSlice(cfg, raw.authStore);
  if (raw?.aliases && !raw.router) cfg.aliases = raw.aliases;

  return cfg;
}

function initConfig() {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      _configCache = normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
      return _configCache;
    } catch (e) {
      console.warn(`[configStore] Invalid config.json: ${e.message}`);
    }
  }
  const migrated = migrateLegacyIntoConfig();
  _configCache = normalizeConfig(migrated);
  saveConfig(_configCache);
  console.log(`[configStore] Created ${configPath}`);
  return _configCache;
}

function loadConfig() {
  if (_configCache) return _configCache;
  return initConfig();
}

function saveConfig(config) {
  _configCache = null;
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  const normalized = normalizeConfig(config);
  normalized.updatedAt = nowIso();
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2), "utf8");
  _configCache = normalized;
  return normalized;
}

function invalidateConfigCache() {
  _configCache = null;
}

// ── Router (API Endpoint) ───────────────────────────────────────

const DEFAULT_LOCAL_ROUTER = "http://localhost:20128";

function normalizeRouterBase(raw) {
  return String(raw || DEFAULT_LOCAL_ROUTER)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "") || DEFAULT_LOCAL_ROUTER;
}

function getRouterConfig() {
  const cfg = loadConfig();
  const base = cfg.router?.mitmRouterBase || DEFAULT_LOCAL_ROUTER;
  const apiKey = cfg.router?.routerApiKey || "";
  return {
    routerBase: normalizeRouterBase(base),
    apiKey: apiKey || undefined,
  };
}

function setRouterConfig({ mitmRouterBase, routerApiKey }) {
  const cfg = loadConfig();
  if (mitmRouterBase != null) cfg.router.mitmRouterBase = mitmRouterBase;
  if (routerApiKey != null) cfg.router.routerApiKey = routerApiKey;
  return saveConfig(cfg);
}

function getRouterConfigForApi() {
  const cfg = loadConfig();
  return {
    MITM_ROUTER_BASE: cfg.router?.mitmRouterBase || "",
    ROUTER_API_KEY: cfg.router?.routerApiKey || "",
  };
}

// ── Aliases (model routing) ───────────────────────────────────────

function getAliases() {
  return loadConfig().aliases || defaultAliases();
}

function setAliases(aliases) {
  const cfg = loadConfig();
  cfg.aliases = aliases;
  return saveConfig(cfg);
}

// ── OAuth app credentials ─────────────────────────────────────────

function getOAuthApps() {
  return loadConfig().oauthApps || defaultOAuthApps();
}

function getOAuthAppCredentials(driverId) {
  const apps = getOAuthApps();
  const entry = apps[driverId];
  if (!entry) return { ok: false, error: `Unknown OAuth driver: ${driverId}` };
  const clientId = String(entry.clientId || "").trim();
  const clientSecret = String(entry.clientSecret || "").trim();
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error: `Thieu oauthApps.${driverId}.clientId / clientSecret trong config.json`,
    };
  }
  return { ok: true, clientId, clientSecret };
}

function getOAuthRedirectBase() {
  const base = String(getOAuthApps().redirectBase || "http://127.0.0.1:3000").trim();
  return base.replace(/\/+$/, "") || "http://127.0.0.1:3000";
}

// ── System settings ───────────────────────────────────────────────

function getSystemConfig() {
  return loadConfig().system || defaultSystem();
}

function getAntigravityProjectId() {
  return String(getSystemConfig().antigravityProjectId || "").trim();
}

function getOpencodeSettings() {
  return getSystemConfig().opencode || defaultSystem().opencode;
}

// ── Full backup import/export ─────────────────────────────────────

function exportFullConfig() {
  return loadConfig();
}

function importFullConfig(payload, { merge = false } = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid config JSON");
  }
  const incoming = normalizeConfig(payload);
  if (!merge) return saveConfig(incoming);

  const current = loadConfig();
  const merged = normalizeConfig({
    ...current,
    ...incoming,
    router: { ...current.router, ...incoming.router },
    oauthApps: {
      ...current.oauthApps,
      ...incoming.oauthApps,
      google: { ...current.oauthApps.google, ...incoming.oauthApps.google },
      github: { ...current.oauthApps.github, ...incoming.oauthApps.github },
      anthropic: { ...current.oauthApps.anthropic, ...incoming.oauthApps.anthropic },
      cursor: { ...current.oauthApps.cursor, ...incoming.oauthApps.cursor },
    },
    system: {
      ...current.system,
      ...incoming.system,
      opencode: { ...current.system.opencode, ...incoming.system.opencode },
    },
    providers: { ...current.providers, ...incoming.providers },
    oauth: {
      connections: [
        ...current.oauth.connections,
        ...incoming.oauth.connections.filter(
          (c) => !current.oauth.connections.some((x) => x.id === c.id)
        ),
      ],
    },
    clientKeys: [
      ...current.clientKeys,
      ...incoming.clientKeys.filter((c) => !current.clientKeys.some((x) => x.id === c.id)),
    ],
    proxies: [
      ...current.proxies,
      ...incoming.proxies.filter((c) => !current.proxies.some((x) => x.id === c.id)),
    ],
    dns: { ...current.dns, ...incoming.dns },
    aliases: { ...current.aliases, ...incoming.aliases },
    activeProvider: incoming.activeProvider ?? current.activeProvider,
  });
  return saveConfig(merged);
}

module.exports = {
  CONFIG_VERSION,
  DEFAULT_LOCAL_ROUTER,
  getConfigPath,
  initConfig,
  loadConfig,
  saveConfig,
  invalidateConfigCache,
  normalizeRouterBase,
  getRouterConfig,
  setRouterConfig,
  getRouterConfigForApi,
  getAliases,
  setAliases,
  getOAuthApps,
  getOAuthAppCredentials,
  getOAuthRedirectBase,
  getSystemConfig,
  getAntigravityProjectId,
  getOpencodeSettings,
  exportFullConfig,
  importFullConfig,
};
