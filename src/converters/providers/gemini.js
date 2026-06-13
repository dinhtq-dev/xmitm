const { registerProviderConverter } = require("../registry");
const { loadProviders } = require("../../authStore");
const { getAntigravityProjectId } = require("../../configStore");
const {
  openAiBodyToAntigravity,
  geminiResponseToOpenAi,
  geminiStreamChunkToOpenAiSse,
} = require("../formats/openai-gemini");

function resolveAntigravityProject(providerId) {
  const fromConfig = getAntigravityProjectId();
  if (fromConfig) return fromConfig;
  try {
    const cfg = loadProviders();
    const prov = cfg?.providers?.[providerId];
    if (prov?.projectId) return prov.projectId;
    if (prov?.project) return prov.project;
  } catch { /* ignore */ }
  return "";
}

function isOpenAiChatBody(body) {
  return body && Array.isArray(body.messages) && !body.request?.contents;
}

async function convertAntigravityRequest(ctx) {
  if (!ctx.body || !isOpenAiChatBody(ctx.body)) return ctx;

  const stream = ctx.body.stream === true;
  const project = resolveAntigravityProject(ctx.providerId);
  if (!project) {
    throw new Error(
      "Thiếu Antigravity project ID — thêm system.antigravityProjectId trong config.json hoặc providers.*.projectId"
    );
  }

  ctx._openAiModel = ctx.body.model;
  ctx.body = openAiBodyToAntigravity(ctx.body, {
    project,
    model: ctx.body.model,
    stream,
  });
  ctx.reqPath = stream
    ? "/v1internal:streamGenerateContent?alt=sse"
    : "/v1internal:generateContent";
  ctx.meta.targetFormat = "antigravity";
  ctx.meta.sourceFormat = "openai";
  ctx.stream = stream;
  return ctx;
}

async function convertAntigravityResponse(ctx) {
  const model = ctx._openAiModel || ctx.body?.model;
  const geminiBody = ctx.body?.response ? ctx.body : ctx.body;
  if (!geminiBody?.candidates && !geminiBody?.response?.candidates) return ctx;

  ctx.body = geminiResponseToOpenAi(geminiBody, model);
  ctx.meta.targetFormat = "openai";
  return ctx;
}

registerProviderConverter("gemini", {
  async convertRequest(ctx) {
    ctx.meta.targetFormat = "openai-compat-gemini";
    return ctx;
  },
  async convertResponse(ctx) {
    if (ctx.body?.candidates) {
      ctx.body = geminiResponseToOpenAi(ctx.body, ctx._openAiModel);
    }
    return ctx;
  },
});

registerProviderConverter("gemini-cli", {
  convertRequest: convertAntigravityRequest,
  convertResponse: convertAntigravityResponse,
  transformProviderStream(ctx, chunk) {
    if (!ctx._sseState) ctx._sseState = {};
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    const lines = text.split("\n");
    const out = [];
    for (const line of lines) {
      const converted = geminiStreamChunkToOpenAiSse(line, ctx._openAiModel, ctx._sseState);
      if (converted) out.push(converted);
    }
    return out.length ? Buffer.from(out.join("")) : null;
  },
});

registerProviderConverter("antigravity", {
  convertRequest: convertAntigravityRequest,
  convertResponse: convertAntigravityResponse,
  transformProviderStream(ctx, chunk) {
    if (!ctx._sseState) ctx._sseState = {};
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    const lines = text.split("\n");
    const out = [];
    for (const line of lines) {
      const converted = geminiStreamChunkToOpenAiSse(line, ctx._openAiModel, ctx._sseState);
      if (converted) out.push(converted);
    }
    return out.length ? Buffer.from(out.join("")) : null;
  },
});
