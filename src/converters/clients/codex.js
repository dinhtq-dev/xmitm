const { registerClientConverter } = require("../registry");
const { autoConvertResponse } = require("../formats/autoResponse");
const { log } = require("../../logger");

registerClientConverter("codex", {
  /** Codex/Postman gửi OpenAI — giữ nguyên REQ; RES auto-detect nguồn → OpenAI. */
  async convertRequest(ctx) {
    ctx.meta.nativeFormat = "openai";
    ctx.meta.targetFormat = "openai";
    return ctx;
  },
  async convertResponse(ctx) {
    const fakeModel = ctx.meta?.requestedModel;
    const result = autoConvertResponse(ctx.body, ctx.clientTool || "codex", {
      contentType: ctx.meta?.contentType,
      model: fakeModel || ctx._openAiModel || ctx.body?.model,
    });
    if (result.converted) {
      log(`[CustomAPI] auto res ${result.sourceFormat} → ${result.targetFormat} (codex)`);
      ctx.body = result.body;
    }
    if (fakeModel && ctx.body && typeof ctx.body === "object") {
      ctx.body.model = fakeModel;
    }
    ctx.meta.nativeFormat = "openai";
    ctx.meta.targetFormat = "openai";
    return ctx;
  },
});
