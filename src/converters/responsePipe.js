/**

 * Buffered HTTP response conversion (provider → client).

 */

const { parseJsonBody } = require("./context");

const { runClientResponse, runProviderResponse } = require("./pipeline");

const { enrichContextWithDetection } = require("./detectFormat");

const { log } = require("../logger");



function applyFakeModelResponse(bodyBuffer, requestedModel) {

  if (!requestedModel) return bodyBuffer;

  try {

    const body = JSON.parse(bodyBuffer.toString("utf8"));

    if (body && typeof body === "object") {

      const upstream = body.model;

      body.model = requestedModel;

      if (upstream !== requestedModel) {

        log(`[CustomAPI] fake model res: "${upstream}" → "${requestedModel}"`);

      }

      return Buffer.from(JSON.stringify(body));

    }

  } catch { /* non-JSON */ }

  return bodyBuffer;

}



async function applyBufferedConverters(bodyBuffer, { providerCtx = null, clientCtx = null, requestedModel = null } = {}) {
  let buf = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer || "");
  const fakeModel = requestedModel || clientCtx?.meta?.requestedModel;

  try {
    if (providerCtx) {
      let ctx = enrichContextWithDetection({
        ...providerCtx,
        phase: "response",
        bodyBuffer: buf,
        body: parseJsonBody(buf),
        meta: { ...(providerCtx.meta || {}), contentType: providerCtx.meta?.contentType },
      });
      ctx = await runProviderResponse(ctx);
      buf = ctx.bodyBuffer || buf;
    }

    if (clientCtx) {
      let ctx = enrichContextWithDetection({
        ...clientCtx,
        phase: "response",
        bodyBuffer: buf,
        body: parseJsonBody(buf),
        meta: { ...(clientCtx.meta || {}), contentType: clientCtx.meta?.contentType },
      });
      ctx = await runClientResponse(ctx);
      buf = ctx.bodyBuffer || buf;
    }
  } catch (e) {
    err(`[CustomAPI] response convert failed (still apply fake model): ${e.message}`);
  }

  return applyFakeModelResponse(buf, fakeModel);
}



function isStreamingContentType(contentType) {

  const ct = String(contentType || "").toLowerCase();

  return (

    ct.includes("text/event-stream")

    || ct.includes("application/vnd.amazon.eventstream")

    || ct.includes("application/x-ndjson")

  );

}



/**

 * Pipe upstream HTTP response → client; auto-convert + fake model khi có requestedModel.

 */

function pipeProxyResponse(proxyRes, res, { clientCtx = null, requestedModel = null, onFinish = null } = {}) {

  const ct = proxyRes.headers["content-type"] || "";

  const isStream = isStreamingContentType(ct);

  const fakeModel = requestedModel || clientCtx?.meta?.requestedModel;

  const resHeaders = { ...proxyRes.headers };

  delete resHeaders["transfer-encoding"];

  res.writeHead(proxyRes.statusCode, resHeaders);



  const finish = () => {

    try { onFinish?.(); } catch { /* ignore */ }

  };



  if (!clientCtx && !fakeModel) {

    proxyRes.pipe(res);

    proxyRes.on("end", finish);

    proxyRes.on("error", () => {

      if (!res.writableEnded) res.end();

      finish();

    });

    return;

  }



  if (!isStream) {

    const chunks = [];

    proxyRes.on("data", (chunk) => chunks.push(chunk));

    proxyRes.on("end", async () => {

      try {

        const buf = await applyBufferedConverters(Buffer.concat(chunks), {

          clientCtx: clientCtx

            ? { ...clientCtx, meta: { ...(clientCtx.meta || {}), contentType: ct } }

            : null,

          requestedModel: fakeModel,

        });

        if (!res.writableEnded) res.end(buf);

      } catch {

        let buf = applyFakeModelResponse(Buffer.concat(chunks), fakeModel);

        if (!res.writableEnded) res.end(buf);

      }

      finish();

    });

    proxyRes.on("error", () => {

      if (!res.writableEnded) res.end();

      finish();

    });

    return;

  }



  proxyRes.pipe(res);

  proxyRes.on("end", finish);

  proxyRes.on("error", () => {

    if (!res.writableEnded) res.end();

    finish();

  });

}



module.exports = {

  applyBufferedConverters,

  applyFakeModelResponse,

  isStreamingContentType,

  pipeProxyResponse,

};


