const { log, err } = require("../logger");

const DEFAULT_LOCAL_ROUTER = "http://localhost:20128";
const ROUTER_BASE = String(process.env.MITM_ROUTER_BASE || DEFAULT_LOCAL_ROUTER)
  .trim()
  .replace(/\/+$/, "")
  .replace(/\/v1$/i, "") || DEFAULT_LOCAL_ROUTER;
const API_KEY = process.env.ROUTER_API_KEY;

// Headers that must not be forwarded to 9Router
const STRIP_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "content-type", "authorization"
]);

/**
 * Recursively sanitizes JSON Schema to correct common type mismatches 
 * (e.g., string '1' instead of integer 1 for limits/bounds like minLength, minimum).
 */
function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // All JSON Schema numeric constraint keywords
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

  // If field is typed integer/number but default is a string, coerce it
  if ((schema.type === "integer" || schema.type === "number") && schema.default !== undefined) {
    const val = Number(schema.default);
    if (!isNaN(val)) schema.default = val;
  }

  // If enum values for integer/number type are strings, coerce them
  if ((schema.type === "integer" || schema.type === "number") && Array.isArray(schema.enum)) {
    schema.enum = schema.enum.map(v => {
      const n = Number(v);
      return !isNaN(n) ? n : v;
    });
  }

  // Recurse into properties
  if (schema.properties && typeof schema.properties === "object") {
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = sanitizeJsonSchema(schema.properties[key]);
    }
  }

  // Recurse into items
  if (schema.items && typeof schema.items === "object") {
    schema.items = sanitizeJsonSchema(schema.items);
  }

  // Recurse into anyOf, allOf, oneOf
  const arrays = ["anyOf", "allOf", "oneOf"];
  for (const field of arrays) {
    if (Array.isArray(schema[field])) {
      schema[field] = schema[field].map(sanitizeJsonSchema);
    }
  }

  return schema;
}

function sanitizeTools(body) {
  if (!body || !Array.isArray(body.tools)) return;
  for (const t of body.tools) {
    if (t.type === "function" && t.function && t.function.parameters) {
      t.function.parameters = sanitizeJsonSchema(t.function.parameters);
    }
  }
}

/**
 * Send body to 9Router at the given path and return the fetch Response object.
 * Optionally forwards client headers (stripped of hop-by-hop / overridden keys).
 */
async function fetchRouter(openaiBody, path = "/v1/chat/completions", clientHeaders = {}) {
  sanitizeTools(openaiBody);

  const forwarded = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) forwarded[k] = v;
  }

  const response = await fetch(`${ROUTER_BASE}${path}`, {
    method: "POST",
    headers: {
      ...forwarded,
      "Content-Type": "application/json",
      ...(API_KEY && { "Authorization": `Bearer ${API_KEY}` })
    },
    body: JSON.stringify(openaiBody)
  });

  // Forward response as-is (status + body). pipeSSE will propagate status.
  return response;
}

/**
 * Pipe SSE stream from router directly to client response.
 * Optional dumper tees the stream into a debug file.
 */
async function pipeSSE(routerRes, res, dumper) {
  const ct = routerRes.headers.get("content-type") || "application/json";
  const status = routerRes.status || 200;
  const resHeaders = { "Content-Type": ct, "Cache-Control": "no-cache", "Connection": "keep-alive" };
  if (ct.includes("text/event-stream")) resHeaders["X-Accel-Buffering"] = "no";
  res.writeHead(status, resHeaders);
  if (dumper) dumper.writeHeader(routerRes.status, Object.fromEntries(routerRes.headers));

  if (!routerRes.body) {
    const text = await routerRes.text().catch(() => "");
    if (dumper) { dumper.writeChunk(text); dumper.end(); }
    res.end(text);
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) { if (dumper) dumper.end(); res.end(); break; }
    if (dumper) dumper.writeChunk(value);
    res.write(decoder.decode(value, { stream: true }));
  }
}

module.exports = { fetchRouter, pipeSSE };
