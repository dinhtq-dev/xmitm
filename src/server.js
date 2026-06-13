const http = require("http");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const { promisify } = require("util");
const { execSync, spawn } = require("child_process");
const { log, err, dumpRequest, createResponseDumper, clearDumpDir } = require("./logger");
const { IS_DEV, LSOF_BIN, TARGET_HOSTS, URL_PATTERNS, MODEL_SYNONYMS, MODEL_PATTERNS, getToolForHost } = require("./config");
const { DATA_DIR, MITM_DIR } = require("./paths");
const { getCertForDomain } = require("./cert/generate");
const { getMitmAlias } = require("./dbReader");
const { init: initLogStore, addLog } = require("./logStore");
const { extractUsageFromText } = require("./tokenTracker");
const { initConfig } = require("./configStore");
const { bypassCorruptedThoughtSignatures } = require("./geminiModels");
const LOCAL_PORT = 443;
const HTTP_SHIM_PORT = 20129;
const IS_WIN = process.platform === "win32";
const ENABLE_FILE_LOG = true;

let httpsServer; // Reference to main HTTPS server for shutdown/restart

// Clear stale dump files on every MITM start (prevents unbounded disk usage)
clearDumpDir();
initConfig();
initLogStore(); // init request log store
const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };

// Host rewrite for upstream forward: PROD cloudcode-pa is rate-limited (429),
// daily-cloudcode-pa (dev endpoint) accepts same body+token. Same trick as open-sse.
const HOST_REWRITE = {
  // "cloudcode-pa.googleapis.com": "daily-cloudcode-pa.googleapis.com",
};

const handlers = {
  antigravity: require("./handlers/antigravity"),
  copilot: require("./handlers/copilot"),
  kiro: require("./handlers/kiro"),
  cursor: require("./handlers/cursor"),
};

// ── SSL / SNI ─────────────────────────────────────────────────

const certCache = new Map();
let rootCAPem;

function sniCallback(servername, cb) {
  try {
    if (certCache.has(servername)) return cb(null, certCache.get(servername));
    const certData = getCertForDomain(servername);
    if (!certData) return cb(new Error(`Failed to generate cert for ${servername}`));
    const ctx = require("tls").createSecureContext({
      key: certData.key,
      cert: `${certData.cert}\n${rootCAPem}`
    });
    certCache.set(servername, ctx);
    cb(null, ctx);
  } catch (e) {
    err(`SNI error for ${servername}: ${e.message}`);
    cb(e);
  }
}

let sslOptions; // Will be initialized asynchronously
// ── Helpers ───────────────────────────────────────────────────

const cachedTargetIPs = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveTargetIP(hostname) {
  const cached = cachedTargetIPs[hostname];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ip;
  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8"]);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  const addresses = await resolve4(hostname);
  cachedTargetIPs[hostname] = { ip: addresses[0], ts: Date.now() };
  return cachedTargetIPs[hostname].ip;
}

function collectBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isAntigravityNativeBody(buf) {
  try {
    const p = JSON.parse(buf.toString());
    return !!(p?.request?.contents || p?.contents);
  } catch {
    return false;
  }
}

function modelFamilyKey(model) {
  const m = String(model || "").trim();
  if (/^claude-/i.test(m)) return "claude";
  if (/^gpt-oss/i.test(m)) return "gpt";
  if (/^gemini-/i.test(m)) return "gemini";
  return "other";
}

/** Native AG request — passthrough neu khong redirect sang family khac (giu Claude/GPT/Gemini that) */
function shouldPassthroughAntigravityNative(model, bodyBuffer, mappedModel) {
  if (!isAntigravityNativeBody(bodyBuffer)) return false;
  if (!model) return false;
  if (!mappedModel || mappedModel === model) return true;
  return modelFamilyKey(model) === modelFamilyKey(mappedModel);
}

