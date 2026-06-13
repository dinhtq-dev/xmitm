const crypto = require("crypto");
const { getOAuthConfig, getDriverCredentials } = require("./registry");
const { createState, consumeState } = require("./state");
const { exchangeGoogle, refreshGoogle, exchangeGithub } = require("./drivers");
const { upsertOAuthConnection, getOAuthConnection } = require("../authStore");

const { getOAuthRedirectBase } = require("../configStore");

function getRedirectUri(req) {
  const base = getOAuthRedirectBase();
  if (base) return `${base}/api/admin/oauth/callback`;
  const host = req.headers.host || "127.0.0.1:3000";
  return `http://${host}/api/admin/oauth/callback`;
}

function buildAuthorizeUrl(providerId, req) {
  const cfg = getOAuthConfig(providerId);
  if (!cfg) throw new Error("Provider khong ho tro OAuth");
  const creds = getDriverCredentials(cfg.driver);
  if (!creds.ok) throw new Error(creds.error);

  const driver = creds.driver;
  if (!driver.authUrl) throw new Error(creds.error || "OAuth chua cau hinh");

  const redirectUri = getRedirectUri(req);
  const state = createState(providerId);
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });

  if (cfg.driver === "github") {
    params.delete("access_type");
    params.delete("prompt");
  }

  return {
    url: `${driver.authUrl}?${params.toString()}`,
    state,
    redirectUri,
  };
}

async function handleCallback(query, req) {
  const { code, state, error, error_description: errorDesc } = query;
  if (error) throw new Error(errorDesc || error);
  if (!code || !state) throw new Error("Thieu code/state OAuth");

  const st = consumeState(state);
  if (!st) throw new Error("OAuth state het han hoac khong hop le");
  const providerId = st.providerId;

  const cfg = getOAuthConfig(providerId);
  if (!cfg) throw new Error("Provider khong hop le");
  const creds = getDriverCredentials(cfg.driver);
  if (!creds.ok) throw new Error(creds.error);

  const redirectUri = getRedirectUri(req);
  let tokens;
  if (cfg.driver === "google") {
    tokens = await exchangeGoogle({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      redirectUri,
    });
  } else if (cfg.driver === "github") {
    tokens = await exchangeGithub({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      redirectUri,
    });
  } else {
    throw new Error(`Driver ${cfg.driver} chua implement exchange`);
  }

  const expiresAt = tokens.expiresIn
    ? new Date(Date.now() + Number(tokens.expiresIn) * 1000).toISOString()
    : null;

  const { listOAuthConnections } = require("../authStore");
  const existing = listOAuthConnections(providerId).find(
    (c) => (tokens.email && c.email === tokens.email) || c.label === tokens.label
  );

  const connection = upsertOAuthConnection({
    id: existing?.id || crypto.randomUUID(),
    provider: providerId,
    driver: cfg.driver,
    email: tokens.email,
    label: tokens.label,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt,
    extra: tokens.extra || {},
  });

  return { providerId, connectionId: connection.id, label: connection.label };
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;

function isConnectionExpired(conn) {
  if (!conn?.expiresAt) return false;
  return Date.parse(conn.expiresAt) - Date.now() < REFRESH_SKEW_MS;
}

async function ensureFreshConnection(connectionId) {
  const conn = getOAuthConnection(connectionId);
  if (!conn) throw new Error("OAuth connection not found");
  if (!isConnectionExpired(conn)) return conn;
  if (!conn.refreshToken) throw new Error("OAuth token het han — login lai");
  return refreshConnection(connectionId);
}

async function refreshConnection(connectionId) {
  const conn = getOAuthConnection(connectionId);
  if (!conn) throw new Error("Connection not found");
  if (!conn.refreshToken) throw new Error("Khong co refresh token");

  const creds = getDriverCredentials(conn.driver);
  if (!creds.ok) throw new Error(creds.error);

  let tokens;
  if (conn.driver === "google") {
    tokens = await refreshGoogle({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: conn.refreshToken,
    });
  } else {
    throw new Error(`Refresh chua ho tro driver ${conn.driver}`);
  }

  const expiresAt = tokens.expiresIn
    ? new Date(Date.now() + Number(tokens.expiresIn) * 1000).toISOString()
    : conn.expiresAt;

  return upsertOAuthConnection({
    ...conn,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || conn.refreshToken,
    expiresAt,
  });
}

module.exports = {
  buildAuthorizeUrl,
  handleCallback,
  refreshConnection,
  ensureFreshConnection,
  getRedirectUri,
};
