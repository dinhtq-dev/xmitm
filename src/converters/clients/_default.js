const { registerClientConverter } = require("../registry");

registerClientConverter("_default", {
  async convertRequest(ctx) {
    return ctx;
  },
  async convertResponse(ctx) {
    return ctx;
  },
});
