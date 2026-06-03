const { err, createResponseDumper } = require("../logger");
const { IS_DEV } = require("../config");
const { fetchRouter, pipeSSE } = require("./base");

const TYPE_MAP = {
  "INTEGER": "integer",
  "NUMBER": "number",
  "STRING": "string",
  "BOOLEAN": "boolean",
  "ARRAY": "array",
  "OBJECT": "object"
};

function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Coerce uppercase Gemini types to lowercase OpenAI/JSON Schema standard
  if (typeof schema.type === "string" && TYPE_MAP[schema.type]) {
    schema.type = TYPE_MAP[schema.type];
  }

  const numericFields = [
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minLength", "maxLength", "minItems", "maxItems",
    "minProperties", "maxProperties", "multipleOf",
  ];
  for (const field of numericFields) {
    if (schema[field] !== undefined && schema[field] !== null) {
      const val = Number(schema[field]);
      if (!isNaN(val)) schema[field] = val;
    }
  }

  if ((schema.type === "integer" || schema.type === "number") && schema.default !== undefined) {
    const val = Number(schema.default);
    if (!isNaN(val)) schema.default = val;
  }

  if ((schema.type === "integer" || schema.type === "number") && Array.isArray(schema.enum)) {
    schema.enum = schema.enum.map(v => {
      const n = Number(v);
      return !isNaN(n) ? n : v;
    });
  }

  // Recurse properties
  if (schema.properties && typeof schema.properties === "object") {
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = sanitizeGeminiSchema(schema.properties[key]);
    }
  }

  // Recurse items
  if (schema.items && typeof schema.items === "object") {
    schema.items = sanitizeGeminiSchema(schema.items);
  }

  // Recurse combinations
  const arrays = ["anyOf", "allOf", "oneOf"];
  for (const field of arrays) {
    if (Array.isArray(schema[field])) {
      schema[field] = schema[field].map(sanitizeGeminiSchema);
    }
  }

  return schema;
}

function sanitizeGeminiTools(body) {
  if (!body || !body.request || !Array.isArray(body.request.tools)) return;
  for (const t of body.request.tools) {
    if (Array.isArray(t.functionDeclarations)) {
      for (const fd of t.functionDeclarations) {
        if (fd.parameters) {
          fd.parameters = sanitizeGeminiSchema(fd.parameters);
        }
      }
    }
  }
}

/**
 * Intercept Antigravity request — forward Gemini body as-is to /v1/chat/completions.
 * Router auto-detects format via body.userAgent==="antigravity" + body.request.contents,
 * runs antigravity→openai→provider→openai→antigravity translators internally.
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  const dumper = IS_DEV ? createResponseDumper(req, "intercept-antigravity") : null;
  const isStream = req.url.includes(":streamGenerateContent");
  try {
    const body = JSON.parse(bodyBuffer.toString());
    sanitizeGeminiTools(body);
    if (body.model) body.model = mappedModel;

    const routerRes = await fetchRouter(body, "/v1/chat/completions", req.headers);
    await pipeSSE(routerRes, res, dumper);
  } catch (error) {
    err(`[antigravity] ${error.message}`);
    if (dumper) { dumper.writeChunk(`\n[ERROR] ${error.message}\n`); dumper.end(); }
    // For stream endpoint, send SSE error chunk so SDK doesn't hang waiting
    if (isStream) {
      if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ error: { message: error.message } })}\r\n\r\n`);
    } else {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
    }
  }
}

module.exports = { intercept };
