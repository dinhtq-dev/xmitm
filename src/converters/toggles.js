/**
 * Converter toggles — tách 2 luồng:
 *
 * 1. **Custom API** (`apiProxyClient`) — Postman/Codex/Claude → localhost:3000/v1
 *    Không liên quan MITM. Chọn format client (codex/claude) → REQ+RES native.
 *
 * 2. **MITM** — handler riêng (kiro.js, copilot.js…), không dùng apiProxyClient.
 */
const { getClientConverter } = require("./registry");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../paths");
const { loadAuthStore } = require("../authStore");

const TOGGLES_FILE = path.join(DATA_DIR, "converter-toggles.json");

const CLIENT_TOOLS = ["kiro", "antigravity", "cursor", "codex", "claude", "copilot"];

/** Client dùng cho Custom API :3000/v1 (Postman, Codex CLI, Claude CLI). */
const API_PROXY_CLIENTS = ["codex", "claude"];

const CLIENT_META = {
  kiro: {
    label: "AWS Kiro",
    icon: "☁️",
    route: "MITM :443",
    nativeFormat: "CodeWhisperer / EventStream",
    converterFile: "src/converters/clients/kiro.js",
    apiProxy: false,
  },
  antigravity: {
    label: "Google Antigravity",
    icon: "🚀",
    route: "MITM :443",
    nativeFormat: "Gemini generateContent",
    converterFile: "src/converters/clients/antigravity.js",
    apiProxy: false,
  },
  cursor: {
    label: "Cursor IDE",
    icon: "✏️",
    route: "MITM :443",
    nativeFormat: "Cursor proprietary",
    converterFile: "src/converters/clients/cursor.js",
    apiProxy: false,
  },
  codex: {
    label: "Codex / OpenAI CLI",
    icon: "🤖",
    route: "Custom API :3000/v1",
    nativeFormat: "OpenAI chat.completions",
    converterFile: "src/converters/clients/codex.js",
    apiProxy: true,
  },
  claude: {
    label: "Claude Code CLI",
    icon: "🧠",
    route: "Custom API :3000/v1",
    nativeFormat: "Anthropic messages",
    converterFile: "src/converters/clients/claude.js",
    apiProxy: true,
  },
  copilot: {
    label: "GitHub Copilot",
    icon: "🐙",
    route: "MITM :443",
    nativeFormat: "OpenAI / Anthropic",
    converterFile: "src/converters/clients/copilot.js",
    apiProxy: false,
  },
};

let fileMtime = 0;
let cachedFromFile = null;

function togglesFromApiProxyClient(apiProxyClient) {
  const client = apiProxyClient && API_PROXY_CLIENTS.includes(apiProxyClient) ? apiProxyClient : null;
  const out = {
    apiProxyClient: client,
    activeClient: client,
  };
  for (const id of CLIENT_TOOLS) {
    const on = client === id;
    out[id] = { request: on, response: on };
  }
  return out;
}

function resolveApiProxyClient(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.apiProxyClient === null) return null;
  if (typeof raw.apiProxyClient === "string" && API_PROXY_CLIENTS.includes(raw.apiProxyClient)) {
    return raw.apiProxyClient;
  }
  if (typeof raw.activeClient === "string" && API_PROXY_CLIENTS.includes(raw.activeClient)) {
    return raw.activeClient;
  }
  return null;
}

