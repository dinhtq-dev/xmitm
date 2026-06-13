/**
 * Request/response converter framework
 *
 * Provider converters: upstream API format (OpenAI, Anthropic, Gemini, …)
 * Custom API :3000/v1 — CLI model mapping + fake model (không cần toggle REQ/RES).
 */

require("./clients/_default");
require("./clients/antigravity");
require("./clients/copilot");
require("./clients/kiro");
require("./clients/cursor");

require("./providers/_default");
require("./providers/openai");
require("./providers/anthropic");
require("./providers/gemini");

const registry = require("./registry");
const pipeline = require("./pipeline");
const context = require("./context");
const detectFormat = require("./detectFormat");
const responsePipe = require("./responsePipe");

module.exports = {
  ...registry,
  ...pipeline,
  ...context,
  ...detectFormat,
  ...responsePipe,
};
