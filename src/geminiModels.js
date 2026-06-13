/**
 * geminiModels.js — Danh sach model Gemini CLI, test connect, merge quota buckets
 */
const { getMitmAlias } = require("./dbReader");
const { ensureFreshConnection } = require("./oauth/flow");
const { probeGeminiCliOAuthQuota, discoverProjectId } = require("./geminiQuota");
const { getAntigravityProjectId, loadConfig, saveConfig } = require("./configStore");
const { loadProviders, listOAuthConnectionsPublic } = require("./authStore");
const { directHttpsPost } = require("./net/directHttpsPost");

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com";
const API_VERSION = "v1internal";
const TEST_TIMEOUT_MS = 30000;

/** Model mac dinh theo Gemini CLI */
const DEFAULT_GEMINI_CLI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
  "gemini-2.0-flash",
];

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function isTlsInsecure() {
  try {
    const sys = loadConfig().system || {};
    return !!(sys.tlsInsecure || process.env.XMITM_TLS_INSECURE === "1");
  } catch {
    return false;
  }
}

function apiUrl(method) {
  return `${CODE_ASSIST_BASE}/${API_VERSION}:${method}`;
}

function resolveProjectId(providerId) {
  const fromConfig = getAntigravityProjectId();
  if (fromConfig) return fromConfig;
  try {
    const prov = loadProviders()?.providers?.[providerId];
    return prov?.projectId || prov?.project || "";
  } catch {
    return "";
  }
}

function resolveOAuthConnection(providerId, oauthIndex = 0) {
  const rows = listOAuthConnectionsPublic(providerId);
  if (!rows.length) return null;
  const idx = Math.max(0, Math.min(oauthIndex, rows.length - 1));
  return rows[idx];
}

function mergeModelEntries({ quotaBuckets = [], cliMappings = {} }) {
  const byId = new Map();

  for (const id of DEFAULT_GEMINI_CLI_MODELS) {
    byId.set(id, {
      id,
      percent: null,
      resetCountdown: "",
      inCliMapping: Object.entries(cliMappings).some(([, to]) => to === id)
        || Object.prototype.hasOwnProperty.call(cliMappings, id),
      source: "builtin",
    });
  }

  for (const b of quotaBuckets) {
    const id = b.modelId;
    if (!id) continue;
    const prev = byId.get(id) || {
      id,
      percent: null,
      resetCountdown: "",
      inCliMapping: false,
      source: "quota",
    };
    byId.set(id, {
      ...prev,
      percent: b.percent != null ? b.percent : prev.percent,
      resetCountdown: b.resetCountdown || prev.resetCountdown,
      source: prev.source === "builtin" ? "builtin+quota" : "quota",
      inCliMapping: prev.inCliMapping
        || Object.entries(cliMappings).some(([, to]) => to === id)
        || Object.prototype.hasOwnProperty.call(cliMappings, id),
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function listGeminiCliModels({ providerId = "gemini-cli", oauthIndex = 0, refresh = false } = {}) {
  const cliMappings = getMitmAlias("cli") || {};
  const conn = resolveOAuthConnection(providerId, oauthIndex);
  let quotaBuckets = [];

  if (conn?.id) {
    const quota = await probeGeminiCliOAuthQuota({
      connectionId: conn.id,
      providerId,
      skipCache: refresh,
    });
    if (quota?.ok && Array.isArray(quota.buckets)) {
      quotaBuckets = quota.buckets;
    }
  }

  return {
    provider: providerId,
    models: mergeModelEntries({ quotaBuckets, cliMappings }),
    cliMappings,
    hasOAuth: !!conn,
  };
}

async function testGeminiCliModel({
  providerId = "gemini-cli",
  modelId,
  oauthIndex = 0,
} = {}) {
  if (!modelId) {
    return { ok: false, status: "invalid", label: "Thieu modelId" };
  }

  const connRow = resolveOAuthConnection(providerId, oauthIndex);
  if (!connRow?.id) {
    return { ok: false, status: "no_oauth", label: "Chua login OAuth" };
  }

  const started = Date.now();
  try {
    const conn = await ensureFreshConnection(connRow.id);
    let projectId = resolveProjectId(providerId);
    if (!projectId) {
      projectId = await discoverProjectId(conn.accessToken);
      const cfg = loadConfig();
      if (!cfg.system.antigravityProjectId) {
        cfg.system.antigravityProjectId = projectId;
        saveConfig(cfg);
      }
    }

    const body = {
      project: String(projectId),
      model: String(modelId),
      request: {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 8 },
      },
      userAgent: "gemini-cli",
      requestId: `xmitm-test-${Date.now()}`,
      requestType: "agent",
    };

    const res = await directHttpsPost(
      apiUrl("generateContent"),
      { Authorization: `Bearer ${conn.accessToken}` },
      body,
      { timeoutMs: TEST_TIMEOUT_MS, tlsInsecure: isTlsInsecure() }
    );
    const latencyMs = Date.now() - started;
    const data = parseJsonSafe(res.body);
    const wrapped = data?.response || data;
    const hasCandidate = !!(wrapped?.candidates?.length);
    const hasText = hasCandidate && wrapped.candidates.some((c) =>
      (c?.content?.parts || []).some((p) => p?.text != null)
    );

    if (res.ok && (hasCandidate || hasText)) {
      return {
        ok: true,
        status: "ok",
        label: `OK · ${latencyMs}ms`,
        latencyMs,
        modelId,
      };
    }

    const msg = data?.error?.message || res.error || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: "auth", label: "OAuth het han", latencyMs, modelId };
    }
    if (/quota|rate|exhausted|capacity/i.test(msg)) {
      const resetMatch = /reset after ([^.]+)/i.exec(msg);
      const resetHint = resetMatch ? ` (reset ${resetMatch[1].trim()})` : "";
      return { ok: false, status: "quota", label: "Het quota" + resetHint, latencyMs, modelId };
    }
    if (/not found|unknown model|invalid model/i.test(msg)) {
      return { ok: false, status: "unavailable", label: "Model khong kha dung", latencyMs, modelId };
    }
    return { ok: false, status: "error", label: msg.slice(0, 120), latencyMs, modelId };
  } catch (e) {
    return {
      ok: false,
      status: "error",
      label: e.message || "Test that bai",
      latencyMs: Date.now() - started,
      modelId,
    };
  }
}

module.exports = {
  DEFAULT_GEMINI_CLI_MODELS,
  listGeminiCliModels,
  testGeminiCliModel,
};