// Extract model from URL path (Gemini), body (OpenAI/Anthropic), or Kiro conversationState
function extractModel(url, body) {
  const urlMatch = url.match(/\/models\/([^/:]+)/);
  if (urlMatch) return urlMatch[1];
  try {
    const parsed = JSON.parse(body.toString());
    if (parsed.conversationState) {
      return parsed.conversationState.currentMessage?.userInputMessage?.modelId || null;
    }
    return parsed.model || null;
  } catch { return null; }
}

function getMappedModel(tool, model) {
  if (!model) return null;
  try {
    const aliases = getMitmAlias(tool);
    if (!aliases) return null;
    // Normalize via synonym map (e.g., gemini-default → gemini-3-flash)
    const lookup = MODEL_SYNONYMS?.[tool]?.[model] || model;
    if (aliases[lookup]) return aliases[lookup];
    // Prefix match fallback
    const prefixKey = Object.keys(aliases).find(k => k && aliases[k] && (lookup.startsWith(k) || k.startsWith(lookup)));
    if (prefixKey) return aliases[prefixKey];
    // Pattern fallback: catches AG renamed variants (e.g. gemini-pro-agent → gemini-3.1-pro-high)
    const patterns = MODEL_PATTERNS?.[tool] || [];
    for (const { match, alias } of patterns) {
      if (match.test(lookup) && aliases[alias]) return aliases[alias];
    }
    return null;
  } catch { return null; }
}

/**
 * Forward request to real upstream.
 * Optional onResponse(rawBuffer) callback — if provided, tees the response
 * so it's both forwarded to client AND passed to the callback for inspection.
 * Also tees full stream into a dump file when ENABLE_FILE_LOG is on.
 */
async function passthrough(req, res, bodyBuffer, onResponse) {
  const originalHost = (req.headers.host || TARGET_HOSTS[0]).split(":")[0];
  const targetHost = HOST_REWRITE[originalHost] || originalHost;
  const targetIP = await resolveTargetIP(targetHost);
  const dumper = ENABLE_FILE_LOG ? createResponseDumper(req, "passthrough") : null;

  const forwardReq = https.request({
    hostname: targetIP,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: targetHost },
    servername: targetHost,
    rejectUnauthorized: false
  }, (forwardRes) => {
    res.writeHead(forwardRes.statusCode, forwardRes.headers);
    if (dumper) dumper.writeHeader(forwardRes.statusCode, forwardRes.headers);

    if (!onResponse && !dumper) {
      forwardRes.pipe(res);
      return;
    }

    // Tee: forward to client AND optionally buffer + dump
    const chunks = [];
    forwardRes.on("data", chunk => {
      if (dumper) dumper.writeChunk(chunk);
      if (onResponse) chunks.push(chunk);
      res.write(chunk);
    });
    forwardRes.on("end", () => {
      if (dumper) dumper.end();
      res.end();
      if (onResponse) try { onResponse(Buffer.concat(chunks), forwardRes.headers); } catch { /* ignore */ }
    });
  });

  forwardReq.on("error", (e) => {
    err(`Passthrough error: ${e.message}`);
    if (dumper) { dumper.writeChunk(`\n[ERROR] ${e.message}\n`); dumper.end(); }
    if (!res.headersSent) res.writeHead(502);
    res.end("Bad Gateway");
  });

  if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
  forwardReq.end();
}

// ── Request handler ───────────────────────────────────────────

