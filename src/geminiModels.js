/**
 * geminiModels.js — Danh sach model Gemini CLI, test connect, merge quota buckets
 */
const { getMitmAlias } = require("./dbReader");
const { ensureFreshConnection } = require("./oauth/flow");
const { probeGeminiCliOAuthQuota, discoverProjectId, ensureGeminiProjectId } = require("./geminiQuota");
const { getAntigravityProjectId, loadConfig, saveConfig } = require("./configStore");
const { loadProviders, listOAuthConnectionsPublic } = require("./authStore");
const { directHttpsPost } = require("./net/directHttpsPost");

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com";
const API_VERSION = "v1internal";
const TEST_TIMEOUT_MS = 30000;

/** Model mac dinh theo Gemini CLI (chi Gemini) */
const DEFAULT_GEMINI_CLI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
  "gemini-3.5-flash-low",
  "gemini-3-flash-agent",
  "gemini-2.0-flash",
];

/** Catalog Antigravity gateway — Claude, GPT-OSS, Gemini (Google unified API) */
const DEFAULT_ANTIGRAVITY_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
  "gemini-3.5-flash-low",
  "gemini-3-flash-agent",
  "gemini-3-flash",
  "gemini-3-pro-high",
  "gemini-3-pro-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
];

function getBuiltinModelsForProvider(providerId) {
  return providerId === "antigravity" ? DEFAULT_ANTIGRAVITY_MODELS : DEFAULT_GEMINI_CLI_MODELS;
}

function getAntigravityModelFamily(modelId) {
  const m = String(modelId || "");
  if (/^claude-/i.test(m)) return "claude";
  if (/^gpt-oss/i.test(m)) return "gpt";
  if (/^gemini-/i.test(m)) return "gemini";
  return "other";
}

function isAntigravityNativeModel(model) {
  return getAntigravityModelFamily(model) !== "other";
}

/** Map placeholder Gemini CLI — khong map Claude/GPT (Antigravity giu nguyen) */
const GEMINI_MODEL_ALIASES = {
  antigravity: "gemini-2.5-flash-lite",
  "gemini-default": "gemini-2.5-flash-lite",
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-3.5-flash": "gemini-3.5-flash-low",
  "gemini-3.5-flash-high": "gemini-3-flash-agent",
  "gemini-3.5-flash-low": "gemini-3.5-flash-low",
  "gemini-3.5-flash-medium": "gemini-3.5-flash-low",
  "gemini-3.1-pro-low": "gemini-3.1-pro-preview",
  "gemini-3.1-pro-high": "gemini-3.1-pro-preview",
  "gemini-pro-agent": "gemini-3.1-pro-preview",
};

/** Thu tu fallback khi model bi 429 */
const GEMINI_FALLBACK_CHAIN = {
  "gemini-3-flash-preview": ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"],
  "gemini-3.1-pro-preview": ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"],
  "gemini-3-pro-preview": ["gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash"],
  "gemini-2.5-pro": ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
  "gemini-2.5-flash": ["gemini-2.5-flash-lite", "gemini-2.0-flash"],
  "gemini-2.0-flash": ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
};

/** Gemini 3.x — khong downgrade sang 2.5 */
const GEMINI_THINKING_FAMILY = /^gemini-3(\.\d+)?-/i;

function isGeminiThinkingFamily(model) {
  return GEMINI_THINKING_FAMILY.test(String(model || "").trim());
}

function requestHasThoughtSignatures(body) {
  const contents = body?.request?.contents || body?.contents;
  if (!Array.isArray(contents)) return false;
  for (const c of contents) {
    if (!Array.isArray(c?.parts)) continue;
    for (const p of c.parts) {
      if (p?.thought_signature || p?.thoughtSignature || p?.thought === true) return true;
      if (p?.functionCall && (p.thought_signature || p.thoughtSignature)) return true;
    }
  }
  return false;
}

function shouldPreserveThinking(body, model) {
  return requestHasThoughtSignatures(body) || isGeminiThinkingFamily(model);
}

function isGeminiNativeBody(body) {
  return !!(body?.request?.contents || body?.contents);
}

function getAntigravityThinkingLevel(body) {
  const tc = body?.request?.generationConfig?.thinkingConfig
    || body?.request?.generationConfig?.thinking_config
    || body?.generationConfig?.thinkingConfig;
  const raw = tc?.thinkingLevel || tc?.thinking_level || "";
  return String(raw).trim().toLowerCase();
}

