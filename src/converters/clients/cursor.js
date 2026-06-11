const { registerClientConverter } = require("../registry");

const { detectRequestFormat } = require("../detectFormat");

function resolveRouterPath(url = "") {
  const u = String(url).toLowerCase();
  if (u.includes("/v1/messages")) return "/v1/messages";
  if (u.includes("/responses")) return "/v1/responses";
  return "/v1/chat/completions";
}

registerClientConverter("cursor", {
  /**
   * Cursor proprietary (RunSSE, BidiAppend) → OpenAI/Anthropic canonical for router.
   * Extend: decode Connect/gRPC body → messages[].
   */
  async convertRequest(ctx) {
    const detected = detectRequestFormat({
      url: ctx.url,
      headers: ctx.headers,
      body: ctx.body,
      clientTool: "cursor",
    });
    ctx.meta.nativeFormat = detected.format;
    ctx.meta.targetFormat = "openai-router";
    ctx.routerPath = resolveRouterPath(ctx.url);

    if (ctx.mappedModel && ctx.body && typeof ctx.body === "object" && "model" in ctx.body) {
      ctx.body.model = ctx.mappedModel;
    }

    return ctx;
  },

  async convertResponse(ctx) {
    ctx.meta.targetFormat = ctx.meta.nativeFormat || "cursor";
    return ctx;
  },
});
