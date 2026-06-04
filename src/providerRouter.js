/**
 * providerRouter.js — reads auth from auth-store via authStore (API keys + OAuth)
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { log, err } = require("./logger");
const { loadProviders, saveProviders, loadAuthStore, rotateOAuthConnection } = require("./authStore");
const { ensureFreshConnection } = require("./oauth/flow");
const { getProviderMeta } = require("./providerMeta");

const AUTH_BUILDERS = {
  anthropic: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  claude: (key) => ({ Authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" }),
  _default: (key) => ({ Authorization: `Bearer ${key}` }),
};

function buildAuthHeaders(providerId, key) {
  const builder = AUTH_BUILDERS[providerId] || AUTH_BUILDERS._default;
  return builder(key);
}

function resolveAuthMode(provider, meta, keys, oauthConns) {
  const preferred = provider.authMode || meta?.authModes?.[0] || "apikey";
  const hasKeys = keys.length > 0;
  const hasOauth = oauthConns.length > 0;

  if (preferred === "oauth" && hasOauth) return "oauth";
  if (preferred === "apikey" && hasKeys) return "apikey";
  if (hasKeys) return "apikey";
  if (hasOauth) return "oauth";
  return null;
}

function getActiveProvider() {
  const config = loadProviders();
  const store = loadAuthStore();
  const pid = config.activeProvider;
  const provider = config.providers[pid];
  if (!provider || provider.enabled === false) return null;

  const meta = getProviderMeta(pid);
  const keys = Array.isArray(provider.keys) ? provider.keys.filter(Boolean) : [];
  const oauthConns = store.oauth.connections.filter((c) => c.provider === pid && c.accessToken);
  const authMode = resolveAuthMode(provider, meta, keys, oauthConns);
  if (!authMode) return null;

  if (authMode === "apikey") {
    return {
      id: pid,
      baseUrl: provider.baseUrl,
      key: keys[0],
      totalKeys: keys.length,
      authType: "apikey",
    };
  }

  const conn = oauthConns[0];
  return {
    id: pid,
    baseUrl: provider.baseUrl,
    key: conn.accessToken,
    totalKeys: oauthConns.length,
    authType: "oauth",
    connectionId: conn.id,
    tokenLabel: conn.label || conn.email || conn.id.slice(0, 8),
  };
}

function rotateKey(providerId) {
  const config = loadProviders();
  const provider = config.providers[providerId];
  if (!provider || !provider.keys || provider.keys.length <= 1) return;
  const [first, ...rest] = provider.keys;
  provider.keys = [...rest, first];
  saveProviders(config);
  log(`🔄 Key rotated for ${providerId} — now using key ending ...${provider.keys[0].slice(-6)}`);
}

function rotateAuth(providerId, authType) {
  if (authType === "oauth") {
    if (rotateOAuthConnection(providerId)) {
      log(`🔄 OAuth rotated for ${providerId}`);
    }
    return;
  }
  rotateKey(providerId);
}

async function forwardRequest(req, res, bodyBuffer) {
  let active = getActiveProvider();
  if (!active) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: "No enabled provider. Bat provider trong Admin → API Providers (API key hoac Login OAuth).",
        type: "provider_error",
        code: "no_provider",
      },
    }));
    return;
  }

  if (active.authType === "oauth") {
    try {
      const fresh = await ensureFreshConnection(active.connectionId);
      active = { ...active, key: fresh.accessToken };
    } catch (e) {
      err(`[Router] OAuth token error: ${e.message}`);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: `OAuth token loi (${active.id}): ${e.message}`,
          type: "oauth_error",
          code: "oauth_token",
        },
      }));
      return;
    }
  }

  const reqPath = req.url.replace(/^\/v1/, "");
  const targetUrl = new URL(active.baseUrl + reqPath);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  Object.assign(headers, buildAuthHeaders(active.id, active.key));
  if (bodyBuffer && bodyBuffer.length > 0) headers["content-length"] = bodyBuffer.length;

  const isHttps = targetUrl.protocol === "https:";
  const transport = isHttps ? https : http;
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers,
    timeout: 120000,
  };

  const authHint = active.authType === "oauth"
    ? `oauth:${active.tokenLabel}`
    : `key:...${active.key.slice(-6)}`;
  log(`🔀 [Router] ${req.method} ${req.url} → ${active.id} (${targetUrl.hostname}${reqPath}) [${authHint}]`);

  const proxyReq = transport.request(options, (proxyRes) => {
    const resHeaders = { ...proxyRes.headers };
    delete resHeaders["transfer-encoding"];
    res.writeHead(proxyRes.statusCode, resHeaders);
    proxyRes.pipe(res);
    proxyRes.on("end", () => {
      if (active.totalKeys > 1) rotateAuth(active.id, active.authType);
    });
  });

  proxyReq.on("error", (e) => {
    err(`[Router] Proxy error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Failed to reach provider ${active.id}: ${e.message}`, type: "proxy_error" } }));
    }
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Request to provider ${active.id} timed out`, type: "timeout_error" } }));
    }
  });

  if (bodyBuffer?.length) proxyReq.write(bodyBuffer);
  proxyReq.end();
}

module.exports = { loadProviders, saveProviders, getActiveProvider, rotateKey, forwardRequest };
