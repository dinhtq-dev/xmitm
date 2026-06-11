/**
 * providerQuota.js — Kiem tra quota/key cho providers.json (doc lap, khong phu thuoc 9router)
 * Moi provider duoc probe qua API cua chinh no theo providerId + baseUrl.
 */
const https = require("https");
const http = require("http");
const { URL } = require("url");

const CACHE_MS = 60000;
const TIMEOUT_PROBE = 8000;

const GLM_QUOTA_URLS = {
  international: "https://api.z.ai/api/monitor/usage/quota/limit",
  china: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
};

const cache = new Map();

function parseJsonSafe(text) { try { return JSON.parse(text); } catch { return null; } }

function httpRequest(urlStr, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || TIMEOUT_PROBE;
  const method = opts.method || "GET";
  const headers = opts.headers || {};
  const body = opts.body;

  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch (e) {
      resolve({ ok: false, status: 0, body: "", error: e.message });
      return;
    }
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, body: "", error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, body: "", error: "timeout" }); });
    if (body) req.write(body);
    req.end();
  });
}

function httpsGet(urlStr, headers, timeoutMs) {
  return httpRequest(urlStr, { method: "GET", headers: headers || {}, timeoutMs: timeoutMs || TIMEOUT_PROBE });
}

function formatQuotaLabel(remaining, limit) {
  if (remaining != null && limit != null) return "Con " + remaining + "/" + limit;
  if (remaining != null) return "Con " + remaining;
  return null;
}

function formatResetCountdown(resetMs) {
  if (!resetMs || resetMs <= 0) return "";
  try {
    const diffMs = resetMs - Date.now();
    if (diffMs <= 0) return "";
    const mins = Math.ceil(diffMs / 60000);
    if (mins < 60) return " · reset " + mins + "m";
    const hrs = Math.floor(mins / 60);
    return " · reset " + hrs + "h " + (mins % 60) + "m";
  } catch { return ""; }
}

function invalidKey(providerId) {
  return { ok: false, status: "invalid_key", label: "Key " + providerId + " khong hop le", source: providerId };
}

function enrichStatPercent(result) {
  if (!result) return result;
  if (result.ok && result.percent == null) {
    if (result.remaining != null && result.limit != null && Number(result.limit) > 0) {
      result.percent = Math.min(100, Math.round((Number(result.remaining) / Number(result.limit)) * 100));
    } else if (result.quotas?.length) {
      result.percent = result.quotas.reduce((min, q) => Math.min(min, q.percent ?? 100), 100);
    } else {
      result.percent = 100;
    }
  }
  return result;
}

async function probeOpenAiCompat(baseUrl, key, providerId) {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const authHeaders = providerId === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: "Bearer " + key };
  const res = await httpsGet(root + "/v1/models", authHeaders, TIMEOUT_PROBE);
  if (res.status === 401 || res.status === 403) return invalidKey(providerId);
  if (res.ok) {
    const h = res.headers || {};
    const rem = h["x-ratelimit-remaining-requests"] || h["x-ratelimit-remaining"];
    const lim = h["x-ratelimit-limit-requests"] || h["x-ratelimit-limit"];
    if (rem != null) {
      return {
        ok: true, status: "ok", remaining: rem, limit: lim,
        label: formatQuotaLabel(rem, lim) || "Key hop le",
        source: providerId,
      };
    }
    return { ok: true, status: "ok", percent: 100, label: "Key hop le", source: providerId };
  }
  if (res.status === 0) return { ok: false, status: "unreachable", label: "Khong ket noi duoc " + providerId, source: providerId };
  return { ok: false, status: "unreachable", label: "Khong kiem tra duoc (" + res.status + ")", source: providerId };
}

