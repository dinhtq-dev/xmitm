/**
 * Request/response converter framework
 *
 * ## Client converters (IDE traffic)
 * Register in `clients/<tool>.js` via registerClientConverter().
 * Called from MITM handlers before forwarding to router/provider.
 *
 * ## Provider converters (upstream API)
 * Register in `providers/<id>.js` via registerProviderConverter().
 * Called from providerRouter before/after proxy to active provider.
 *
 * Chỉ **một** client active tại một thời điểm (`activeClient` trong converter-toggles.json).
 * REQ + RES đều theo native format của client đó.
 *
 * ## Extend a converter
 * ```js
 * registerClientConverter("antigravity", {
 *   async convertRequest(ctx) {
 *     // ctx: { clientTool, url, headers, body, bodyBuffer, mappedModel, meta }
 *     ctx.body = myGeminiToOpenAI(ctx.body);
 *     return ctx;
 *   },
 *   async convertResponse(ctx) {
 *     ctx.bodyBuffer = myOpenAIToGemini(ctx.bodyBuffer);
 *     return ctx;
 *   },
 *   transformResponseStream(ctx, chunk) {
 *     return chunk; // optional SSE/binary transform
 *   },
 * });
 * ```
 */

require("./clients/_default");
require("./clients/antigravity");
require("./clients/copilot");
require("./clients/kiro");
require("./clients/cursor");
require("./clients/codex");
require("./clients/claude");

require("./providers/_default");
require("./providers/openai");
require("./providers/anthropic");
require("./providers/gemini");

const registry = require("./registry");
const pipeline = require("./pipeline");
const context = require("./context");
const toggles = require("./toggles");
const detectFormat = require("./detectFormat");
const responsePipe = require("./responsePipe");

module.exports = {
  ...registry,
  ...pipeline,
  ...context,
  ...toggles,
  ...detectFormat,
  ...responsePipe,
};