function readRawToggles() {
  try {
    if (fs.existsSync(TOGGLES_FILE)) {
      return JSON.parse(fs.readFileSync(TOGGLES_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  try {
    const store = loadAuthStore();
    if (store.converters && typeof store.converters === "object") {
      return store.converters;
    }
  } catch { /* ignore */ }
  return null;
}

function readTogglesFile() {
  try {
    if (!fs.existsSync(TOGGLES_FILE)) return null;
    const stat = fs.statSync(TOGGLES_FILE);
    if (cachedFromFile && stat.mtimeMs === fileMtime) return cachedFromFile;
    const parsed = JSON.parse(fs.readFileSync(TOGGLES_FILE, "utf8"));
    cachedFromFile = togglesFromApiProxyClient(resolveApiProxyClient(parsed));
    fileMtime = stat.mtimeMs;
    return cachedFromFile;
  } catch {
    return null;
  }
}

function getApiProxyClient() {
  const fromFile = readTogglesFile();
  if (fromFile) return fromFile.apiProxyClient || null;
  const raw = readRawToggles();
  return resolveApiProxyClient(raw);
}

/** @deprecated alias */
function getActiveClient() {
  return getApiProxyClient();
}

function loadConverterToggles() {
  const fromFile = readTogglesFile();
  if (fromFile) return fromFile;
  return togglesFromApiProxyClient(null);
}

function saveConverterToggles(toggles) {
  const client = toggles?.apiProxyClient !== undefined
    ? (toggles.apiProxyClient && API_PROXY_CLIENTS.includes(toggles.apiProxyClient) ? toggles.apiProxyClient : null)
    : toggles?.activeClient !== undefined
      ? (toggles.activeClient && API_PROXY_CLIENTS.includes(toggles.activeClient) ? toggles.activeClient : null)
      : resolveApiProxyClient(toggles);

  const normalized = togglesFromApiProxyClient(client);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOGGLES_FILE, JSON.stringify(normalized, null, 2), "utf8");
    fileMtime = 0;
    cachedFromFile = null;
  } catch (e) {
    const { err } = require("../logger");
    err(`[ConverterToggles] Cannot write ${TOGGLES_FILE}: ${e.message}`);
  }
  return normalized;
}

function setApiProxyClient(client) {
  if (client != null && !API_PROXY_CLIENTS.includes(client)) {
    throw new Error(`Custom API chỉ hỗ trợ: ${API_PROXY_CLIENTS.join(", ")}`);
  }
  const saved = saveConverterToggles({ apiProxyClient: client || null });
  try {
    const { loadAuthStore, saveAuthStore } = require("../authStore");
    const store = loadAuthStore();
    store.converters = saved;
    saveAuthStore(store);
  } catch { /* ignore */ }
  return saved;
}

function setActiveClient(client) {
  return setApiProxyClient(client);
}

function setConverterToggle(client, phase, enabled) {
  if (enabled) return setApiProxyClient(client);
  if (getApiProxyClient() === client) return setApiProxyClient(null);
  return loadConverterToggles();
}

function listClientMeta() {
  return CLIENT_TOOLS.map((id) => ({
    id,
    label: CLIENT_META[id]?.label || id,
    icon: CLIENT_META[id]?.icon || "🔌",
    route: CLIENT_META[id]?.route || "",
    nativeFormat: CLIENT_META[id]?.nativeFormat || "",
    converterFile: CLIENT_META[id]?.converterFile || "",
    apiProxy: CLIENT_META[id]?.apiProxy === true,
  }));
}

function listApiProxyMeta() {
  return listClientMeta().filter((m) => m.apiProxy);
}

/** Custom API :3000/v1 — Postman, Codex, Claude CLI. */
function isApiProxyConvertEnabled(clientTool, phase) {
  if (!clientTool || !API_PROXY_CLIENTS.includes(clientTool)) return false;
  const active = getApiProxyClient();
  if (!active || active !== clientTool) return false;

  const converter = getClientConverter(clientTool);
  if (!converter) return false;
  if (phase === "request") return typeof converter.convertRequest === "function";
  if (phase === "stream") {
    return typeof converter.transformResponseStream === "function"
      || typeof converter.convertResponse === "function";
  }
  return typeof converter.convertResponse === "function";
}

/** MITM :443 — handler riêng trong handlers/*.js, không dùng apiProxyClient. */
function isMitmConvertEnabled(_clientTool, _phase) {
  return false;
}

function isClientConvertEnabled(clientTool, phase, ctx = {}) {
  if (ctx?.meta?.via === "apiProxy" || ctx?.meta?.via === "providerRouter") {
    return isApiProxyConvertEnabled(clientTool, phase);
  }
  return isMitmConvertEnabled(clientTool, phase);
}

function detectCliClient(req) {
  const explicit = String(req.headers["x-xmitm-client"] || req.headers["x-mitm-client"] || "")
    .toLowerCase()
    .trim();
  if (API_PROXY_CLIENTS.includes(explicit)) return explicit;

  const ua = String(req.headers["user-agent"] || "").toLowerCase();
  if (ua.includes("claude")) return "claude";
  if (ua.includes("codex")) return "codex";
  return null;
}

module.exports = {
  CLIENT_TOOLS,
  API_PROXY_CLIENTS,
  CLIENT_META,
  TOGGLES_FILE,
  loadConverterToggles,
  saveConverterToggles,
  setApiProxyClient,
  getApiProxyClient,
  setActiveClient,
  getActiveClient,
  setConverterToggle,
  listClientMeta,
  listApiProxyMeta,
  isApiProxyConvertEnabled,
  isMitmConvertEnabled,
  isClientConvertEnabled,
  detectCliClient,
};
