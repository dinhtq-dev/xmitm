/**
 * sessionProvider.js — OpenCode terminal session bridge (opencode serve lifecycle)
 */
const http = require("http");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { log, err } = require("../logger");
const { loadAuthStore, upsertOAuthConnection, listOAuthConnections } = require("../authStore");

const DEFAULT_PORT = Number(process.env.OPENCODE_SERVE_PORT || 4096);
const DEFAULT_HOST = process.env.OPENCODE_SERVE_HOST || "127.0.0.1";
const DEFAULT_PROJECT_DIR = process.env.OPENCODE_PROJECT_DIR || process.cwd();
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 180_000;

let serveProcess = null;
let state = {
  running: false,
  port: DEFAULT_PORT,
  hostname: DEFAULT_HOST,
  projectDir: null,
  sessionId: null,
  baseUrl: null,
  pid: null,
  version: null,
  lastError: null,
};

function resolveOpencodeBinary() {
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) {
    return process.env.OPENCODE_BIN;
  }
  try {
    return execSync("command -v opencode", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAuthConfig() {
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD || "";
  return { username, password };
}

function buildBaseUrl(port = state.port, hostname = state.hostname) {
  return `http://${hostname}:${port}`;
}

function requestJson(method, apiPath, body, opts = {}) {
  const port = opts.port || state.port;
  const hostname = opts.hostname || state.hostname;
  const { username, password } = getAuthConfig();
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path: apiPath,
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...(password
            ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
            : {}),
        },
        timeout: opts.timeout || REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text) {
            resolve({ status: res.statusCode, data: null });
            return;
          }
          try {
            resolve({ status: res.statusCode, data: JSON.parse(text) });
          } catch (e) {
            reject(new Error(`OpenCode API invalid JSON (${res.statusCode} ${apiPath}): ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`OpenCode API timeout: ${method} ${apiPath}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(port, hostname, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await requestJson("GET", "/global/health", undefined, { port, hostname, timeout: 3000 });
      if (res.status === 200 && res.data?.healthy) {
        state.version = res.data.version || null;
        return true;
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`OpenCode serve khong san sang sau ${timeoutMs}ms (${buildBaseUrl(port, hostname)})`);
}

function killServeProcess() {
  if (!serveProcess) return;
  try {
    serveProcess.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  serveProcess = null;
}

function killPort(port) {
  try {
    if (process.platform === "linux") {
      execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execSync(`sh -c 'lsof -ti:${port} | xargs kill -9 2>/dev/null || true'`, { stdio: "ignore" });
    }
  } catch {
    /* ignore */
  }
}

function readOpenCodeConfig() {
  const conn = listOAuthConnections("opencode").find((c) => c.driver === "local") || listOAuthConnections("opencode")[0];
  const extra = conn?.extra && typeof conn.extra === "object" ? conn.extra : {};
  return {
    connectionId: conn?.id || null,
    projectDir: extra.projectDir || DEFAULT_PROJECT_DIR,
    port: Number(extra.servePort || DEFAULT_PORT),
    hostname: extra.serveHostname || DEFAULT_HOST,
    sessionId: extra.sessionId || null,
    model: extra.model || null,
    agent: extra.agent || "build",
  };
}

function persistSessionMeta(patch) {
  const conn = listOAuthConnections("opencode").find((c) => c.driver === "local") || listOAuthConnections("opencode")[0];
  if (!conn) return;
  upsertOAuthConnection({
    ...conn,
    extra: {
      ...(conn.extra || {}),
      ...patch,
      servePort: state.port,
      serveHostname: state.hostname,
      projectDir: state.projectDir,
      sessionId: state.sessionId,
      baseUrl: state.baseUrl,
    },
  });
}

async function startServe(opts = {}) {
  const binary = resolveOpencodeBinary();
  if (!binary) throw new Error("Khong tim thay opencode CLI trong PATH");

  const projectDir = path.resolve(opts.projectDir || DEFAULT_PROJECT_DIR);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory khong ton tai: ${projectDir}`);
  }

  const port = Number(opts.port || DEFAULT_PORT);
  const hostname = opts.hostname || DEFAULT_HOST;

  if (serveProcess) await stopServe();

  const args = ["serve", "--port", String(port), "--hostname", hostname];
  log(`🦊 [OpenCode] Starting serve on ${buildBaseUrl(port, hostname)} dir=${projectDir}`);

  serveProcess = spawn(binary, args, {
    cwd: projectDir,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
  });

  serveProcess.stderr?.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) log(`[OpenCode serve] ${line}`);
  });

  serveProcess.on("exit", (code, signal) => {
    if (state.running) {
      err(`[OpenCode] serve exited code=${code} signal=${signal || ""}`);
    }
    state.running = false;
    state.pid = null;
    serveProcess = null;
  });

  await waitForHealth(port, hostname);

  state.running = true;
  state.port = port;
  state.hostname = hostname;
  state.projectDir = projectDir;
  state.baseUrl = buildBaseUrl(port, hostname);
  state.pid = serveProcess.pid;
  state.lastError = null;
  return getPublicStatus();
}

async function stopServe() {
  killServeProcess();
  killPort(state.port);
  state.running = false;
  state.pid = null;
  state.sessionId = null;
  state.lastError = null;
  log("🦊 [OpenCode] serve stopped");
  return getPublicStatus();
}

async function createSession(opts = {}) {
  if (!state.running) throw new Error("OpenCode serve chua chay");
  const res = await requestJson("POST", "/session", {
    title: opts.title || `XMITM session - ${new Date().toISOString()}`,
  });
  if (res.status !== 200 || !res.data?.id) {
    throw new Error(`Tao session that bai (${res.status})`);
  }
  state.sessionId = res.data.id;
  persistSessionMeta({ sessionId: state.sessionId });
  return res.data;
}

function formatApiError(res, action) {
  const detail =
    res.data?.data?.message
    || res.data?.message
    || (typeof res.data === "string" ? res.data : null)
    || (res.data ? JSON.stringify(res.data).slice(0, 240) : null);
  return `${action} (${res.status})${detail ? `: ${detail}` : ""}`;
}

function normalizeOpenCodeModel(model) {
  if (model == null || model === "") return undefined;
  if (typeof model === "object") {
    if (model.providerID && model.modelID) return model;
    if (model.providerID && model.id) {
      return { providerID: model.providerID, modelID: model.id, ...(model.variant ? { variant: model.variant } : {}) };
    }
    return undefined;
  }
  if (typeof model !== "string") return undefined;
  if (model.includes("/")) {
    const [providerID, modelID] = model.split("/", 2);
    if (providerID && modelID) return { providerID, modelID };
  }
  // OpenAI-style aliases like "translate" are not valid OpenCode model objects.
  return undefined;
}

async function reconnectFromConfig() {
  const cfg = readOpenCodeConfig();
  try {
    const health = await requestJson("GET", "/global/health", undefined, {
      port: cfg.port,
      hostname: cfg.hostname,
      timeout: 3000,
    });
    if (health.status !== 200 || !health.data?.healthy) return false;

    state.running = true;
    state.port = cfg.port;
    state.hostname = cfg.hostname;
    state.projectDir = cfg.projectDir;
    state.baseUrl = buildBaseUrl(cfg.port, cfg.hostname);
    state.version = health.data.version || null;
    state.lastError = null;

    if (cfg.sessionId) {
      const existing = await requestJson("GET", `/session/${encodeURIComponent(cfg.sessionId)}`);
      if (existing.status === 200 && existing.data?.id) {
        state.sessionId = existing.data.id;
        return true;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function ensureReady() {
  if (state.running && state.sessionId) return getPublicStatus();
  if (state.running && !state.sessionId) {
    const session = await createSession({ title: "XMITM OpenCode session" });
    state.sessionId = session.id;
    persistSessionMeta({ sessionId: state.sessionId });
    return getPublicStatus();
  }
  if (await reconnectFromConfig()) {
    if (!state.sessionId) {
      const session = await createSession({ title: "XMITM OpenCode session" });
      state.sessionId = session.id;
      persistSessionMeta({ sessionId: state.sessionId });
    }
    return getPublicStatus();
  }
  throw new Error("OpenCode serve chua chay. Tat/bat lai provider OpenCode trong Admin UI.");
}

async function postSessionMessage(sessionId, body) {
  let res = await requestJson("POST", `/session/${encodeURIComponent(sessionId)}/message`, body);
  const modelRejected = res.status === 400
    && JSON.stringify(res.data || {}).includes("model");
  if (modelRejected && body.model) {
    const retryBody = { ...body };
    delete retryBody.model;
    res = await requestJson("POST", `/session/${encodeURIComponent(sessionId)}/message`, retryBody);
  }
  return res;
}
async function sendMessage(text, opts = {}) {
  await ensureReady();
  const sessionId = opts.sessionId || state.sessionId;
  if (!sessionId) throw new Error("Chua co OpenCode sessionId");

  const body = {
    parts: [{ type: "text", text: String(text || "") }],
  };
  if (opts.agent) body.agent = opts.agent;

  const model = normalizeOpenCodeModel(opts.model) || normalizeOpenCodeModel(readOpenCodeConfig().model);
  if (model) body.model = model;

  const res = await postSessionMessage(sessionId, body);
  if (res.status !== 200 || !res.data) {
    throw new Error(formatApiError(res, "Gui message that bai"));
  }
  return res.data;
}

async function listMessages(sessionId = state.sessionId) {
  if (!state.running) throw new Error("OpenCode serve chua chay");
  if (!sessionId) throw new Error("Chua co OpenCode sessionId");
  const res = await requestJson("GET", `/session/${encodeURIComponent(sessionId)}/message`);
  if (res.status !== 200) throw new Error(`Doc messages that bai (${res.status})`);
  return res.data;
}

async function exportSession(sessionId = state.sessionId) {
  if (!sessionId) throw new Error("Chua co OpenCode sessionId");
  const binary = resolveOpencodeBinary();
  if (!binary) throw new Error("Khong tim thay opencode CLI");

  try {
    const stdout = execSync(`"${binary}" export ${JSON.stringify(sessionId)}`, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      cwd: state.projectDir || DEFAULT_PROJECT_DIR,
    });
    return JSON.parse(stdout);
  } catch (e) {
    const messages = await listMessages(sessionId);
    const sessionRes = await requestJson("GET", `/session/${encodeURIComponent(sessionId)}`);
    return {
      info: sessionRes.data || { id: sessionId },
      messages: messages?.data || messages || [],
      exportedVia: "api-fallback",
    };
  }
}

function extractAssistantText(messagePayload) {
  const parts = messagePayload?.parts || [];
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function extractUserTextFromOpenAiBody(body) {
  // 1. Try body.messages (standard OpenAI)
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const txt = msg.content
        .filter((p) => p && (p.text || p.input_text))
        .map((p) => p.text || p.input_text)
        .join("\n")
        .trim();
      if (txt) return txt;
    }
  }

  // 2. Try body.input (OpenAI Responses API)
  const inputList = Array.isArray(body?.input) ? body.input : [];
  for (let i = inputList.length - 1; i >= 0; i -= 1) {
    const item = inputList[i];
    if (item?.type === "message" && item?.role === "user") {
      if (typeof item.content === "string") return item.content;
      if (Array.isArray(item.content)) {
        const txt = item.content
          .filter((p) => p && (p.text || p.input_text))
          .map((p) => p.text || p.input_text)
          .join("\n")
          .trim();
        if (txt) return txt;
      }
    }
  }

  return "";
}

function toOpenAiChatCompletion(messagePayload, modelName) {
  const content = extractAssistantText(messagePayload);
  const messageId = messagePayload?.info?.id || `msg_${Date.now()}`;
  return {
    id: `chatcmpl-${messageId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName || messagePayload?.info?.modelID || "opencode-session",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: messagePayload?.info?.finish || "stop",
      },
    ],
    usage: {
      prompt_tokens: messagePayload?.info?.tokens?.input || 0,
      completion_tokens: messagePayload?.info?.tokens?.output || 0,
      total_tokens: messagePayload?.info?.tokens?.total || 0,
    },
    x_opencode_session: {
      sessionId: messagePayload?.info?.sessionID || state.sessionId,
      messageId,
      providerID: messagePayload?.info?.providerID || "opencode",
    },
  };
}

function toAntigravityFormat(messagePayload, modelName) {
  const content = extractAssistantText(messagePayload);
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: content
            }
          ],
          role: "model"
        },
        finishReason: messagePayload?.info?.finish === "stop" ? "STOP" : (messagePayload?.info?.finish || "STOP"),
        index: 0,
        safetyRatings: [
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "NEGLIGIBLE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" },
          { category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "NEGLIGIBLE" }
        ]
      }
    ],
    usageMetadata: {
      promptTokenCount: messagePayload?.info?.tokens?.input || 0,
      candidatesTokenCount: messagePayload?.info?.tokens?.output || 0,
      totalTokenCount: messagePayload?.info?.tokens?.total || 0
    }
  };
}

