/**
 * authStore.js — Provider keys, OAuth tokens — persisted in data/config.json
 */
const crypto = require("crypto");
const { defaultProviderEntries, getProviderMeta } = require("./providerMeta");
const { loadConfig, saveConfig, getConfigPath } = require("./configStore");

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
    rotateEnabled: prov?.rotateEnabled === true,
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
  return null;
}

function authSliceFromConfig(cfg) {
  return {
    version: cfg.version,
    updatedAt: cfg.updatedAt,
    activeProvider: cfg.activeProvider,
    providers: cfg.providers,
    oauth: cfg.oauth,
    clientKeys: cfg.clientKeys,
    proxies: cfg.proxies,
    dns: cfg.dns,
  };
}

function loadAuthStore() {
  const cfg = loadConfig();
  return normalizeStore(authSliceFromConfig(cfg));
}

function saveAuthStore(store) {
  const cfg = loadConfig();
  const normalized = normalizeStore(store);
  cfg.activeProvider = normalized.activeProvider;
  cfg.providers = normalized.providers;
  cfg.oauth = normalized.oauth;
  cfg.clientKeys = normalized.clientKeys;
  cfg.proxies = normalized.proxies;
  cfg.dns = normalized.dns;
  const saved = saveConfig(cfg);
  return normalizeStore(authSliceFromConfig(saved));
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
  getAuthStorePath: getConfigPath,
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

