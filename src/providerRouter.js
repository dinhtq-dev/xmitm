/**
 * providerRouter.js — reads auth from auth-store via authStore (API keys + OAuth)
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { log, err } = require("./logger");
const { loadProviders, saveProviders, loadAuthStore, rotateOAuthConnection, validateClientKey } = require("./authStore");
const { ensureFreshConnection } = require("./oauth/flow");
const { getProviderMeta } = require("./providerMeta");
const { getMitmAlias } = require("./dbReader");
const {
  buildClientContext,
  buildProviderContext,
  syncBodyBuffer,
  runClientRequest,
  runProviderRequest,
  transformProviderResponseChunk,
  transformClientResponseChunk,
  getProviderConverter,
  getApiProxyClient,
  applyBufferedConverters,
  applyFakeModelResponse,
  isStreamingContentType,
  pipeProxyResponse,
} = require("./converters");

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
      responseFormat: provider.responseFormat || "origin",
      proxyId: provider.proxyId || null,
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
    responseFormat: provider.responseFormat || "origin",
    proxyId: provider.proxyId || null,
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

function extractRequestedModel(bodyBuffer) {
  if (!bodyBuffer?.length) return null;
  try {
    const body = JSON.parse(bodyBuffer.toString());
    return body.model || null;
  } catch {
    return null;
  }
}

function applyCliModelMapping(bodyBuffer, req) {
  if (!bodyBuffer?.length || req.method !== "POST") return bodyBuffer;
  try {
    const cliAliases = getMitmAlias("cli") || {};
    const body = JSON.parse(bodyBuffer.toString());
    if (body.model && cliAliases[body.model]) {
      const originalModel = body.model;
      body.model = cliAliases[body.model];
      log(`🔁 [CLI Mapping] model: "${originalModel}" → "${body.model}"`);
      return Buffer.from(JSON.stringify(body));
    }
  } catch { /* non-JSON */ }
  return bodyBuffer;
}

