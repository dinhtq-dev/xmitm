/**
 * Build shared context objects for client/provider converters.
 *
 * Client converters: IDE native format (Antigravity, Copilot, Kiro, Cursor)
 * Provider converters: upstream API format (OpenAI, Anthropic, Gemini, …)
 */

function parseJsonBody(bodyBuffer) {
  if (!bodyBuffer || bodyBuffer.length === 0) return null;
  try {
    return JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return null;
  }
}

function buildClientContext({ clientTool, req, bodyBuffer, mappedModel, meta = {} }) {
  const url = req.url || "/";
  return {
    phase: "request",
    clientTool,
    providerId: null,
    method: req.method || "POST",
    url,
    headers: { ...req.headers },
    bodyBuffer: Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer || ""),
    body: parseJsonBody(bodyBuffer),
    mappedModel: mappedModel || null,
    stream: url.includes("stream") || url.includes("SSE") || url.includes("EventStream"),
    meta: { ...meta },
  };
}

function buildProviderContext({ providerId, req, bodyBuffer, reqPath, active, meta = {} }) {
  return {
    phase: "request",
    clientTool: null,
    providerId,
    method: req.method || "POST",
    url: req.url || "/",
    reqPath: reqPath || req.url || "/",
    headers: { ...req.headers },
    bodyBuffer: Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer || ""),
    body: parseJsonBody(bodyBuffer),
    mappedModel: null,
    stream: false,
    responseFormat: active?.responseFormat || "origin",
    authType: active?.authType || "apikey",
    meta: { ...meta },
  };
}

function syncBodyBuffer(ctx) {
  if (ctx.body != null && typeof ctx.body === "object") {
    ctx.bodyBuffer = Buffer.from(JSON.stringify(ctx.body));
  } else if (ctx.bodyBuffer?.length && ctx.body == null) {
    ctx.body = parseJsonBody(ctx.bodyBuffer);
  }
  return ctx;
}

module.exports = {
  parseJsonBody,
  buildClientContext,
  buildProviderContext,
  syncBodyBuffer,
};
