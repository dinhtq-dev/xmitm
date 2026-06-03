/**
 * providerRouter.js — Provider Router middleware
 * 
 * Receives requests from MITM proxy at /v1/...
 * Reads active provider + key from providers.json
 * Forwards request to the real provider API
 * Supports streaming (SSE) and regular JSON responses
 * Auto-rotates keys round-robin after each request
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { log, err } = require("./logger");

// ── File path ──────────────────────────────────────────────────
const PROVIDERS_FILE = path.join(__dirname, "..", "providers.json");

// ── Default provider config ────────────────────────────────────
const DEFAULT_PROVIDERS = {
  activeProvider: null,
  providers: {
    openai:     { baseUrl: "https://api.openai.com/v1",       keys: [], enabled: false },
    anthropic:  { baseUrl: "https://api.anthropic.com/v1",    keys: [], enabled: false },
    deepseek:   { baseUrl: "https://api.deepseek.com/v1",     keys: [], enabled: false },
    groq:       { baseUrl: "https://api.groq.com/openai/v1",  keys: [], enabled: false },
    mistral:    { baseUrl: "https://api.mistral.ai/v1",       keys: [], enabled: false },
    together:   { baseUrl: "https://api.together.xyz/v1",     keys: [], enabled: false },
    cohere:     { baseUrl: "https://api.cohere.ai/v1",        keys: [], enabled: false },
    perplexity: { baseUrl: "https://api.perplexity.ai",       keys: [], enabled: false },
    gemini:     { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keys: [], enabled: false },
  },
};

function normalizeProviders(data) {
  const out = { ...data, providers: { ...data.providers } };
  for (const [pid, prov] of Object.entries(out.providers)) {
    out.providers[pid] = {
      baseUrl: prov.baseUrl || "",
      keys: Array.isArray(prov.keys) ? prov.keys : [],
      enabled: prov.enabled === true,
    };
  }
  if (out.activeProvider && out.providers[out.activeProvider]) {
    out.providers[out.activeProvider].enabled = true;
  } else if (out.activeProvider && !out.providers[out.activeProvider]) {
    out.activeProvider = null;
  }
  return out;
}

// ── Provider-specific auth header builders ─────────────────────
// Most providers use Bearer auth. Anthropic is the main exception.
const AUTH_BUILDERS = {
  anthropic: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  _default:  (key) => ({ Authorization: `Bearer ${key}` }),
};

function buildAuthHeaders(providerId, key) {
  const builder = AUTH_BUILDERS[providerId] || AUTH_BUILDERS._default;
  return builder(key);
}

// ── Load / Save ────────────────────────────────────────────────

function loadProviders() {
  try {
    const raw = fs.readFileSync(PROVIDERS_FILE, "utf-8");
    return normalizeProviders(JSON.parse(raw));
  } catch {
    // File missing or corrupt — create default
    saveProviders(DEFAULT_PROVIDERS);
    return normalizeProviders({ ...DEFAULT_PROVIDERS });
  }
}

function saveProviders(data) {
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ── Active provider + key ──────────────────────────────────────

function getActiveProvider() {
  const config = loadProviders();
  const pid = config.activeProvider;
  const provider = config.providers[pid];
  if (!provider || provider.enabled === false || !provider.keys || provider.keys.length === 0) {
    return null;
  }
  return {
    id: pid,
    baseUrl: provider.baseUrl,
    key: provider.keys[0],
    totalKeys: provider.keys.length,
  };
}

// ── Rotate key (move first key to end) ─────────────────────────

function rotateKey(providerId) {
  const config = loadProviders();
  const provider = config.providers[providerId];
  if (!provider || !provider.keys || provider.keys.length <= 1) return;
  const [first, ...rest] = provider.keys;
  provider.keys = [...rest, first];
  saveProviders(config);
  log(`🔄 Key rotated for ${providerId} — now using key ending ...${provider.keys[0].slice(-6)}`);
}

// ── Forward Request to Provider ────────────────────────────────

function forwardRequest(req, res, bodyBuffer) {
  const active = getActiveProvider();
  if (!active) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: "No enabled provider or no API keys configured. Turn ON a provider and add a key in Admin UI → API Providers.",
        type: "provider_error",
        code: "no_provider"
      }
    }));
    return;
  }

  // Build target URL: replace /v1/... with provider's baseUrl + path
  const reqPath = req.url.replace(/^\/v1/, "");   // e.g. /chat/completions
  const targetUrl = new URL(active.baseUrl + reqPath);

  // Build headers — copy original, override auth + host
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];

  // Set auth headers for the provider
  const authHeaders = buildAuthHeaders(active.id, active.key);
  Object.assign(headers, authHeaders);

  // Set content-length from body
  if (bodyBuffer && bodyBuffer.length > 0) {
    headers["content-length"] = bodyBuffer.length;
  }

  const isHttps = targetUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers,
    timeout: 120000, // 2 min timeout for long generation requests
  };

  log(`🔀 [Router] ${req.method} ${req.url} → ${active.id} (${targetUrl.hostname}${reqPath}) [key: ...${active.key.slice(-6)}]`);

  const proxyReq = transport.request(options, (proxyRes) => {
    // Copy status + headers from provider response
    const resHeaders = { ...proxyRes.headers };
    // Remove hop-by-hop headers
    delete resHeaders["transfer-encoding"];
    // Keep content-type, especially for streaming
    res.writeHead(proxyRes.statusCode, resHeaders);

    // Stream response back
    proxyRes.pipe(res);

    proxyRes.on("end", () => {
      // Auto-rotate key after successful request (round-robin)
      if (active.totalKeys > 1) {
        rotateKey(active.id);
      }
    });
  });

  proxyReq.on("error", (e) => {
    err(`[Router] Proxy error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: `Failed to reach provider ${active.id}: ${e.message}`,
          type: "proxy_error",
          code: "upstream_error"
        }
      }));
    }
  });

  proxyReq.on("timeout", () => {
    err(`[Router] Request timeout to ${active.id}`);
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: `Request to provider ${active.id} timed out`,
          type: "timeout_error",
          code: "timeout"
        }
      }));
    }
  });

  // Send body
  if (bodyBuffer && bodyBuffer.length > 0) {
    proxyReq.write(bodyBuffer);
  }
  proxyReq.end();
}

// ── Exports ────────────────────────────────────────────────────

module.exports = {
  loadProviders,
  saveProviders,
  getActiveProvider,
  rotateKey,
  forwardRequest,
};
