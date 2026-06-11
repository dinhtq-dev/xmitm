/**
 * opencodeLocal.js — Import OpenCode local CLI session config
 */
const crypto = require("crypto");
const path = require("path");
const { getCredentials } = require("../credentials");
const { loadAuthStore, saveAuthStore, upsertOAuthConnection, listOAuthConnections } = require("../authStore");
const { resolveOpencodeBinary } = require("../opencode/sessionProvider");

function importOpenCodeFromLocal() {
  const creds = getCredentials("opencode");
  if (creds?.error) throw new Error(creds.error);

  const binary = resolveOpencodeBinary();
  if (!binary) {
    throw new Error("Khong tim thay opencode CLI. Cai: npm install -g opencode-ai");
  }

  const store = loadAuthStore();
  if (!store.providers.opencode) {
    store.providers.opencode = {
      baseUrl: "http://127.0.0.1:4096",
      keys: [],
      enabled: false,
      authMode: "oauth",
    };
  }

  const apiKey = creds.accessToken && creds.accessToken !== "local-session"
    ? creds.accessToken
    : process.env.OPENCODE_API_KEY || "";

  if (apiKey) {
    const keys = Array.isArray(store.providers.opencode.keys)
      ? store.providers.opencode.keys.filter(Boolean)
      : [];
    if (!keys.includes(apiKey)) keys.unshift(apiKey);
    store.providers.opencode.keys = keys;
  }

  store.providers.opencode.baseUrl = creds.extra?.baseUrl || "http://127.0.0.1:4096";
  store.providers.opencode.authMode = "oauth";
  saveAuthStore(store);

  const existing = listOAuthConnections("opencode").find((c) => c.driver === "local");
  const projectDir = creds.extra?.projectDir || process.cwd();

  const connection = upsertOAuthConnection({
    id: existing?.id || crypto.randomUUID(),
    provider: "opencode",
    driver: "local",
    email: null,
    label: apiKey ? "OpenCode (local + API key)" : "OpenCode (local session)",
    accessToken: apiKey || "local-session",
    refreshToken: "",
    expiresAt: null,
    extra: {
      importedFrom: "opencode-local",
      binary,
      projectDir,
      servePort: Number(process.env.OPENCODE_SERVE_PORT || 4096),
      serveHostname: process.env.OPENCODE_SERVE_HOST || "127.0.0.1",
      authPath: creds.paths?.auth || null,
    },
  });

  return {
    kind: "oauth",
    providerId: "opencode",
    connectionId: connection.id,
    label: connection.label,
    projectDir,
  };
}

module.exports = { importOpenCodeFromLocal };