async function probeDeepseekBalance(key) {
  const res = await httpsGet("https://api.deepseek.com/user/balance", { Authorization: "Bearer " + key }, TIMEOUT_PROBE);
  const data = parseJsonSafe(res.body);
  if (res.ok && data?.balance_infos?.[0]) {
    const u = data.balance_infos[0];
    return { ok: true, status: "ok", percent: 100, label: "So du: " + u.total_balance + " " + (u.currency || "USD"), source: "deepseek" };
  }
  if (res.status === 401 || res.status === 403) return invalidKey("deepseek");
  return null;
}

async function probeGlmQuota(key, region) {
  const url = GLM_QUOTA_URLS[region === "china" ? "china" : "international"];
  const res = await httpsGet(url, { Authorization: "Bearer " + key, Accept: "application/json" }, TIMEOUT_PROBE);
  const json = parseJsonSafe(res.body);
  if (res.status === 401 || res.status === 403) return invalidKey(region === "china" ? "glm-cn" : "glm");
  if (!res.ok || !json?.data) return null;

  const limits = Array.isArray(json.data.limits) ? json.data.limits : [];
  const tokenLimit = limits.find((l) => l?.type === "TOKENS_LIMIT");
  if (!tokenLimit) return { ok: true, status: "ok", label: "GLM connected", source: "glm", percent: 100 };

  const usedPct = Number(tokenLimit.percentage) || 0;
  const remaining = Math.max(0, 100 - usedPct);
  const resetAt = Number(tokenLimit.nextResetTime) || 0;
  return {
    ok: true,
    status: "ok",
    percent: remaining,
    label: "Session: " + remaining + "%" + formatResetCountdown(resetAt),
    source: "glm",
    quotas: [{ name: "session", used: usedPct, total: 100, percent: remaining, resetAt: resetAt > 0 ? new Date(resetAt).toISOString() : null }],
  };
}

async function probeGemini(key, baseUrl) {
  const errors = [];

  // Uu tien OpenAI-compat endpoint (trung voi baseUrl routing)
  const openaiRoot = (baseUrl || "https://generativelanguage.googleapis.com/v1beta/openai")
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "");
  const compatRes = await httpsGet(openaiRoot + "/v1/models", { Authorization: "Bearer " + key }, TIMEOUT_PROBE);
  if (compatRes.ok) {
    return { ok: true, status: "ok", percent: 100, label: "Key hop le", source: "gemini" };
  }
  const compatErr = parseGeminiError(compatRes);
  if (compatErr) errors.push(compatErr);

  // Fallback native Gemini API
  const nativeRes = await httpsGet(
    "https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(key),
    {},
    TIMEOUT_PROBE
  );
  if (nativeRes.ok) {
    return { ok: true, status: "ok", percent: 100, label: "Key hop le", source: "gemini" };
  }
  const nativeErr = parseGeminiError(nativeRes);
  if (nativeErr) errors.push(nativeErr);

  if ([401, 403].includes(compatRes.status) || [401, 403].includes(nativeRes.status)) {
    return { ok: false, status: "invalid_key", label: errors[0] || "Key gemini khong hop le", source: "gemini" };
  }
  return { ok: false, status: "unreachable", label: errors[0] || "Khong kiem tra duoc gemini", source: "gemini" };
}

function parseGeminiError(res) {
  const data = parseJsonSafe(res.body);
  const msg = data?.error?.message;
  if (!msg) return res.status ? "HTTP " + res.status : null;
  if (/leaked/i.test(msg)) return "Key bi Google thu hoi (leaked) — tao key moi tai AI Studio";
  if (/API key not valid|invalid/i.test(msg)) return "Key Gemini khong hop le";
  if (/billing|quota|rate limit/i.test(msg)) return msg;
  return msg.length > 120 ? msg.slice(0, 117) + "..." : msg;
}

