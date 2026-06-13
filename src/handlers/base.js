const { log, err } = require("../logger");
const {
  buildClientContext,
  syncBodyBuffer,
  runClientRequest,
  runClientResponse,
  transformClientResponseChunk,
  parseJsonBody,
} = require("../converters");
const { isStreamingContentType } = require("../converters/responsePipe");
const { getRouterConfig } = require("../routerConfig");
const { getActiveProvider } = require("../providerRouter");
const { fetchViaActiveProvider } = require("../providerOutbound");

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
 * Run client-tool request converter pipeline (IDE native → router/canonical).
 */
async function prepareClientRequest(clientTool, req, bodyBuffer, mappedModel, meta = {}) {
  let ctx = buildClientContext({ clientTool, req, bodyBuffer, mappedModel, meta });
  ctx = await runClientRequest(ctx);
  return syncBodyBuffer(ctx);
}

/**
 * Send body to 9Router at the given path and return the fetch Response object.
 * Optionally forwards client headers (stripped of hop-by-hop / overridden keys).
 */
async function fetchRouter(openaiBody, path = "/v1/chat/completions", clientHeaders = {}, meta = {}) {
  sanitizeTools(openaiBody);

  const active = getActiveProvider();
  if (active) {
    return fetchViaActiveProvider(active, openaiBody, path, clientHeaders, meta);
  }

  const forwarded = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) forwarded[k] = v;
  }

  const { routerBase, apiKey } = getRouterConfig();
  log(`🔀 [MITM] → API Endpoint (${routerBase}) [no active provider]`);
  const response = await fetch(`${routerBase}${path}`, {
    method: "POST",
    headers: {
      ...forwarded,
      "Content-Type": "application/json",
      ...(apiKey && { "Authorization": `Bearer ${apiKey}` })
    },
    body: JSON.stringify(openaiBody)
  });

  // Forward response as-is (status + body). pipeSSE will propagate status.
  return response;
}

async function finishBufferedClientResponse(buf, res, dumper, converterCtx) {
  let out = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || "");
  if (converterCtx) {
    let ctx = {
      ...converterCtx,
      phase: "response",
      bodyBuffer: out,
      body: parseJsonBody(out),
      meta: {
        ...(converterCtx.meta || {}),
        contentType: converterCtx.meta?.contentType || "application/json",
      },
    };
    ctx = await runClientResponse(ctx);
    out = ctx.bodyBuffer || out;
  }
  if (dumper) { dumper.writeChunk(out); dumper.end(); }
  res.end(out);
}

/**
 * Pipe router response to client — auto convert buffered JSON or stream chunks.
 */
async function pipeSSE(routerRes, res, dumper, converterCtx = null) {
  const ct = routerRes.headers.get("content-type") || "application/json";
  const status = routerRes.status || 200;
  const isStream = isStreamingContentType(ct);
  const resHeaders = { "Content-Type": ct, "Cache-Control": "no-cache", "Connection": "keep-alive" };
  if (isStream) resHeaders["X-Accel-Buffering"] = "no";
  res.writeHead(status, resHeaders);
  if (dumper) dumper.writeHeader(routerRes.status, Object.fromEntries(routerRes.headers));

  if (converterCtx) {
    converterCtx.meta = {
      ...(converterCtx.meta || {}),
      contentType: ct,
    };
  }

  if (!routerRes.body) {
    const text = await routerRes.text().catch(() => "");
    await finishBufferedClientResponse(text, res, dumper, converterCtx);
    return;
  }

  if (!isStream) {
    const reader = routerRes.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    await finishBufferedClientResponse(Buffer.concat(chunks), res, dumper, converterCtx);
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) { if (dumper) dumper.end(); res.end(); break; }
    let out = value;
    if (converterCtx) {
      out = transformClientResponseChunk(converterCtx, value);
      if (out == null) continue;
    }
    if (dumper) dumper.writeChunk(out);
    const chunk = Buffer.isBuffer(out) ? out : Buffer.from(out);
    res.write(decoder.decode(chunk, { stream: true }));
  }
}

module.exports = { prepareClientRequest, fetchRouter, pipeSSE };
