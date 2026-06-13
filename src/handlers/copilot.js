const { err } = require("../logger");
const { prepareClientRequest, fetchRouter, pipeSSE, setLogUpstreamModel } = require("./base");

/**
 * Intercept Copilot request — client converter → router.
 * Extend conversion in src/converters/clients/copilot.js
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  try {
    const ctx = await prepareClientRequest("copilot", req, bodyBuffer, mappedModel);
    setLogUpstreamModel(res, ctx.body?.model);
    const routerRes = await fetchRouter(
      ctx.body,
      ctx.routerPath || "/v1/chat/completions",
      ctx.headers || req.headers
    );
    await pipeSSE(routerRes, res, null, { ...ctx, phase: "response" });
  } catch (error) {
    err(`[copilot] ${error.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
  }
}

module.exports = { intercept };