function stripGeminiPreviewSuffix(model) {
  const m = String(model || "").trim();
  return /-preview$/i.test(m) ? m.replace(/-preview$/i, "") : m;
}

/** Antigravity client model → backend ID cho cloudcode-pa v1internal */
function resolveAntigravityBackendModel(body) {
  const raw = String(body?.model || "").trim();
  if (!raw) return "gemini-2.5-flash";

  const level = getAntigravityThinkingLevel(body);

  if (/^gemini-3\.5-flash/i.test(raw)) {
    const tierHigh = level === "high" || /-high$/i.test(raw);
    return tierHigh ? "gemini-3-flash-agent" : "gemini-3.5-flash-low";
  }
  if (raw === "gemini-3-flash-agent" || raw === "gemini-3.5-flash-low") return raw;

  let m = stripGeminiPreviewSuffix(raw);
  if (/^gemini-3-flash/i.test(m)) return "gemini-3-flash";
  if (/^gemini-3\.1-pro/i.test(m)) {
    if (level === "low" || /-low$/i.test(raw)) return "gemini-3.1-pro-low";
    return "gemini-3.1-pro-high";
  }
  if (/^gemini-3-pro/i.test(m)) {
    if (level === "low" || /-low$/i.test(raw)) return "gemini-3-pro-low";
    return "gemini-3-pro-high";
  }

  return resolveGeminiCliModel(raw, {
    preserveThinking: shouldPreserveThinking(body, raw),
  });
}

const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

/** Sua trajectory bi corrupted thought_signature (sau khi intercept doi model) */
function bypassCorruptedThoughtSignatures(bodyBuffer) {
  try {
    const body = JSON.parse(bodyBuffer.toString("utf8"));
    const contents = body?.request?.contents || body?.contents;
    if (!Array.isArray(contents)) return { buffer: bodyBuffer, changed: false };

    let changed = false;
    for (const c of contents) {
      if (!Array.isArray(c?.parts)) continue;
      for (const p of c.parts) {
        if (!(p?.thought_signature || p?.thoughtSignature || p?.functionCall)) continue;
        if (p.thought_signature !== THOUGHT_SIGNATURE_BYPASS) {
          p.thought_signature = THOUGHT_SIGNATURE_BYPASS;
          changed = true;
        }
        if (p.thoughtSignature !== THOUGHT_SIGNATURE_BYPASS) {
          p.thoughtSignature = THOUGHT_SIGNATURE_BYPASS;
          changed = true;
        }
      }
    }
    if (!changed) return { buffer: bodyBuffer, changed: false };
    return { buffer: Buffer.from(JSON.stringify(body)), changed: true };
  } catch {
    return { buffer: bodyBuffer, changed: false };
  }
}

function resolveGeminiCliModel(model, opts = {}) {
  if (!model || typeof model !== "string") return "gemini-2.5-flash";
  const m = model.trim();
  if (!m) return "gemini-2.5-flash";
  if (opts.preserveThinking) {
    if (DEFAULT_GEMINI_CLI_MODELS.includes(m)) return m;
    if (GEMINI_MODEL_ALIASES[m]) return GEMINI_MODEL_ALIASES[m];
    if (/^gemini-3\.5-flash-medium/i.test(m)) return "gemini-3.5-flash-low";
    if (/^gemini-3\.5-flash-high/i.test(m)) return "gemini-3-flash-agent";
    if (/^gemini-3\.5-flash-low/i.test(m)) return "gemini-3.5-flash-low";
    if (/^gemini-3\.1-pro/i.test(m)) return "gemini-3.1-pro-preview";
    if (/^gemini-3-pro/i.test(m)) return "gemini-3-pro-preview";
    if (/^gemini-3.*flash/i.test(m)) return "gemini-3-flash-preview";
    return m;
  }
  if (DEFAULT_GEMINI_CLI_MODELS.includes(m)) return m;
  if (GEMINI_MODEL_ALIASES[m]) return GEMINI_MODEL_ALIASES[m];
  if (/^gemini-3\.5-flash-medium/i.test(m)) return "gemini-3.5-flash-low";
  if (/^gemini-3\.5-flash-high/i.test(m)) return "gemini-3-flash-agent";
  if (/^gemini-3\.5-flash-low/i.test(m)) return "gemini-3.5-flash-low";
  if (/^gemini-3\.1-pro/i.test(m)) return "gemini-3.1-pro-preview";
  if (/^gemini-3-pro/i.test(m)) return "gemini-3-pro-preview";
  if (/^gemini-3.*flash/i.test(m)) return "gemini-3-flash-preview";
  if (/flash-lite/i.test(m)) return "gemini-2.5-flash-lite";
  if (/flash/i.test(m)) return "gemini-2.5-flash";
  if (/pro/i.test(m)) return "gemini-2.5-pro";
  return "gemini-2.5-flash";
}

