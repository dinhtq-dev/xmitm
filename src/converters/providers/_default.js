const { registerProviderConverter } = require("../registry");

registerProviderConverter("_default", {
  async convertRequest(ctx) {
    return ctx;
  },
  async convertResponse(ctx) {
    return ctx;
  },
});