function toCodexFormat(messagePayload, modelName) {
  const content = extractAssistantText(messagePayload);
  const messageId = messagePayload?.info?.id || `msg_${Date.now()}`;
  return {
    id: `chatcmpl-${messageId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName || messagePayload?.info?.modelID || "opencode-session",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: messagePayload?.info?.finish || "stop",
      },
    ],
    usage: {
      prompt_tokens: messagePayload?.info?.tokens?.input || 0,
      completion_tokens: messagePayload?.info?.tokens?.output || 0,
      total_tokens: messagePayload?.info?.tokens?.total || 0,
    }
  };
}

async function forwardChatCompletions(bodyBuffer, responseFormat = "origin") {
  await ensureReady();
  const body = JSON.parse(bodyBuffer.toString("utf8"));
  const prompt = extractUserTextFromOpenAiBody(body);
  if (!prompt) throw new Error("Khong tim thay user message trong request body");

  const reply = await sendMessage(prompt, {
    agent: body.agent,
  });

  if (responseFormat === "antigravity") {
    return toAntigravityFormat(reply, body.model);
  }
  if (responseFormat === "codex") {
    return toCodexFormat(reply, body.model);
  }
  return toOpenAiChatCompletion(reply, body.model);
}

async function activateProvider() {
  const cfg = readOpenCodeConfig();
  const connections = listOAuthConnections("opencode");
  if (!connections.length) {
    throw new Error('Chua import OpenCode. Bam "Login tu OpenCode" truoc.');
  }

  await startServe({
    projectDir: cfg.projectDir,
    port: cfg.port,
    hostname: cfg.hostname,
  });

  if (cfg.sessionId) {
    try {
      const existing = await requestJson("GET", `/session/${encodeURIComponent(cfg.sessionId)}`);
      if (existing.status === 200 && existing.data?.id) {
        state.sessionId = existing.data.id;
        persistSessionMeta({ sessionId: state.sessionId });
        log(`🦊 [OpenCode] Reuse session ${state.sessionId}`);
        return getPublicStatus();
      }
    } catch {
      /* create new */
    }
  }

  const session = await createSession({ title: "XMITM OpenCode session" });
  log(`🦊 [OpenCode] Created session ${session.id}`);
  return getPublicStatus();
}

async function deactivateProvider() {
  await stopServe();
  return getPublicStatus();
}

function getPublicStatus() {
  return {
    running: state.running,
    port: state.port,
    hostname: state.hostname,
    baseUrl: state.baseUrl,
    projectDir: state.projectDir,
    sessionId: state.sessionId,
    pid: state.pid,
    version: state.version,
    lastError: state.lastError,
    binary: resolveOpencodeBinary(),
  };
}

async function syncProviderActivation(previousActive, nextActive) {
  try {
    if (previousActive === "opencode" && nextActive !== "opencode") {
      await deactivateProvider();
    }
    if (nextActive === "opencode") {
      await activateProvider();
    }
  } catch (e) {
    state.lastError = e.message;
    err(`[OpenCode] Provider sync failed: ${e.message}`);
    throw e;
  }
  return getPublicStatus();
}

module.exports = {
  resolveOpencodeBinary,
  startServe,
  stopServe,
  createSession,
  sendMessage,
  listMessages,
  exportSession,
  forwardChatCompletions,
  activateProvider,
  deactivateProvider,
  syncProviderActivation,
  ensureReady,
  reconnectFromConfig,
  getPublicStatus,
  readOpenCodeConfig,
};
