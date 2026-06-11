const { registerClientConverter } = require("../registry");

registerClientConverter("kiro", {
  /**
   * AWS CodeWhisperer / Kiro uses conversationState + EventStream binary responses.
   * Heavy conversion lives in handlers/kiro.js today — migrate helpers here gradually.
   */
  async convertRequest(ctx) {
    ctx.meta.nativeFormat = "codewhisperer";
    ctx.meta.targetFormat = "openai";
    ctx.meta.responseMode = "eventstream";
    return ctx;
  },

  async convertResponse(ctx) {
    ctx.meta.responseMode = "eventstream";
    return ctx;
  },
});
