const { err, createResponseDumper } = require("../logger");
const { IS_DEV } = require("../config");
const { prepareClientRequest, fetchRouter, pipeSSE, setLogUpstreamModel } = require("./base");

/**
 * Intercept Antigravity request — client converter → router → client response converter (stream).
 * Extend conversion in src/converters/clients/antigravity.js
 */
async function intercept(req, res, bodyBuffer, mappedModel, passthrough) {
  const dumper = IS_DEV ? createResponseDumper(req, "intercept-antigravity") : null;
  try {
    const ctx = await prepareClientRequest("antigravity", req, bodyBuffer, mappedModel);
    setLogUpstreamModel(res, ctx.body?.model);
    const routerRes = await fetchRouter(
      ctx.body,
      ctx.routerPath || "/v1/chat/completions",
      ctx.headers || req.headers,
      { reqUrl: req.url }
    );
    await pipeSSE(routerRes, res, dumper, { ...ctx, phase: "response" });
  } catch (error) {
    err(`[antigravity] Router failed, falling back to passthrough: ${error.message}`);
    if (dumper) { dumper.writeChunk(`\n[FALLBACK] Router failed: ${error.message}\n`); dumper.end(); }
    // Fallback to passthrough so IDE can still submit even if router is down
    return passthrough(req, res, bodyBuffer);
  }
}

module.exports = { intercept };
