/**
 * authStore.js — Single file for all keys, OAuth tokens, provider config
 * Path: data/auth-store.json (gitignored via data/)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("./paths");
const { defaultProviderEntries, getProviderMeta } = require("./providerMeta");

const LEGACY_PROVIDERS_FILE = path.join(__dirname, "..", "providers.json");
const FALLBACK_AUTH_STORE_PATH = path.join(__dirname, "..", "auth-store.json");

let _resolvedAuthStorePath = null;

function getAuthStorePath() {
  if (_resolvedAuthStorePath) return _resolvedAuthStorePath;

  const envPath = String(process.env.AUTH_STORE_PATH || "").trim();
  if (envPath) {
    _resolvedAuthStorePath = path.resolve(envPath);
    return _resolvedAuthStorePath;
  }

  const primary = path.join(DATA_DIR, "auth-store.json");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    _resolvedAuthStorePath = primary;
  } catch {
    _resolvedAuthStorePath = FALLBACK_AUTH_STORE_PATH;
    console.warn(
      `[authStore] Khong ghi duoc ${DATA_DIR} — dung ${FALLBACK_AUTH_STORE_PATH}. ` +
      "Dat quyen thu muc data/ hoac AUTH_STORE_PATH trong .env."
    );
  }
  return _resolvedAuthStorePath;
}

const STORE_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    updatedAt: nowIso(),
    activeProvider: null,
    providers: defaultProviderEntries(),
    oauth: { connections: [] },
    clientKeys: [],
    proxies: [],
    dns: {},
    converters: {
      apiProxyClient: null,
      activeClient: null,
      codex: { request: false, response: false },
      claude: { request: false, response: false },
      kiro: { request: false, response: false },
      antigravity: { request: false, response: false },
      cursor: { request: false, response: false },
      copilot: { request: false, response: false },
    },
  };
}

function normalizeProviderEntry(pid, prov) {
  const meta = getProviderMeta(pid);
  const authModes = meta?.authModes || ["apikey"];
  return {
    baseUrl: prov?.baseUrl || meta?.defaultBaseUrl || "",
    keys: Array.isArray(prov?.keys) ? prov.keys.filter(Boolean) : [],
    enabled: prov?.enabled === true,
    authMode: authModes.includes(prov?.authMode) ? prov.authMode : authModes[0],
    responseFormat: prov?.responseFormat || "origin",
    proxyId: prov?.proxyId || null,
  };
}

function normalizeStore(raw) {
  const base = defaultStore();
  const out = {
    version: raw?.version || STORE_VERSION,
    updatedAt: raw?.updatedAt || nowIso(),
    activeProvider: raw?.activeProvider ?? null,
    providers: { ...base.providers },
    oauth: {
      connections: Array.isArray(raw?.oauth?.connections) ? raw.oauth.connections : [],
    },
    clientKeys: Array.isArray(raw?.clientKeys) ? raw.clientKeys : [],
    proxies: Array.isArray(raw?.proxies) ? raw.proxies : [],
    dns: raw?.dns && typeof raw.dns === "object" ? { ...raw.dns } : {},
    converters: raw?.converters && typeof raw.converters === "object"
      ? { ...defaultStore().converters, ...raw.converters }
      : { ...defaultStore().converters },
  };

  if (raw?.providers && typeof raw.providers === "object") {
    for (const [pid, prov] of Object.entries(raw.providers)) {
      out.providers[pid] = normalizeProviderEntry(pid, prov);
    }
  }

  for (const [pid, prov] of Object.entries(out.providers)) {
    if (!getProviderMeta(pid)) {
      out.providers[pid] = normalizeProviderEntry(pid, prov);
    }
  }

  if (out.activeProvider && out.providers[out.activeProvider]) {
    out.providers[out.activeProvider].enabled = true;
  } else if (out.activeProvider && !out.providers[out.activeProvider]) {
    out.activeProvider = null;
  }

  out.oauth.connections = out.oauth.connections.map((c) => ({
    id: c.id || crypto.randomUUID(),
    provider: c.provider,
    driver: c.driver || "google",
    email: c.email || null,
    label: c.label || c.email || c.provider,
    accessToken: c.accessToken || "",
    refreshToken: c.refreshToken || "",
    expiresAt: c.expiresAt || null,
    createdAt: c.createdAt || nowIso(),
    updatedAt: c.updatedAt || c.createdAt || nowIso(),
    extra: c.extra && typeof c.extra === "object" ? c.extra : {},
  })).filter((c) => c.provider && c.accessToken);

  return out;
}

function migrateLegacyProviders() {
  if (!fs.existsSync(LEGACY_PROVIDERS_FILE)) return null;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_PROVIDERS_FILE, "utf8"));
    const store = defaultStore();
    store.activeProvider = legacy.activeProvider ?? null;
    if (legacy.providers) {
      for (const [pid, prov] of Object.entries(legacy.providers)) {
        store.providers[pid] = normalizeProviderEntry(pid, prov);
      }
    }
    store.updatedAt = nowIso();
    return store;
  } catch {
    return null;
  }
}

// ── In-memory cache — invalidated on every write ────────────────
let _storeCache = null;

function loadAuthStore() {
  if (_storeCache) return _storeCache;
  const storePath = getAuthStorePath();
  if (fs.existsSync(storePath)) {
    try {
      _storeCache = normalizeStore(JSON.parse(fs.readFileSync(storePath, "utf8")));
      return _storeCache;
    } catch {
      return defaultStore();
    }
  }
  const migrated = migrateLegacyProviders();
  const store = migrated || defaultStore();
  try {
    saveAuthStore(store);
  } catch (e) {
    console.warn(`[authStore] Khong luu duoc store: ${e.message}`);
  }
  return store;
}

function saveAuthStore(store) {
  _storeCache = null; // invalidate cache on every write
  const storePath = getAuthStorePath();
  const dir = path.dirname(storePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  const normalized = normalizeStore(store);
  normalized.updatedAt = nowIso();
  try {
    fs.writeFileSync(storePath, JSON.stringify(normalized, null, 2), "utf8");
  } catch (e) {
    throw new Error(`Khong ghi duoc auth store (${storePath}): ${e.message}`);
  }
  _storeCache = normalized; // re-populate cache with freshly written value
  return normalized;
}

/** Back-compat shape for providerRouter / admin providers API */
function loadProviders() {
  const s = loadAuthStore();
  return {
    activeProvider: s.activeProvider,
    providers: s.providers,
  };
}

