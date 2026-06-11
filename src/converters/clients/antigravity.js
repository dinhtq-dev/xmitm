const { registerClientConverter } = require("../registry");

const TYPE_MAP = {
  INTEGER: "integer",
  NUMBER: "number",
  STRING: "string",
  BOOLEAN: "boolean",
  ARRAY: "array",
  OBJECT: "object",
};

function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (typeof schema.type === "string" && TYPE_MAP[schema.type]) {
    schema.type = TYPE_MAP[schema.type];
  }
  const numericFields = [
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minLength", "maxLength", "minItems", "maxItems",
    "minProperties", "maxProperties", "multipleOf",
  ];
  for (const field of numericFields) {
    if (schema[field] != null) {
      const val = Number(schema[field]);
      if (!Number.isNaN(val)) schema[field] = val;
    }
  }
  if ((schema.type === "integer" || schema.type === "number") && schema.default !== undefined) {
    const val = Number(schema.default);
    if (!Number.isNaN(val)) schema.default = val;
  }
  if ((schema.type === "integer" || schema.type === "number") && Array.isArray(schema.enum)) {
    schema.enum = schema.enum.map((v) => {
      const n = Number(v);
      return Number.isNaN(n) ? v : n;
    });
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = sanitizeGeminiSchema(schema.properties[key]);
    }
  }
  if (schema.items && typeof schema.items === "object") {
    schema.items = sanitizeGeminiSchema(schema.items);
  }
  for (const field of ["anyOf", "allOf", "oneOf"]) {
    if (Array.isArray(schema[field])) {
      schema[field] = schema[field].map(sanitizeGeminiSchema);
    }
  }
  return schema;
}

function sanitizeGeminiTools(body) {
  if (!body?.request || !Array.isArray(body.request.tools)) return;
  for (const t of body.request.tools) {
    if (!Array.isArray(t.functionDeclarations)) continue;
    for (const fd of t.functionDeclarations) {
      if (fd.parameters) fd.parameters = sanitizeGeminiSchema(fd.parameters);
    }
  }
}

registerClientConverter("antigravity", {
  /**
   * Gemini/Antigravity native body → forward to router (router may translate further).
   * Extend here: gemini contents → openai messages, tool format, etc.
   */
  async convertRequest(ctx) {
    if (!ctx.body) return ctx;

    sanitizeGeminiTools(ctx.body);
    if (ctx.mappedModel && ctx.body.model !== undefined) {
      ctx.body.model = ctx.mappedModel;
    }

    ctx.routerPath = "/v1/chat/completions";
    ctx.meta.nativeFormat = "gemini";
    ctx.meta.targetFormat = "openai-router";
    return ctx;
  },

  /**
   * Extend here: openai SSE/JSON → gemini streamGenerateContent response shape.
   */
  async convertResponse(ctx) {
    ctx.meta.nativeFormat = ctx.meta.nativeFormat || "gemini";
    return ctx;
  },
});