async function probeCohere(key, baseUrl) {
  const root = (baseUrl || "https://api.cohere.ai/v1").replace(/\/+$/, "").replace(/\/v1$/i, "");
  const res = await httpsGet(root + "/v1/models", { Authorization: "Bearer " + key }, TIMEOUT_PROBE);
  if (res.status === 401 || res.status === 403) return invalidKey("cohere");
  if (res.ok) return { ok: true, status: "ok", percent: 100, label: "Key hop le", source: "cohere" };
  return probeOpenAiCompat(baseUrl || "https://api.cohere.ai/v1", key, "cohere");
}

/** Probe theo dung providerId — khong doan provider tu prefix key */
async function probeByProvider(providerId, baseUrl, key) {
  switch (providerId) {
    case "deepseek":
      return (await probeDeepseekBalance(key)) || probeOpenAiCompat(baseUrl, key, providerId);
    case "gemini":
      return probeGemini(key, baseUrl);
    case "glm":
      return (await probeGlmQuota(key, "international")) || probeOpenAiCompat(baseUrl, key, providerId);
    case "glm-cn":
      return (await probeGlmQuota(key, "china")) || probeOpenAiCompat(baseUrl, key, providerId);
    case "cohere":
      return probeCohere(key, baseUrl);
    case "opencode": {
      try {
        const { getPublicStatus, resolveOpencodeBinary } = require("./opencode/sessionProvider");
        if (!resolveOpencodeBinary()) {
          return { ok: false, status: "unreachable", label: "Khong tim thay opencode CLI", source: providerId };
        }
        const status = getPublicStatus();
        if (status.running && status.sessionId) {
          return {
            ok: true,
            status: "ok",
            percent: 100,
            label: "Session " + status.sessionId.slice(0, 16) + "…",
            source: providerId,
          };
        }
        return { ok: true, status: "ok", percent: 100, label: "OpenCode imported", source: providerId };
      } catch (e) {
        return { ok: false, status: "unknown", label: e.message, source: providerId };
      }
    }
    case "anthropic":
    case "openai":
    case "chatgpt":
    case "groq":
    case "mistral":
    case "together":
    case "perplexity":
      return baseUrl ? probeOpenAiCompat(baseUrl, key, providerId) : invalidKey(providerId);
    default:
      return baseUrl ? probeOpenAiCompat(baseUrl, key, providerId) : { ok: false, status: "unknown", label: "Khong ho tro provider " + providerId, source: "none" };
  }
}

async function checkProviderQuota(providerId, opts) {
  const { baseUrl, key, skipCache } = opts;
  if (!key) return { ok: false, status: "no_key", label: "Chua co key", source: "none" };

  const cacheKey = providerId + ":" + key.slice(-8);
  if (skipCache) cache.delete(cacheKey);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const result = enrichStatPercent(await probeByProvider(providerId, baseUrl, key));
  cache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

async function checkProviderKeyAtIndex(providersConfig, providerId, keyIndex) {
  const prov = providersConfig.providers?.[providerId];
  const key = prov?.keys?.[keyIndex];
  if (!key) return null;
  const stat = await checkProviderQuota(providerId, {
    baseUrl: prov.baseUrl,
    key,
    skipCache: true,
  });
  return { index: keyIndex, ...stat };
}

async function checkAllProviders(providersConfig) {
  const providers = providersConfig.providers || {};
  const entries = await Promise.all(
    Object.entries(providers).map(async ([pid, prov]) => {
      const keys = prov.keys || [];
      if (!keys.length) return [pid, { keys: [], aggregate: { ok: false, label: "Chua co key" } }];
      const keyStats = await Promise.all(
        keys.map((key, i) => checkProviderQuota(pid, { baseUrl: prov.baseUrl, key }).then((r) => ({ index: i, ...r })))
      );
      return [pid, { keys: keyStats, aggregate: keyStats.find((k) => k.ok) || keyStats[0] }];
    })
  );
  return Object.fromEntries(entries);
}

function clearQuotaCache() {
  cache.clear();
}

module.exports = { checkProviderQuota, checkProviderKeyAtIndex, checkAllProviders, clearQuotaCache };