function getGeminiModelTryOrder(model, opts = {}) {
  const primary = resolveGeminiCliModel(model, opts);
  if (opts.preserveThinking) return [primary];
  const extra = GEMINI_FALLBACK_CHAIN[primary] || ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
  const seen = new Set();
  const order = [];
  for (const m of [primary, ...extra]) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    order.push(m);
  }
  return order;
}

function isRateLimitHttp(status, body) {
  if (status === 429 || status === 503) return true;
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  return /RATE_LIMIT|RESOURCE_EXHAUSTED|exhausted your capacity/i.test(text);
}

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

function getAliasToolForProvider(providerId) {
  return providerId === "antigravity" ? "antigravity" : "cli";
}

function getAliasMappingsForProvider(providerId) {
  return getMitmAlias(getAliasToolForProvider(providerId)) || {};
}

function mergeModelEntries({ quotaBuckets = [], aliasMappings = {}, providerId = "gemini-cli" }) {
  const byId = new Map();
  const builtin = getBuiltinModelsForProvider(providerId);

  for (const id of builtin) {
    byId.set(id, {
      id,
      family: providerId === "antigravity" ? getAntigravityModelFamily(id) : "gemini",
      percent: null,
      resetCountdown: "",
      inCliMapping: Object.entries(aliasMappings).some(([, to]) => to === id)
        || Object.prototype.hasOwnProperty.call(aliasMappings, id),
      source: "builtin",
    });
  }

  for (const b of quotaBuckets) {
    const id = b.modelId;
    if (!id) continue;
    const prev = byId.get(id) || {
      id,
      family: providerId === "antigravity" ? getAntigravityModelFamily(id) : "gemini",
      percent: null,
      resetCountdown: "",
      inCliMapping: false,
      source: "quota",
    };
    byId.set(id, {
      ...prev,
      family: prev.family || (providerId === "antigravity" ? getAntigravityModelFamily(id) : "gemini"),
      percent: b.percent != null ? b.percent : prev.percent,
      resetCountdown: b.resetCountdown || prev.resetCountdown,
      source: prev.source === "builtin" ? "builtin+quota" : "quota",
      inCliMapping: prev.inCliMapping
        || Object.entries(aliasMappings).some(([, to]) => to === id)
        || Object.prototype.hasOwnProperty.call(aliasMappings, id),
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function listGeminiCliModels({ providerId = "gemini-cli", oauthIndex = 0, refresh = false } = {}) {
  const aliasTool = getAliasToolForProvider(providerId);
  const aliasMappings = getAliasMappingsForProvider(providerId);
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
    models: mergeModelEntries({ quotaBuckets, aliasMappings, providerId }),
    aliasTool,
    aliasMappings,
    cliMappings: aliasMappings,
    hasOAuth: !!conn?.id,
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
    const projectId = await ensureGeminiProjectId({
      accessToken: conn.accessToken,
      providerId,
    });

    const rawModel = String(modelId);
    const effectiveModel = providerId === "antigravity"
      ? (getAntigravityModelFamily(rawModel) === "gemini"
        ? resolveAntigravityBackendModel({ model: rawModel })
        : rawModel)
      : resolveGeminiCliModel(rawModel);

    const body = {
      project: String(projectId),
      model: effectiveModel,
      request: {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 8 },
      },
      userAgent: providerId === "antigravity" ? "antigravity" : "gemini-cli",
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
  DEFAULT_ANTIGRAVITY_MODELS,
  getBuiltinModelsForProvider,
  getAntigravityModelFamily,
  isAntigravityNativeModel,
  GEMINI_MODEL_ALIASES,
  GEMINI_FALLBACK_CHAIN,
  resolveGeminiCliModel,
  getGeminiModelTryOrder,
  resolveAntigravityBackendModel,
  isGeminiNativeBody,
  requestHasThoughtSignatures,
  isGeminiThinkingFamily,
  shouldPreserveThinking,
  bypassCorruptedThoughtSignatures,
  THOUGHT_SIGNATURE_BYPASS,
  isRateLimitHttp,
  listGeminiCliModels,
  testGeminiCliModel,
};