function saveProviders(data) {
  const store = loadAuthStore();
  if (Object.prototype.hasOwnProperty.call(data, "activeProvider")) {
    store.activeProvider = data.activeProvider || null;
  }
  if (data.providers) {
    for (const [pid, prov] of Object.entries(data.providers)) {
      store.providers[pid] = normalizeProviderEntry(pid, { ...store.providers[pid], ...prov });
    }
  }
  for (const [pid, prov] of Object.entries(store.providers)) {
    prov.enabled = pid === store.activeProvider;
  }
  return saveAuthStore(store);
}

function exportBackup() {
  return loadAuthStore();
}

function importBackup(payload, { merge = false } = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid backup JSON");
  }
  const incoming = normalizeStore(payload);
  if (!merge) {
    return saveAuthStore(incoming);
  }
  const current = loadAuthStore();
  const merged = normalizeStore({
    ...current,
    activeProvider: incoming.activeProvider ?? current.activeProvider,
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
      ...incoming.clientKeys.filter(
        (c) => !current.clientKeys.some((x) => x.id === c.id)
      ),
    ],
    proxies: [
      ...current.proxies,
      ...incoming.proxies.filter(
        (c) => !current.proxies.some((x) => x.id === c.id)
      ),
    ],
  });
  return saveAuthStore(merged);
}

function listOAuthConnections(providerId) {
  const store = loadAuthStore();
  const list = store.oauth.connections;
  if (!providerId) return list;
  return list.filter((c) => c.provider === providerId);
}

function rotateOAuthConnection(providerId) {
  const store = loadAuthStore();
  const idx = store.oauth.connections.findIndex((c) => c.provider === providerId);
  if (idx < 0) return false;
  const tail = store.oauth.connections.filter((c) => c.provider === providerId);
  if (tail.length <= 1) return false;
  const [first, ...rest] = tail;
  const others = store.oauth.connections.filter((c) => c.provider !== providerId);
  store.oauth.connections = [...others, ...rest, first];
  saveAuthStore(store);
  return true;
}

