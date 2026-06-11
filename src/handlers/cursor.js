const { err } = require("../logger");
const { prepareClientRequest, fetchRouter, pipeSSE } = require("./base");

/**
 * Cursor MITM — auto-detect format + client converter → router → convert response.
 */
async function intercept(req, res, bodyBuffer, mappedModel, passthrough) {
  try {
    const ctx = await prepareClientRequest("cursor", req, bodyBuffer, mappedModel, {
      via: "mitm-cursor",
    });
    const routerRes = await fetchRouter(
      ctx.body,
      ctx.routerPath || "/v1/chat/completions",
      ctx.headers || req.headers
    );
    await pipeSSE(routerRes, res, null, { ...ctx, phase: "response" });
  } catch (error) {
    err(`[cursor] ${error.message}`);
    if (passthrough) {
      return passthrough(req, res, bodyBuffer);
    }
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
  }
}

module.exports = { intercept };
