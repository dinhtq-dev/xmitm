const { registerClientConverter } = require("../registry");
const { autoConvertResponse } = require("../formats/autoResponse");
const { log } = require("../../logger");

registerClientConverter("claude", {
  /** Claude Code CLI — RES auto-detect nguồn → Anthropic messages. */
  async convertRequest(ctx) {
    ctx.meta.nativeFormat = "anthropic";
    ctx.meta.targetFormat = "anthropic";
    return ctx;
  },
  async convertResponse(ctx) {
    const result = autoConvertResponse(ctx.body, ctx.clientTool || "claude", {
      contentType: ctx.meta?.contentType,
      model: ctx._openAiModel || ctx.body?.model,
    });
    if (result.converted) {
      log(`[CustomAPI] auto res ${result.sourceFormat} → ${result.targetFormat} (claude)`);
      ctx.body = result.body;
    }
    ctx.meta.nativeFormat = "anthropic";
    ctx.meta.targetFormat = "anthropic";
    return ctx;
  },
});
