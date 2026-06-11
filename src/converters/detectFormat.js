/**
 * Auto-detect wire format from URL, headers, and JSON body.
 * Used before client/provider converters run (no manual toggle per pair).
 */

const CLIENT_NATIVE = {
  cursor: "cursor",
  antigravity: "gemini",
  copilot: "openai",
  kiro: "codewhisperer",
  codex: "openai",
  claude: "anthropic",
};

function detectRequestFormat({ url = "", headers = {}, body = null, clientTool = null } = {}) {
  const u = String(url).toLowerCase();
  const ct = String(headers["content-type"] || headers["Content-Type"] || "").toLowerCase();

  if (/bidiappend|runsse|runpoll|\/run\b/.test(u)) {
    return { format: "cursor", source: "url", confidence: "high" };
  }
  if (/generatecontent|streamgeneratecontent/.test(u)) {
    return { format: "gemini", source: "url", confidence: "high" };
  }
  if (u.includes("/v1/messages")) {
    return { format: "anthropic", source: "url", confidence: "high" };
  }
  if (u.includes("/responses")) {
    return { format: "openai-responses", source: "url", confidence: "high" };
  }
  if (/generateassistantresponse|codewhisperer/.test(u)) {
    return { format: "codewhisperer", source: "url", confidence: "high" };
  }
  if (u.includes("/chat/completions")) {
    return { format: "openai", source: "url", confidence: "medium" };
  }

  if (ct.includes("application/vnd.amazon.eventstream")) {
    return { format: "codewhisperer", source: "content-type", confidence: "high" };
  }
  if (ct.includes("application/connect+json") || ct.includes("application/grpc")) {
    return { format: "cursor", source: "content-type", confidence: "medium" };
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (body.request?.contents || (Array.isArray(body.contents) && body.contents.length)) {
      return { format: "gemini", source: "body", confidence: "high" };
    }
    if (body.conversationState?.currentMessage || body.userInputMessage) {
      return { format: "codewhisperer", source: "body", confidence: "high" };
    }
    if (body.input != null && body.model && !Array.isArray(body.messages)) {
      return { format: "openai-responses", source: "body", confidence: "medium" };
    }
    if (Array.isArray(body.messages)) {
      const anthropic =
        body.max_tokens != null
        || typeof body.system === "string"
        || (Array.isArray(body.system) && body.system.length);
      return {
        format: anthropic ? "anthropic" : "openai",
        source: "body",
        confidence: "medium",
      };
    }
  }

  if (clientTool && CLIENT_NATIVE[clientTool]) {
    return {
      format: CLIENT_NATIVE[clientTool],
      source: "clientTool",
      confidence: "fallback",
    };
  }

  return { format: "unknown", source: "none", confidence: "none" };
}

function detectResponseFormat({ contentType = "", body = null, clientTool = null } = {}) {
  const ct = String(contentType).toLowerCase();

  if (ct.includes("text/event-stream")) {
    return { format: "openai-sse", source: "content-type", confidence: "high" };
  }
  if (ct.includes("application/vnd.amazon.eventstream")) {
    return { format: "codewhisperer-stream", source: "content-type", confidence: "high" };
  }
  if (ct.includes("application/connect+json")) {
    return { format: "cursor", source: "content-type", confidence: "medium" };
  }

  if (body && typeof body === "object") {
    if (body.candidates || body.response?.candidates) {
      return { format: "gemini", source: "body", confidence: "high" };
    }
    if (body.type === "message" && body.role) {
      return { format: "anthropic", source: "body", confidence: "high" };
    }
    if (body.object === "chat.completion" || Array.isArray(body.choices)) {
      return { format: "openai", source: "body", confidence: "high" };
    }
  }

  if (clientTool && CLIENT_NATIVE[clientTool]) {
    return { format: CLIENT_NATIVE[clientTool], source: "clientTool", confidence: "fallback" };
  }

  return { format: "unknown", source: "none", confidence: "none" };
}

function enrichContextWithDetection(ctx) {
  if (!ctx || typeof ctx !== "object") return ctx;
  ctx.meta = ctx.meta || {};

  if (ctx.phase === "response" || ctx.phase === "stream") {
    const detected = detectResponseFormat({
      contentType: ctx.headers?.["content-type"] || ctx.meta.contentType || "",
      body: ctx.body,
      clientTool: ctx.clientTool,
    });
    ctx.meta.detectedResponseFormat = detected.format;
    ctx.meta.detectConfidence = detected.confidence;
    ctx.meta.detectSource = detected.source;
    if (!ctx.meta.nativeFormat || ctx.meta.nativeFormat === "unknown") {
      ctx.meta.nativeFormat = detected.format;
    }
    return ctx;
  }

  const detected = detectRequestFormat({
    url: ctx.url,
    headers: ctx.headers,
    body: ctx.body,
    clientTool: ctx.clientTool,
  });
  ctx.meta.detectedRequestFormat = detected.format;
  ctx.meta.detectConfidence = detected.confidence;
  ctx.meta.detectSource = detected.source;
  if (!ctx.meta.nativeFormat) ctx.meta.nativeFormat = detected.format;
  return ctx;
}

module.exports = {
  detectRequestFormat,
  detectResponseFormat,
  enrichContextWithDetection,
  CLIENT_NATIVE,
};
