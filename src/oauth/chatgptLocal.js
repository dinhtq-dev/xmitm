/**
 * chatgptLocal.js — Import ChatGPT / Codex CLI session from ~/.codex/auth.json
 */
const crypto = require("crypto");
const { getCredentials } = require("../credentials");
const { loadAuthStore, saveAuthStore, upsertOAuthConnection, listOAuthConnections } = require("../authStore");

function importChatGPTFromLocal() {
  const creds = getCredentials("chatgpt");
  if (creds?.error) throw new Error(creds.error);

  const store = loadAuthStore();
  if (!store.providers.chatgpt) {
    store.providers.chatgpt = {
      baseUrl: "https://api.openai.com/v1",
      keys: [],
      enabled: false,
      authMode: "apikey",
    };
  }

  if (creds.authMode === "apikey") {
    const key = creds.accessToken;
    const keys = Array.isArray(store.providers.chatgpt.keys) ? store.providers.chatgpt.keys.filter(Boolean) : [];
    if (!keys.includes(key)) keys.unshift(key);
    store.providers.chatgpt.keys = keys;
    store.providers.chatgpt.authMode = "apikey";
    saveAuthStore(store);
    return {
      kind: "apikey",
      providerId: "chatgpt",
      label: "Codex API key",
      keysAdded: 1,
    };
  }

  if (!creds.accessToken) {
    throw new Error(
      "Khong tim thay token ChatGPT. Chay `codex login` (ChatGPT account) hoac dat cli_auth_credentials_store = \"file\" trong ~/.codex/config.toml"
    );
  }

  const email = creds.extra?.email || creds.extra?.accountId || null;
  const existing = listOAuthConnections("chatgpt").find(
    (c) => (email && c.email === email) || c.driver === "local"
  );

  const connection = upsertOAuthConnection({
    id: existing?.id || crypto.randomUUID(),
    provider: "chatgpt",
    driver: "local",
    email,
    label: email || creds.extra?.authMode || "ChatGPT (Codex)",
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken || "",
    expiresAt: creds.extra?.expiresAt || null,
    extra: {
      authMode: creds.extra?.authMode || creds.authMode,
      accountId: creds.extra?.accountId || null,
      importedFrom: "codex-auth-json",
      codexHome: creds.paths?.codexHome || null,
    },
  });

  store.providers.chatgpt.authMode = "oauth";
  saveAuthStore(store);

  return {
    kind: "oauth",
    providerId: "chatgpt",
    connectionId: connection.id,
    label: connection.label,
    email: connection.email,
  };
}

module.exports = { importChatGPTFromLocal };
