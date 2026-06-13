/**
 * geminiQuota.js — Gemini CLI / Antigravity quota via retrieveUserQuota (AIClient2API compatible)
 */
const { getAntigravityProjectId, loadConfig, saveConfig } = require("./configStore");
const { loadProviders } = require("./authStore");
const { ensureFreshConnection } = require("./oauth/flow");
const { directHttpsPost } = require("./net/directHttpsPost");

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com";
const API_VERSION = "v1internal";
const TIMEOUT_MS = 15000;

const cache = new Map();
const CACHE_MS = 60000;
const projectCache = new Map();
const PROJECT_CACHE_MS = 3600000;

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

function httpsPost(urlStr, headers, body) {
  return directHttpsPost(urlStr, headers, body, {
    timeoutMs: TIMEOUT_MS,
    tlsInsecure: isTlsInsecure(),
  });
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

function clearAntigravityProjectId() {
  const cfg = loadConfig();
  if (cfg.system.antigravityProjectId) {
    cfg.system.antigravityProjectId = "";
    saveConfig(cfg);
  }
  projectCache.clear();
}

function isIamPermissionError(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  return /cloudaicompanion\.instances\.completeTask|lacks the required IAM permission/i.test(text);
}

/**
 * Lay project ID cho Code Assist — uu tien discover tu OAuth token, khong luu project sai vao config.
 */
async function ensureGeminiProjectId({
  accessToken,
  providerId = "gemini-cli",
  forceDiscover = false,
} = {}) {
  if (!accessToken) {
    const configured = resolveProjectId(providerId);
    if (configured) return configured;
    throw new Error("Can OAuth token de discover project ID");
  }

  const cacheKey = `${providerId}:${accessToken.slice(-12)}`;
  if (!forceDiscover) {
    const configured = resolveProjectId(providerId);
    if (configured) return configured;
    const hit = projectCache.get(cacheKey);
    if (hit && Date.now() - hit.at < PROJECT_CACHE_MS) return hit.project;
  } else {
    clearAntigravityProjectId();
    projectCache.delete(cacheKey);
  }

  const project = await discoverProjectId(accessToken);
  projectCache.set(cacheKey, { project, at: Date.now() });
  return project;
}

function parseResetTimeMs(resetTime) {
  if (resetTime == null || resetTime === "") return null;
  if (typeof resetTime === "object") {
    const sec = Number(resetTime.seconds ?? resetTime._seconds ?? 0);
    const nanos = Number(resetTime.nanos ?? resetTime._nanos ?? 0);
    if (sec > 0) return sec * 1000 + Math.floor(nanos / 1e6);
    return null;
  }
  if (typeof resetTime === "number") {
    if (!resetTime) return null;
    return resetTime < 1e12 ? resetTime * 1000 : resetTime;
  }
  if (typeof resetTime === "string") {
    const trimmed = resetTime.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function formatResetCountdownOnly(resetTime) {
  const ms = parseResetTimeMs(resetTime);
  if (ms == null || ms <= new Date("2020-01-01").getTime()) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "";
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatResetTime(resetTime) {
  const countdown = formatResetCountdownOnly(resetTime);
  return countdown ? ` · reset ${countdown}` : "";
}

function parseTierLabel(tierId) {
  if (!tierId || typeof tierId !== "string") return "";
  if (tierId.includes("pro")) return "Pro";
  if (tierId.includes("free")) return "Free";
  return tierId.split(/\s+/).pop() || tierId;
}

function bucketResetMs(bucket) {
  return parseResetTimeMs(bucket?.resetTime);
}

/** Bo qua bucket reset epoch (model khong co quota that) */
function isRealQuotaBucket(bucket) {
  const ms = bucketResetMs(bucket);
  if (ms == null) return true;
  return ms > new Date("2020-01-01").getTime();
}

function formatBuckets(data) {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  if (!buckets.length) {
    return {
      ok: true,
      status: "ok",
      percent: 100,
      label: "Quota OK (khong co bucket chi tiet)",
      source: "gemini-cli",
      buckets: [],
    };
  }

  const items = buckets.map((bucket) => {
    const remainingFrac = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : 0;
    const percentRemaining = Math.min(100, Math.max(0, Math.round(remainingFrac * 100)));
    return {
      modelId: bucket.modelId || "unknown",
      percent: percentRemaining,
      remainingFraction: remainingFrac,
      resetTime: bucket.resetTime || null,
      resetAtMs: parseResetTimeMs(bucket.resetTime),
      resetCountdown: formatResetCountdownOnly(bucket.resetTime),
      label: `${bucket.modelId || "model"}: con ${percentRemaining}%${formatResetTime(bucket.resetTime)}`,
    };
  });

  items.sort((a, b) => a.modelId.localeCompare(b.modelId));
  const quotaBuckets = items.filter(isRealQuotaBucket);
  const forAggregate = quotaBuckets.length ? quotaBuckets : items;
  const minRemaining = forAggregate.reduce((min, b) => Math.min(min, b.percent), 100);
  const worst = forAggregate.find((b) => b.percent === minRemaining) || forAggregate[0];
  const plan = parseTierLabel(data.tierId);

  return {
    ok: true,
    status: "ok",
    percent: minRemaining,
    remaining: minRemaining,
    limit: 100,
    label: `${plan ? plan + " · " : ""}Con ~${minRemaining}% (${worst.modelId})${formatResetTime(worst.resetTime)}`,
    resetAtMs: parseResetTimeMs(worst.resetTime),
    resetCountdown: formatResetCountdownOnly(worst.resetTime),
    source: "gemini-cli",
    tierId: data.tierId || null,
    account: data.account || null,
    buckets: items,
  };
}

async function discoverProjectId(accessToken) {
  const res = await httpsPost(
    apiUrl("loadCodeAssist"),
    { Authorization: `Bearer ${accessToken}` },
    {
      cloudaicompanionProject: "",
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
        duetProject: "",
      },
    }
  );
  const data = parseJsonSafe(res.body);
  if (!res.ok) {
    const msg = data?.error?.message || res.error || `HTTP ${res.status}`;
    throw new Error(`loadCodeAssist failed: ${msg}`);
  }
  const project = data?.cloudaicompanionProject || data?.project || "";
  if (!project) throw new Error("Khong tim thay project ID — set system.antigravityProjectId trong config.json");
  return project;
}

async function retrieveUserQuota(accessToken, projectId) {
  const res = await httpsPost(
    apiUrl("retrieveUserQuota"),
    { Authorization: `Bearer ${accessToken}` },
    { project: String(projectId) }
  );
  const data = parseJsonSafe(res.body);
  if (!res.ok) {
    const msg = data?.error?.message || res.error || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: "invalid_key", label: "OAuth het han — Login lai", source: "gemini-cli" };
    }
    if (/quota|rate|exhausted/i.test(msg)) {
      return { ok: false, status: "quota_exceeded", label: msg, source: "gemini-cli" };
    }
    const hint = res.connectIp ? ` [ip ${res.connectIp}]` : "";
    return { ok: false, status: "unreachable", label: msg + hint, source: "gemini-cli" };
  }
  return formatBuckets(data);
}

/**
 * Probe Gemini CLI OAuth quota for one connection.
 */
async function probeGeminiCliOAuthQuota({ connectionId, providerId = "gemini-cli", skipCache = false }) {
  if (!connectionId) {
    return { ok: false, status: "no_oauth", label: "Chua login OAuth", source: "gemini-cli" };
  }

  const cacheKey = `oauth:${connectionId}`;
  if (skipCache) cache.delete(cacheKey);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  try {
    const conn = await ensureFreshConnection(connectionId);
    const projectId = await ensureGeminiProjectId({
      accessToken: conn.accessToken,
      providerId,
    });
    const result = await retrieveUserQuota(conn.accessToken, projectId);
    result.connectionId = connectionId;
    result.projectId = projectId;
    cache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  } catch (e) {
    return { ok: false, status: "unknown", label: e.message, source: "gemini-cli", connectionId };
  }
}

function clearGeminiQuotaCache() {
  cache.clear();
}

module.exports = {
  probeGeminiCliOAuthQuota,
  clearGeminiQuotaCache,
  retrieveUserQuota,
  discoverProjectId,
  ensureGeminiProjectId,
  clearAntigravityProjectId,
  isIamPermissionError,
};
