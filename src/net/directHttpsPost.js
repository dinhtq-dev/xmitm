/**
 * HTTPS POST qua TLS socket truc tiep toi IP — khong dung https.request lookup.
 * Tranh ECONNREFUSED 127.0.0.1 khi DNS Redirection bat trong hosts file.
 */
const tls = require("tls");
const https = require("https");
const { resolveUpstreamEndpoint, isLoopback } = require("../dns/bypassHostsLookup");

function parseHttpHeaders(head) {
  const lines = head.split("\r\n");
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) break;
    const ci = line.indexOf(":");
    if (ci > 0) headers[line.slice(0, ci).toLowerCase()] = line.slice(ci + 1).trim();
  }
  return headers;
}

function decodeChunkedBody(bodyBuf) {
  const out = [];
  let offset = 0;
  while (offset < bodyBuf.length) {
    const lineEnd = bodyBuf.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeLine = bodyBuf.slice(offset, lineEnd).toString("utf8").split(";")[0].trim();
    const size = parseInt(sizeLine, 16);
    if (Number.isNaN(size)) break;
    if (size === 0) break;
    offset = lineEnd + 2;
    out.push(bodyBuf.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(out).toString("utf8");
}

function parseHttpResponse(raw) {
  const idx = raw.indexOf(Buffer.from("\r\n\r\n"));
  if (idx < 0) return { status: 0, body: "", headers: {} };
  const head = raw.slice(0, idx).toString("utf8");
  let bodyBuf = raw.slice(idx + 4);
  const headers = parseHttpHeaders(head);
  const statusMatch = /HTTP\/\d(?:\.\d)? (\d+)/.exec(head.split("\r\n")[0] || "");
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  const te = (headers["transfer-encoding"] || "").toLowerCase();
  let body;
  if (te.includes("chunked")) {
    body = decodeChunkedBody(bodyBuf);
  } else {
    const cl = parseInt(headers["content-length"] || "", 10);
    body = Number.isFinite(cl) && cl >= 0
      ? bodyBuf.slice(0, cl).toString("utf8")
      : bodyBuf.toString("utf8");
  }
  return { status, body, headers };
}

/**
 * @param {string} urlStr
 * @param {Record<string,string>} headerObj
 * @param {object|string} bodyObj
 * @param {{ timeoutMs?: number, tlsInsecure?: boolean }} opts
 */
async function directHttpsPost(urlStr, headerObj, bodyObj, opts = {}) {
  let url;
  try {
    url = new URL(urlStr);
  } catch (e) {
    return { ok: false, status: 0, body: "", error: e.message };
  }

  let ep;
  try {
    ep = await resolveUpstreamEndpoint(url.hostname);
  } catch (e) {
    return { ok: false, status: 0, body: "", error: e.message };
  }

  if (isLoopback(ep.host)) {
    return {
      ok: false,
      status: 0,
      body: "",
      error: `DNS bypass that bai (${url.hostname} -> ${ep.host}). Thu tat DNS Redirection tam thoi.`,
      connectIp: ep.host,
    };
  }

  const payload = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj || {});
  const headers = {
    Host: url.hostname,
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payload)),
    "Accept-Encoding": "identity",
    Connection: "close",
    ...headerObj,
  };
  const headerBlock = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  const request = `POST ${url.pathname + url.search} HTTP/1.1\r\n${headerBlock}\r\n\r\n${payload}`;
  const timeoutMs = opts.timeoutMs || 15000;

  return new Promise((resolve) => {
    const chunks = [];
    const socket = tls.connect({
      host: ep.host,
      port: Number(url.port) || 443,
      servername: url.hostname,
      rejectUnauthorized: opts.tlsInsecure ? false : true,
      ALPNProtocols: ["http/1.1"],
    }, () => {
      socket.write(request);
    });

    socket.setTimeout(timeoutMs);
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      const parsed = parseHttpResponse(Buffer.concat(chunks));
      resolve({
        ok: parsed.status >= 200 && parsed.status < 300,
        status: parsed.status,
        body: parsed.body,
        connectIp: ep.host,
      });
    });
    socket.on("error", (e) => {
      resolve({
        ok: false,
        status: 0,
        body: "",
        error: `${e.message} (connect ${ep.host}:443, host ${url.hostname})`,
        connectIp: ep.host,
      });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({
        ok: false,
        status: 0,
        body: "",
        error: `timeout (connect ${ep.host}:443)`,
        connectIp: ep.host,
      });
    });
  });
}

module.exports = { directHttpsPost };
