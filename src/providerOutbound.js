/**
 * providerOutbound.js — MITM / shared outbound via active API provider (OAuth/API key).
 */
const https = require("https");
const http = require("http");
const { Readable } = require("stream");
const crypto = require("crypto");
const { log, err } = require("./logger");
const { ensureFreshConnection } = require("./oauth/flow");
const { getAntigravityProjectId } = require("./configStore");
const { loadProviders } = require("./authStore");
const { openAiBodyToAntigravity } = require("./converters/formats/openai-gemini");
const {
  buildProviderContext,
  syncBodyBuffer,
  runProviderRequest,
  transformProviderResponseChunk,
  getProviderConverter,
  applyBufferedConverters,
} = require("./converters");
const { maybeRotateAfterRequest } = require("./providerRouter");
const { isStreamingContentType } = require("./converters/responsePipe");
const { resolveUpstreamEndpoint, isRedirectedHost, isLoopback } = require("./dns/bypassHostsLookup");

function buildAuthHeaders(providerId, key) {
  if (providerId === "anthropic" || providerId === "claude") {
    return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${key}` };
}

function resolveProjectId(providerId) {
  const fromConfig = getAntigravityProjectId();
  if (fromConfig) return fromConfig;
  try {
    const prov = loadProviders()?.providers?.[providerId];
    return prov?.projectId || prov?.project || "";
  } catch {
    return "";
  }
}

function isOpenAiChatBody(body) {
  return body && Array.isArray(body.messages) && !body.request?.contents;
}

function isGeminiNativeBody(body) {
  return !!(body?.request?.contents || body?.contents);
}

function isStreamRequest(meta = {}, body = {}) {
  const url = String(meta.reqUrl || "");
  if (url.includes("streamGenerateContent") || url.includes(":stream")) return true;
  if (body.stream === true || body.requestType === "stream") return true;
  return false;
}

function geminiNativeToAntigravity(body, { project, model, stream }) {
  const request = body.request || { contents: body.contents };
  return {
    project,
    model: model || body.model || "gemini-2.0-flash",
    request,
    userAgent: body.userAgent || "antigravity",
    requestId: body.requestId || `xmitm-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    requestType: stream ? "stream" : (body.requestType || "agent"),
  };
}

function nodeResponseToFetch(statusCode, headers, bodyBuffer) {
  const hdrs = new Headers();
  for (const [k, v] of Object.entries(headers || {})) {
    if (v != null) hdrs.set(k, String(v));
  }
  return new Response(bodyBuffer, { status: statusCode, headers: hdrs });
}

function httpsRequestStream(options, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const transport = options.protocol === "http:" ? http : https;
    const req = transport.request(options, (res) => {
      const webBody = Readable.toWeb(res);
      const hdrs = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (v == null) continue;
        hdrs.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      }
      resolve(new Response(webBody, { status: res.statusCode || 200, headers: hdrs }));
    });
    req.on("error", reject);
    req.setTimeout(180000, () => {
      req.destroy();
      reject(new Error("Provider request timed out"));
    });
    if (bodyBuffer?.length) req.write(bodyBuffer);
    req.end();
  });
}

function httpsRequestBuffered(options, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const transport = options.protocol === "http:" ? http : https;
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 200,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(180000, () => {
      req.destroy();
      reject(new Error("Provider request timed out"));
    });
    if (bodyBuffer?.length) req.write(bodyBuffer);
    req.end();
  });
}

async function refreshActive(active) {
  if (active.authType !== "oauth") return active;
  const fresh = await ensureFreshConnection(active.connectionId);
  return { ...active, key: fresh.accessToken };
}

function wrapResponseWithRotate(response, active) {
  if (!response?.body || active.totalKeys <= 1 || active.rotateEnabled !== true) {
    return response;
  }
  const reader = response.body.getReader();
  let rotated = false;
  const rotateOnce = () => {
    if (rotated) return;
    rotated = true;
    maybeRotateAfterRequest(active);
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          rotateOnce();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        rotateOnce();
        controller.error(e);
      }
    },
    cancel() {
      rotateOnce();
    },
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}

