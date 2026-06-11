const { registerClientConverter } = require("../registry");

const URL_MAP = {
  "/chat/completions": "/v1/chat/completions",
  "/v1/messages": "/v1/messages",
  "/responses": "/v1/responses",
};

function resolveRouterPath(reqUrl) {
  for (const [pattern, routerPath] of Object.entries(URL_MAP)) {
    if (reqUrl.includes(pattern)) return routerPath;
  }
  return "/v1/chat/completions";
}

registerClientConverter("copilot", {
  /**
   * Copilot may send OpenAI, Anthropic, or Responses API shapes.
   * Extend per-path conversion here.
   */
  async convertRequest(ctx) {
    if (ctx.body && ctx.mappedModel) {
      ctx.body.model = ctx.mappedModel;
    }
    ctx.routerPath = resolveRouterPath(ctx.url);
    ctx.meta.nativeFormat = ctx.routerPath.includes("messages") ? "anthropic" : "openai";
    ctx.meta.targetFormat = "openai-router";
    return ctx;
  },

  async convertResponse(ctx) {
    return ctx;
  },
});