function getOAuthConnection(connectionId) {
  return loadAuthStore().oauth.connections.find((c) => c.id === connectionId) || null;
}

function upsertOAuthConnection(connection) {
  const store = loadAuthStore();
  const idx = store.oauth.connections.findIndex((c) => c.id === connection.id);
  const row = {
    ...connection,
    updatedAt: nowIso(),
    createdAt: connection.createdAt || nowIso(),
  };
  if (idx >= 0) store.oauth.connections[idx] = { ...store.oauth.connections[idx], ...row };
  else store.oauth.connections.push(row);
  saveAuthStore(store);
  return row;
}

function removeOAuthConnection(connectionId) {
  const store = loadAuthStore();
  const before = store.oauth.connections.length;
  store.oauth.connections = store.oauth.connections.filter((c) => c.id !== connectionId);
  if (store.oauth.connections.length === before) return false;
  saveAuthStore(store);
  return true;
}

function sanitizeConnectionPublic(c) {
  return {
    id: c.id,
    provider: c.provider,
    driver: c.driver,
    email: c.email,
    label: c.label,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    hasRefreshToken: Boolean(c.refreshToken),
    tokenPreview: c.accessToken ? "…" + c.accessToken.slice(-6) : null,
  };
}

function listOAuthConnectionsPublic(providerId) {
  return listOAuthConnections(providerId).map(sanitizeConnectionPublic);
}

function getClientKeys() {
  const store = loadAuthStore();
  return store.clientKeys || [];
}

function addClientKey(label) {
  const store = loadAuthStore();
  const rawKey = "sk-xmitm-" + crypto.randomBytes(24).toString("hex");
  const newKey = {
    id: crypto.randomUUID(),
    key: rawKey,
    label: label || "Unnamed Key",
    createdAt: nowIso(),
  };
  store.clientKeys = store.clientKeys || [];
  store.clientKeys.push(newKey);
  saveAuthStore(store);
  return newKey;
}

function removeClientKey(id) {
  const store = loadAuthStore();
  const before = store.clientKeys.length;
  store.clientKeys = (store.clientKeys || []).filter((k) => k.id !== id);
  if (store.clientKeys.length === before) return false;
  saveAuthStore(store);
  return true;
}

function validateClientKey(token) {
  const store = loadAuthStore();
  const keys = store.clientKeys || [];
  // If no client keys are set up, authorization is bypassed (backward-compatible)
  if (keys.length === 0) return true;
  if (!token) return false;
  return keys.some((k) => k.key === token);
}

function getProxies() {
  const store = loadAuthStore();
  return store.proxies || [];
}

function addProxy(label, url, type) {
  const store = loadAuthStore();
  const newProxy = {
    id: crypto.randomUUID(),
    label: label || "Unnamed Proxy",
    url: url,
    type: type || "http",
    createdAt: nowIso(),
  };
  store.proxies = store.proxies || [];
  store.proxies.push(newProxy);
  saveAuthStore(store);
  return newProxy;
}

function removeProxy(id) {
  const store = loadAuthStore();
  const before = store.proxies.length;
  store.proxies = (store.proxies || []).filter((p) => p.id !== id);
  if (store.proxies.length === before) return false;
  
  // Clean up proxy reference from any provider
  if (store.providers) {
    for (const prov of Object.values(store.providers)) {
      if (prov.proxyId === id) {
        prov.proxyId = null;
      }
    }
  }
  
  saveAuthStore(store);
  return true;
}

module.exports = {
  getAuthStorePath,
  STORE_VERSION,
  loadAuthStore,
  saveAuthStore,
  loadProviders,
  saveProviders,
  exportBackup,
  importBackup,
  listOAuthConnections,
  listOAuthConnectionsPublic,
  getOAuthConnection,
  upsertOAuthConnection,
  removeOAuthConnection,
  rotateOAuthConnection,
  getClientKeys,
  addClientKey,
  removeClientKey,
  validateClientKey,
  getProxies,
  addProxy,
  removeProxy,
};