/**
 * Forward MITM outbound through active provider; returns fetch Response for pipeSSE.
 */
async function fetchViaActiveProvider(active, body, path = "/v1/chat/completions", clientHeaders = {}, meta = {}) {
  active = await refreshActive(active);

  const stream = isStreamRequest(meta, body);
  let reqPath = path.replace(/^\/v1/, "") || "/chat/completions";
  let bodyBuffer = Buffer.from(JSON.stringify(body || {}));

  let providerCtx = null;

  if (active.id === "gemini-cli" || active.id === "antigravity") {
    const project = resolveProjectId(active.id);
    if (!project) {
      throw new Error(
        "Thieu system.antigravityProjectId trong config.json — can thiet de goi Gemini Web tu MITM"
      );
    }
    let payload;
    if (isGeminiNativeBody(body)) {
      payload = geminiNativeToAntigravity(body, {
        project,
        model: body.model,
        stream,
      });
    } else if (isOpenAiChatBody(body)) {
      payload = openAiBodyToAntigravity(body, {
        project,
        model: body.model,
        stream,
      });
    } else {
      throw new Error("Khong nhan dang duoc format request cho Gemini provider");
    }
    reqPath = stream
      ? "/v1internal:streamGenerateContent?alt=sse"
      : "/v1internal:generateContent";
    bodyBuffer = Buffer.from(JSON.stringify(payload));
  } else {
    try {
      providerCtx = buildProviderContext({
        providerId: active.id,
        req: { method: "POST", url: path, headers: clientHeaders },
        bodyBuffer,
        reqPath,
        active,
      });
      providerCtx = await runProviderRequest(providerCtx);
      providerCtx = syncBodyBuffer(providerCtx);
      bodyBuffer = providerCtx.bodyBuffer;
      if (providerCtx.reqPath) reqPath = providerCtx.reqPath;
    } catch (e) {
      err(`[MITM] Provider request converter failed: ${e.message}`);
      throw e;
    }
  }

  const targetUrl = new URL(active.baseUrl + reqPath);
  const headers = {
    Host: targetUrl.hostname,
    "Content-Type": "application/json",
    "Content-Length": bodyBuffer.length,
    ...buildAuthHeaders(active.id, active.key),
  };

  log(`🔀 [MITM] → provider ${active.id} (${targetUrl.hostname}${reqPath}) [${active.authType}]`);

  let connectHost = targetUrl.hostname;
  if (isRedirectedHost(targetUrl.hostname)) {
    const ep = await resolveUpstreamEndpoint(targetUrl.hostname);
    if (isLoopback(ep.host)) {
      throw new Error(`DNS bypass failed: ${targetUrl.hostname} -> ${ep.host}`);
    }
    connectHost = ep.host;
  }

  const reqOptions = {
    protocol: targetUrl.protocol,
    host: connectHost,
    hostname: connectHost,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: "POST",
    headers,
    agent: false,
  };
  if (isRedirectedHost(targetUrl.hostname)) {
    reqOptions.servername = targetUrl.hostname;
  }

  if (stream || reqPath.includes("streamGenerateContent")) {
    const streamRes = await httpsRequestStream(reqOptions, bodyBuffer);
    return wrapResponseWithRotate(streamRes, active);
  }

  const result = await httpsRequestBuffered(reqOptions, bodyBuffer);

  let outBody = result.body;
  const ct = result.headers["content-type"] || "application/json";
  const isStream = isStreamingContentType(ct);

  if (!isStream && providerCtx) {
    outBody = await applyBufferedConverters(outBody, {
      providerCtx: { ...providerCtx, meta: { ...(providerCtx.meta || {}), contentType: ct } },
      requestedModel: null,
    });
  }

  maybeRotateAfterRequest(active);
  return nodeResponseToFetch(result.statusCode, result.headers, outBody);
}

module.exports = { fetchViaActiveProvider };
