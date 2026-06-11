const { registerProviderConverter } = require("../registry");

function toAnthropicMessages(body) {
  if (!body || Array.isArray(body.messages)) return body;
  return body;
}

registerProviderConverter("anthropic", {
  async convertRequest(ctx) {
    if (ctx.body) ctx.body = toAnthropicMessages(ctx.body);
    ctx.meta.targetFormat = "anthropic";
    return ctx;
  },
  async convertResponse(ctx) {
    return ctx;
  },
});

registerProviderConverter("claude", {
  async convertRequest(ctx) {
    if (ctx.body) ctx.body = toAnthropicMessages(ctx.body);
    ctx.meta.targetFormat = "anthropic";
    return ctx;
  },
  async convertResponse(ctx) {
    return ctx;
  },
});