async function buildApiProxyClientCtx(req, bodyBuffer, requestedModel = null) {
  const apiClient = getApiProxyClient();
  if (!apiClient || !bodyBuffer?.length || req.method !== "POST") return null;
  try {
    let clientCtx = buildClientContext({
      clientTool: apiClient,
      req,
      bodyBuffer,
      mappedModel: null,
      meta: {
        via: "apiProxy",
        requestedModel: requestedModel || extractRequestedModel(bodyBuffer),
      },
    });
    clientCtx = await runClientRequest(clientCtx);
    return syncBodyBuffer(clientCtx);
  } catch (e) {
    err(`[CustomAPI] client converter (${apiClient}) failed: ${e.message}`);
    return null;
  }
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

let HttpsProxyAgentClass = null;
let SocksProxyAgentClass = null;

function getProxyAgent(proxy) {
  if (!proxy || !proxy.url) return null;
  try {
    if (proxy.type === "socks5" || proxy.url.startsWith("socks")) {
      if (!SocksProxyAgentClass) {
        SocksProxyAgentClass = require("socks-proxy-agent").SocksProxyAgent;
      }
      return new SocksProxyAgentClass(proxy.url);
    } else {
      if (!HttpsProxyAgentClass) {
        HttpsProxyAgentClass = require("https-proxy-agent").HttpsProxyAgent;
      }
      return new HttpsProxyAgentClass(proxy.url);
    }
  } catch (e) {
    err(`[Proxy] Failed to initialize agent for ${proxy.label}: ${e.message}`);
    return null;
  }
}

async function forwardRequest(req, res, bodyBuffer) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!validateClientKey(token)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: "Incorrect API key. Specify a valid client API key in your request headers.",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    }));
    return;
  }

  let active = getActiveProvider();

  // Fallback to API Endpoint (MITM_ROUTER_BASE) when no provider is enabled
  if (!active) {
    const routerBase = (process.env.MITM_ROUTER_BASE || "").trim().replace(/\/+$/, "");
    const apiKey = process.env.ROUTER_API_KEY || "";
    if (!routerBase) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "No enabled provider and no API Endpoint configured. Enable a provider or set MITM_ROUTER_BASE in API Endpoint.",
          type: "provider_error",
          code: "no_provider",
        },
      }));
      return;
    }

    const requestedModel = extractRequestedModel(bodyBuffer);
    let finalBodyBuffer = applyCliModelMapping(bodyBuffer, req);
    const cliClientCtx = await buildApiProxyClientCtx(req, finalBodyBuffer, requestedModel);
    if (cliClientCtx) {
      finalBodyBuffer = cliClientCtx.bodyBuffer;
      log(`[CustomAPI] client=${cliClientCtx.clientTool} → 9router (auto res, fake model="${requestedModel || "?"}")`);
    } else if (getApiProxyClient()) {
      log(`[CustomAPI] client=${getApiProxyClient()} configured but ctx build skipped`);
    }

    const targetUrl = routerBase + req.url;
    log(`🔀 [Router] ${req.method} ${req.url} → API Endpoint (${routerBase}) [fallback]`);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    if (finalBodyBuffer?.length) headers["content-length"] = finalBodyBuffer.length;

    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers,
      timeout: 120000,
    };
    const proxyReq = transport.request(opts, (proxyRes) => {
      pipeProxyResponse(proxyRes, res, { clientCtx: cliClientCtx, requestedModel });
    });
    proxyReq.on("error", (e) => {
      err(`[Router] API Endpoint fallback error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `API Endpoint error: ${e.message}`, type: "proxy_error" } }));
      }
    });
    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "API Endpoint request timed out", type: "timeout_error" } }));
      }
    });
    if (finalBodyBuffer?.length) proxyReq.write(finalBodyBuffer);
    proxyReq.end();
    return;
  }

  let reqPath = req.url.replace(/^\/v1/, "");

  // Normalize paths for different provider types
  const openAiProviders = new Set([
    "openai", "chatgpt", "deepseek", "groq", "mistral",
    "together", "cohere", "perplexity", "gemini", "opencode"
  ]);
  const anthropicProviders = new Set(["anthropic", "claude"]);

  if (openAiProviders.has(active.id)) {
    if (reqPath === "/responses" || reqPath === "/messages") {
      reqPath = "/chat/completions";
    }
  } else if (anthropicProviders.has(active.id)) {
    if (reqPath === "/chat/completions" || reqPath === "/responses") {
      reqPath = "/messages";
    }
  }

  if (active.id === "opencode") {
    const opencodeSession = require("./opencode/sessionProvider");
    if (req.method === "POST" && reqPath.startsWith("/chat/completions")) {
      try {
        const payload = await opencodeSession.forwardChatCompletions(bodyBuffer, active.responseFormat);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (e) {
        err(`[Router] OpenCode session error: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: {
              message: `OpenCode session loi: ${e.message}`,
              type: "provider_error",
              code: "opencode_session",
            },
          }));
        }
      }
      return;
    }
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

  const requestedModel = extractRequestedModel(bodyBuffer);
  let finalBodyBuffer = applyCliModelMapping(bodyBuffer, req);

  const cliClientCtx = await buildApiProxyClientCtx(req, finalBodyBuffer, requestedModel);
  if (cliClientCtx) {
    finalBodyBuffer = cliClientCtx.bodyBuffer;
    log(`[CustomAPI] client=${cliClientCtx.clientTool} → provider=${active.id} (auto res, fake model="${requestedModel || "?"}")`);
  }

  // Provider request converter (OpenAI ↔ Anthropic ↔ Gemini …)
  let providerCtx = null;
  if (finalBodyBuffer?.length > 0 && req.method === "POST") {
    try {
      providerCtx = buildProviderContext({
        providerId: active.id,
        req,
        bodyBuffer: finalBodyBuffer,
        reqPath,
        active,
      });
      providerCtx = await runProviderRequest(providerCtx);
      providerCtx = syncBodyBuffer(providerCtx);
      finalBodyBuffer = providerCtx.bodyBuffer;
      if (providerCtx.reqPath) reqPath = providerCtx.reqPath;
    } catch (e) {
      err(`[Router] Provider request converter failed: ${e.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: { message: `Provider converter error: ${e.message}`, type: "converter_error" },
      }));
      return;
    }
  }

  const targetUrl = new URL(active.baseUrl + reqPath);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  Object.assign(headers, buildAuthHeaders(active.id, active.key));
  if (finalBodyBuffer && finalBodyBuffer.length > 0) headers["content-length"] = finalBodyBuffer.length;

  let agent = null;
  if (active.proxyId) {
    const store = loadAuthStore();
    const proxy = (store.proxies || []).find((p) => p.id === active.proxyId);
    if (proxy) {
      agent = getProxyAgent(proxy);
      if (agent) {
        log(`🌐 [Proxy Routing] Routing request to ${targetUrl.hostname} via ${proxy.label} (${proxy.type})`);
      }
    }
  }

  const isHttps = targetUrl.protocol === "https:";
  const transport = isHttps ? https : http;
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers,
    timeout: 120000,
    agent: agent || undefined,
  };

  const authHint = active.authType === "oauth"
    ? `oauth:${active.tokenLabel}`
    : `key:...${active.key.slice(-6)}`;
  log(`🔀 [Router] ${req.method} ${req.url} → ${active.id} (${targetUrl.hostname}${reqPath}) [${authHint}]`);

  const proxyReq = transport.request(options, (proxyRes) => {
    const ct = proxyRes.headers["content-type"] || "";
    const isStream = isStreamingContentType(ct);
    const providerConverter = providerCtx ? getProviderConverter(providerCtx.providerId) : null;
    const hasProviderStream = providerConverter && typeof providerConverter.transformProviderStream === "function";
    const needsBufferedConvert = !isStream && (providerCtx || cliClientCtx || requestedModel);

    const finish = () => {
      if (active.totalKeys > 1) rotateAuth(active.id, active.authType);
    };

    if (needsBufferedConvert) {
      const chunks = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", async () => {
        try {
          const buf = await applyBufferedConverters(Buffer.concat(chunks), {
            providerCtx: cliClientCtx ? null : (providerCtx
              ? { ...providerCtx, meta: { ...(providerCtx.meta || {}), contentType: ct } }
              : null),
            clientCtx: cliClientCtx
              ? { ...cliClientCtx, meta: { ...(cliClientCtx.meta || {}), contentType: ct } }
              : null,
            requestedModel,
          });
          if (!res.headersSent) {
            const resHeaders = { ...proxyRes.headers };
            delete resHeaders["transfer-encoding"];
            res.writeHead(proxyRes.statusCode, resHeaders);
          }
          res.end(buf);
        } catch (e) {
          err(`[Router] Buffered response convert failed: ${e.message}`);
          const raw = applyFakeModelResponse(Buffer.concat(chunks), requestedModel);
          if (!res.writableEnded) res.end(raw);
        }
        finish();
      });
      proxyRes.on("error", () => {
        if (!res.writableEnded) res.end();
        finish();
      });
      return;
    }

    if (isStream && (hasProviderStream || cliClientCtx)) {
      const resHeaders = { ...proxyRes.headers };
      delete resHeaders["transfer-encoding"];
      res.writeHead(proxyRes.statusCode, resHeaders);
      const streamProviderCtx = providerCtx ? { ...providerCtx, phase: "response" } : null;
      const streamClientCtx = cliClientCtx ? { ...cliClientCtx, phase: "response" } : null;
      proxyRes.on("data", (chunk) => {
        let out = chunk;
        if (streamProviderCtx) {
          out = transformProviderResponseChunk(streamProviderCtx, out);
        }
        if (streamClientCtx && out != null) {
          out = transformClientResponseChunk(streamClientCtx, out);
        }
        if (out != null) res.write(out);
      });
      proxyRes.on("end", () => {
        res.end();
        finish();
      });
      proxyRes.on("error", () => res.end());
      return;
    }

    pipeProxyResponse(proxyRes, res, {
      clientCtx: cliClientCtx,
      requestedModel,
      onFinish: finish,
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

  if (finalBodyBuffer?.length) proxyReq.write(finalBodyBuffer);
  proxyReq.end();
}

module.exports = { loadProviders, saveProviders, getActiveProvider, rotateKey, forwardRequest };
