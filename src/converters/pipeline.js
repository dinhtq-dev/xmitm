const { err, log } = require("../logger");
const { getClientConverter, getProviderConverter } = require("./registry");
const { syncBodyBuffer, parseJsonBody } = require("./context");
const { enrichContextWithDetection } = require("./detectFormat");

async function runConverterHook(converter, hookName, ctx, label) {
  if (!converter || typeof converter[hookName] !== "function") return ctx;
  try {
    const out = await converter[hookName](ctx);
    return syncBodyBuffer(out || ctx);
  } catch (e) {
    err(`[Converter:${label}] ${hookName} failed: ${e.message}`);
    throw e;
  }
}

async function runClientRequest(ctx) {
  const converter = getClientConverter(ctx.clientTool);
  if (converter && typeof converter.convertRequest === "function") {
    return runConverterHook(converter, "convertRequest", ctx, ctx.clientTool);
  }
  if (ctx.mappedModel && ctx.body && ctx.body.model !== undefined) {
    ctx.body.model = ctx.mappedModel;
  }
  return syncBodyBuffer(ctx);
}

async function runClientResponse(ctx) {
  const converter = getClientConverter(ctx.clientTool);
  if (converter && typeof converter.convertResponse === "function") {
    return runConverterHook(converter, "convertResponse", ctx, ctx.clientTool);
  }
  return ctx;
}

async function runProviderRequest(ctx) {
  const converter = getProviderConverter(ctx.providerId);
  if (!converter) return syncBodyBuffer(ctx);
  ctx = enrichContextWithDetection(ctx);
  log(`[CustomAPI] provider req ${ctx.providerId}: ${ctx.meta?.detectedRequestFormat || "?"}`);
  return runConverterHook(converter, "convertRequest", ctx, ctx.providerId);
}

async function runProviderResponse(ctx) {
  const converter = getProviderConverter(ctx.providerId);
  if (!converter) return ctx;
  if (!ctx.body && ctx.bodyBuffer?.length) {
    ctx.body = parseJsonBody(ctx.bodyBuffer);
  }
  ctx = enrichContextWithDetection(ctx);
  log(`[CustomAPI] provider res ${ctx.providerId}: ${ctx.meta?.detectedResponseFormat || "?"}`);
  return runConverterHook(converter, "convertResponse", ctx, ctx.providerId);
}

function transformClientResponseChunk(ctx, chunk) {
  return chunk;
}

function transformProviderResponseChunk(ctx, chunk) {
  const converter = getProviderConverter(ctx.providerId);
  if (!converter || typeof converter.transformProviderStream !== "function") return chunk;
  try {
    return converter.transformProviderStream(ctx, chunk);
  } catch (e) {
    err(`[Converter:${ctx.providerId}] transformProviderStream: ${e.message}`);
    return chunk;
  }
}

module.exports = {
  runClientRequest,
  runClientResponse,
  runProviderRequest,
  runProviderResponse,
  transformClientResponseChunk,
  transformProviderResponseChunk,
};
