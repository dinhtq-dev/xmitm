const { registerProviderConverter } = require("../registry");

registerProviderConverter("openai", {
  async convertRequest(ctx) {
    // e.g. normalize /responses → /chat/completions body
    return ctx;
  },
  async convertResponse(ctx) {
    return ctx;
  },
});

registerProviderConverter("chatgpt", {
  async convertRequest(ctx) {
    return ctx;
  },
  async convertResponse(ctx) {
    return ctx;
  },
});