async function handleRequest(req, res) {
  const startTime = Date.now();
  try {
    if (req.url === "/_mitm_health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, pid: process.pid }));
    }

    // Ensure request body buffer
    let bodyBuffer = await collectBodyRaw(req);
    if (!Buffer.isBuffer(bodyBuffer)) {
      bodyBuffer = Buffer.from(bodyBuffer || "");
    }
    if (ENABLE_FILE_LOG) dumpRequest(req, bodyBuffer, "raw");

    // Force host so existing MITM routing recognizes this as Antigravity traffic.
    if (!req.headers.host || req.headers.host === `localhost:${HTTP_SHIM_PORT}` || req.headers.host === `127.0.0.1:${HTTP_SHIM_PORT}`) {
      req.headers.host = "daily-cloudcode-pa.googleapis.com";
    }

    const tool = getToolForHost(req.headers.host);

    // ── Response body capture (zero-latency, fire-and-forget) ───
    // Intercepts only to buffer data for logging — response is NEVER blocked.
    const MAX_BODY_CAPTURE = 5000;
    const MAX_CHUNKS = 12;
    const responseBodyBuffers = [];
    let responseStatus = null;
    let responseContentEncoding = null;

    // Async decompress helpers (non-blocking)
    const gunzipAsync  = promisify(zlib.gunzip);
    const brotliAsync  = promisify(zlib.brotliDecompress);
    const inflateAsync = promisify(zlib.inflate);

    const _origWriteHead = res.writeHead.bind(res);
    res.writeHead = (statusCode, ...args) => {
      responseStatus = statusCode;
      // Normalize header keys to lowercase for reliable content-encoding detection
      for (const arg of args) {
        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
          const normalized = Object.fromEntries(
            Object.entries(arg).map(([k, v]) => [k.toLowerCase(), v])
          );
          if (normalized['content-encoding']) {
            responseContentEncoding = normalized['content-encoding'];
            break;
          }
        }
      }
      return _origWriteHead(statusCode, ...args);
    };

    const _origWrite = res.write.bind(res);
    res.write = (chunk, ...args) => {
      // ① Fire immediately — no blocking
      const result = _origWrite(chunk, ...args);
      // ② Passively buffer for log (capped)
      if (chunk != null && responseBodyBuffers.length < MAX_CHUNKS) {
        responseBodyBuffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return result;
    };

    // ── Create mutable entry ─────────────────────────────────
    const entry = {
      method: req.method,
      url: req.url,
      host: req.headers.host,
      tool: tool,
      model: null,
      mappedModel: null,
      upstreamModel: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      action: "passthrough",
      requestBody: bodyBuffer.toString("utf8").substring(0, 500),
      responseStatus: null,
      responseBody: null,
      duration: Date.now() - startTime,
    };
    res._mitmLogEntry = entry;

    const _origEnd = res.end.bind(res);
    res.end = (chunk, ...args) => {
      // ① Fire response IMMEDIATELY — client gets data at full speed
      const result = _origEnd(chunk, ...args);

      // ② Schedule log processing AFTER response is sent (next event loop tick)
      const endChunk = chunk != null ? (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) : null;
      const capturedBuffers = endChunk ? [...responseBodyBuffers, endChunk] : [...responseBodyBuffers];
      const capturedEncoding = responseContentEncoding;
      const capturedStatus = responseStatus;
      const capturedStart = startTime;

      setImmediate(async () => {
        let bodyText = '';
        try {
          if (capturedBuffers.length === 0) {
            bodyText = '';
          } else {
            const fullBuf = Buffer.concat(capturedBuffers);
            const enc = (capturedEncoding || '').toLowerCase();
            try {
              if (enc.includes('br')) {
                bodyText = (await brotliAsync(fullBuf)).toString('utf8');
              } else if (enc.includes('gzip')) {
                bodyText = (await gunzipAsync(fullBuf)).toString('utf8');
              } else if (enc.includes('deflate')) {
                bodyText = (await inflateAsync(fullBuf)).toString('utf8');
              } else if (fullBuf.length > 2 && fullBuf[0] === 0x1f && fullBuf[1] === 0x8b) {
                // Gzip magic bytes fallback (no content-encoding header)
                bodyText = (await gunzipAsync(fullBuf)).toString('utf8');
              } else {
                bodyText = fullBuf.toString('utf8');
              }
            } catch {
              // Fallback chain: brotli → gzip → deflate → raw utf8
              try { bodyText = (await brotliAsync(fullBuf)).toString('utf8'); } catch {
                try { bodyText = (await gunzipAsync(fullBuf)).toString('utf8'); } catch {
                  try { bodyText = (await inflateAsync(fullBuf)).toString('utf8'); } catch {
                    bodyText = fullBuf.toString('utf8');
                  }
                }
              }
              // If still garbled, label clearly instead of dumping garbage
              if (/\uFFFD/.test(bodyText) && bodyText.split('\uFFFD').length > 5) {
                bodyText = `[undecodable — compressed or binary, ${fullBuf.length} bytes]`;
              }
            }
          }
        } catch { /* ignore log errors */ }

        entry.responseBody = bodyText.substring(0, MAX_BODY_CAPTURE);
        entry.responseStatus = capturedStatus;
        entry.duration = Date.now() - capturedStart;

        const usage = extractUsageFromText(bodyText);
        if (usage) {
          entry.promptTokens = usage.input;
          entry.completionTokens = usage.output;
          entry.totalTokens = usage.input + usage.output;
        }
        if (!entry.upstreamModel) {
          entry.upstreamModel = entry.mappedModel || entry.model || null;
        }

        try { addLog({ ...entry }); } catch {}

        // Track token usage and cost
        try {
          const { trackRequest } = require("./tokenTracker");
          trackRequest({
            model: entry.upstreamModel || entry.mappedModel || entry.model,
            bodyText,
          });
        } catch (trackErr) {
          // Silent catch to prevent proxy break
        }
      });

      return result;
    };

    // ── Tool-specific handling ─────────────────────────────────
    if (!tool) {
      log(`[DEBUG] Passthrough (No tool match): host=${req.headers.host}`);
      return passthrough(req, res, bodyBuffer);
    }
    
    const model = extractModel(req.url, bodyBuffer);
    const mappedModel = getMappedModel(tool, model);
    
    log(`[DEBUG] Analyzed ${tool} request. URL: ${req.url}`);
    log(`[DEBUG] Extracted model: ${model} | Mapped to: ${mappedModel}`);
    
    entry.model = model;
    entry.mappedModel = mappedModel;
    entry.upstreamModel = mappedModel || model || null;
    entry.action = mappedModel ? "intercepted" : "passthrough";

    if (!mappedModel && tool !== "cursor") {
      log(`[DEBUG] Passthrough (No mapping found for ${model})`);
      return passthrough(req, res, bodyBuffer);
    }

    if (tool === "cursor") {
      log(`[DEBUG] Intercepting Cursor: url=${req.url} model=${model || "-"} mapped=${mappedModel || "-"}`);
      entry.tool = "cursor";
      entry.action = mappedModel ? "intercepted" : "intercepted-unmapped";
      return handlers[tool].intercept(req, res, bodyBuffer, mappedModel, passthrough);
    }

    if (tool === "antigravity" && shouldPassthroughAntigravityNative(model, bodyBuffer, mappedModel)) {
      const repaired = bypassCorruptedThoughtSignatures(bodyBuffer);
      if (repaired.changed) {
        log(`[DEBUG] Repair thought_signature trong trajectory (skip validator)`);
        bodyBuffer = repaired.buffer;
        if (req.headers["content-length"]) {
          req.headers["content-length"] = String(bodyBuffer.length);
        }
      }
      log(`[DEBUG] Passthrough antigravity native: ${model} (giu OAuth + model ${mappedModel || model})`);
      entry.action = "passthrough-antigravity-native";
      entry.upstreamModel = model || mappedModel || null;
      return passthrough(req, res, bodyBuffer);
    }

    log(`[DEBUG] Intercepting ${tool}: mapped ${model} -> ${mappedModel}`);
    return handlers[tool].intercept(req, res, bodyBuffer, mappedModel, passthrough);
  } catch (e) {
    err(`Unhandled error: ${e.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message, type: "mitm_error" } }));
  }
}


function killPort(port) {
  try {
    let pidList = [];
    if (IS_WIN) {
      const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command ` +
        `"Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`;
      const out = execSync(psCmd, { encoding: "utf-8", windowsHide: true }).trim();
      if (!out) return;
      pidList = out.split(/\r?\n/).map(s => s.trim()).filter(p => p && Number(p) !== process.pid && Number(p) > 4);
    } else {
      const out = execSync(`${LSOF_BIN} -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: "utf-8", windowsHide: true }).trim();
      if (!out) return;
      pidList = out.split("\n").filter(p => p && Number(p) !== process.pid);
    }
    if (pidList.length === 0) return;
    pidList.forEach(pid => {
      try {
        if (IS_WIN) execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
        else process.kill(Number(pid), "SIGKILL");
      } catch (e) {
        err(`Failed to kill PID ${pid}: ${e.message}`);
      }
    });
    log(`Killed ${pidList.length} process(es) on port ${port}`);
  } catch (e) {
    if (e.status !== 1) throw e;
  }
}

let serversListening = false;

async function startServer() {
  const rootKeyPath = path.join(MITM_DIR, "rootCA.key");
  const rootCertPath = path.join(MITM_DIR, "rootCA.crt");



  // Auto-generate Root CA if missing
  if (!fs.existsSync(rootKeyPath) || !fs.existsSync(rootCertPath)) {
    log("🔐 Root CA not found. Generating new Root CA...");
    const { generateCert } = require("./cert/generate");
    await generateCert();
    log("✅ Root CA generated successfully.");
  }

  // Ensure Root CA is trusted in the system store
  try {
    const { checkCertInstalled, installCert } = require("./cert/install");
    const rootCATrusted = await checkCertInstalled(rootCertPath);
    if (!rootCATrusted) {
      log("🔐 System Trust: Cert not trusted → installing and trusting...");
      await installCert(null, rootCertPath);
      log("🔐 System Trust: Root CA trusted successfully ✅");
    } else {
      log("🔐 System Trust: Root CA already trusted ✅");
    }
  } catch (trustErr) {
    err(`Failed to verify or trust Root CA: ${trustErr.message}`);
  }



  try {
    const rootKey = fs.readFileSync(rootKeyPath);
    const rootCert = fs.readFileSync(rootCertPath);
    rootCAPem = rootCert.toString("utf8");
    sslOptions = { key: rootKey, cert: rootCert, SNICallback: sniCallback };
  } catch (e) {
    err(`Root CA load error: ${e.message}`);
    process.exit(1);
  }

  const server = https.createServer(sslOptions, handleRequest);
  httpsServer = server;
  const shimServer = http.createServer(handleRequest);

  try {
    killPort(LOCAL_PORT);
  } catch (e) {
    err(`Cannot kill process on port ${LOCAL_PORT}: ${e.message}`);
    process.exit(1);
  }

  await new Promise((resolve, reject) => {
    let pending = 2;
    const onReady = () => {
      if (--pending === 0) {
        serversListening = true;
        resolve();
      }
    };
    server.once("error", reject);
    shimServer.once("error", reject);
    server.listen(LOCAL_PORT, () => { log(`🚀 Server ready on :${LOCAL_PORT}`); onReady(); });
    shimServer.listen(HTTP_SHIM_PORT, () => { log(`🧩 HTTP shim ready on :${HTTP_SHIM_PORT}`); onReady(); });
  });

  const onListenError = (e) => {
    if (e.code === "EADDRINUSE") err(`Port ${LOCAL_PORT} already in use`);
    else if (e.code === "EACCES") err(`Permission denied for port ${LOCAL_PORT}`);
    else err(`Server error: ${e.message}`);
    if (!serversListening) process.exit(1);
  };
  server.on("error", onListenError);
  shimServer.on("error", onListenError);

  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const forceExit = setTimeout(() => process.exit(0), 1500);
    server.close(() => {
      shimServer.close(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (process.platform === "win32") process.on("SIGBREAK", shutdown);
}

process.on("uncaughtException", (e) => {
  err(`Uncaught exception (keeping server alive): ${e.message}`);
  if (e.stack) err(e.stack);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  err(`Unhandled rejection (keeping server alive): ${msg}`);
});

startServer().catch((e) => {
  err(`Fatal startup error: ${e.message}`);
  process.exit(1);
});
