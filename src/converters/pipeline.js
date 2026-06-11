const { err, log } = require("../logger");
const { getClientConverter, getProviderConverter } = require("./registry");
const { syncBodyBuffer, parseJsonBody } = require("./context");
const { isApiProxyConvertEnabled, isMitmConvertEnabled } = require("./toggles");
const { enrichContextWithDetection } = require("./detectFormat");

function clientConvertEnabled(ctx, phase) {
  if (ctx?.meta?.via === "apiProxy" || ctx?.meta?.via === "providerRouter") {
    return isApiProxyConvertEnabled(ctx.clientTool, phase);
  }
  return isMitmConvertEnabled(ctx.clientTool, phase);
}

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
  if (!clientConvertEnabled(ctx, "request")) return syncBodyBuffer(ctx);
  const converter = getClientConverter(ctx.clientTool);
  if (!converter) return syncBodyBuffer(ctx);
  ctx = enrichContextWithDetection(ctx);
  const fmt = ctx.meta?.detectedRequestFormat || ctx.meta?.nativeFormat || "?";
  log(`[CustomAPI] req ${ctx.clientTool}: ${fmt}`);
  return runConverterHook(converter, "convertRequest", ctx, ctx.clientTool);
}

async function runClientResponse(ctx) {
  if (!clientConvertEnabled(ctx, "response")) return ctx;
  const converter = getClientConverter(ctx.clientTool);
  if (!converter) return ctx;
  ctx = enrichContextWithDetection(ctx);
  const fmt = ctx.meta?.detectedResponseFormat || ctx.meta?.nativeFormat || "?";
  log(`[CustomAPI] res ${ctx.clientTool}: ${fmt}`);
  return runConverterHook(converter, "convertResponse", ctx, ctx.clientTool);
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
  if (!clientConvertEnabled(ctx, "stream")) return chunk;
  const converter = getClientConverter(ctx.clientTool);
  if (!converter || typeof converter.transformResponseStream !== "function") return chunk;
  try {
    return converter.transformResponseStream(ctx, chunk);
  } catch (e) {
    err(`[Converter:${ctx.clientTool}] transformResponseStream: ${e.message}`);
    return chunk;
  }
}

function transformProviderResponseChunk(ctx, chunk) {
  const converter = getProviderConverter(ctx.providerId);
  if (!converter || typeof converter.transformResponseStream !== "function") return chunk;
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
