/**
 * providerQuota.js - Kiem tra quota/key (xmitm admin)
 * 9router: GET /api/usage/{connectionId} -> open-sse/services/usage.js (per provider API)
 * Khong lay quota tu /api/providers (chi list connection, khong co remaining).
 */
const https = require("https");
const http = require("http");
const { URL } = require("url");

const NINE_ROUTER_BASE = String(process.env.NINE_ROUTER_BASE || process.env.MITM_ROUTER_BASE || "http://127.0.0.1:20128")
  .trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
const CACHE_MS = 60000;
const TIMEOUT_ROUTER = 1200;
const TIMEOUT_PROBE = 4500;
const cache = new Map();
let nineRouterUp = null;
let nineRouterCheckedAt = 0;

function httpsGet(urlStr, headers, timeoutMs) {
  headers = headers || {};
  timeoutMs = timeoutMs || TIMEOUT_PROBE;
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { resolve({ ok: false, status: 0, body: "", error: e.message }); return; }
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET", headers, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, body: "", error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, body: "", error: "timeout" }); });
    req.end();
  });
}

function parseJsonSafe(text) { try { return JSON.parse(text); } catch { return null; } }
function formatQuotaLabel(remaining, limit) {
  if (remaining != null && limit != null) return "Con " + remaining + "/" + limit;
  if (remaining != null) return "Con " + remaining;
  return null;
}

async function isNineRouterRunning() {
  if (nineRouterUp != null && Date.now() - nineRouterCheckedAt < 30000) return nineRouterUp;
  const res = await httpsGet(NINE_ROUTER_BASE + "/api/providers", {}, TIMEOUT_ROUTER);
  nineRouterUp = res.ok;
  nineRouterCheckedAt = Date.now();
  return nineRouterUp;
}

/** Chi bao 9router dang chay; quota that o /api/usage/{id} (OAuth connection). */
async function hintFrom9Router(providerId) {
  if (!(await isNineRouterRunning())) return null;
  return {
    ok: true,
    status: "ok",
    percent: null,
    label: "9router :20128 - xem Usage tab (/api/usage)",
    source: "9router-hint",
    note: "Quota OAuth: GET /api/usage/{connectionId}",
  };
}

async function probeOpenAiCompat(baseUrl, key, providerId) {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const authHeaders = providerId === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: "Bearer " + key };
  const res = await httpsGet(root + "/v1/models", authHeaders, TIMEOUT_PROBE);
  if (res.status === 401 || res.status === 403) return { ok: false, status: "invalid_key", label: "Key khong hop le", source: "probe" };
  if (res.ok) {
    const h = res.headers || {};
    const rem = h["x-ratelimit-remaining-requests"] || h["x-ratelimit-remaining"];
    const lim = h["x-ratelimit-limit-requests"] || h["x-ratelimit-limit"];
    if (rem != null) return { ok: true, status: "ok", remaining: rem, limit: lim, label: formatQuotaLabel(rem, lim) || "Key OK", source: "headers" };
    return { ok: true, status: "ok", percent: 100, label: "Key OK", source: "probe" };
  }
  return { ok: false, status: "unreachable", label: "Khong kiem tra duoc", source: "probe" };
}

async function probeDeepseekBalance(key) {
  const res = await httpsGet("https://api.deepseek.com/user/balance", { Authorization: "Bearer " + key }, TIMEOUT_PROBE);
  const data = parseJsonSafe(res.body);
  if (res.ok && data?.balance_infos?.[0]) {
    const u = data.balance_infos[0];
    return { ok: true, status: "ok", percent: 100, label: "So du: " + u.total_balance + " " + (u.currency || "USD"), source: "deepseek" };
  }
  return null;
}

async function probeGemini(key) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash?key=" + encodeURIComponent(key);
  const res = await httpsGet(url, {}, TIMEOUT_PROBE);
  if ([400, 401, 403].includes(res.status)) return { ok: false, status: "invalid_key", label: "Key Gemini khong hop le", source: "gemini" };
  if (res.ok) return { ok: true, status: "ok", percent: 100, label: "Key hop le (quota OAuth: 9router Usage)", source: "gemini" };
  return null;
}

async function checkProviderQuota(providerId, opts) {
  const { baseUrl, key } = opts;
  if (!key) return { ok: false, status: "no_key", label: "Chua co key", source: "none" };
  const cacheKey = providerId + ":" + key.slice(-8);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  let result = null;
  if (key.startsWith("AIza")) result = await probeGemini(key);
  if (!result && providerId === "deepseek") result = await probeDeepseekBalance(key);
  if (!result && (providerId === "gemini" || key.startsWith("AIza"))) result = await probeGemini(key);
  if (!result && baseUrl) result = await probeOpenAiCompat(baseUrl, key, providerId);
  if (!result) result = await hintFrom9Router(providerId);
  if (!result) result = { ok: false, status: "unknown", label: "Khong kiem tra duoc key", source: "none" };

  if (result.ok && result.percent == null) {
    if (result.remaining != null && result.limit != null && Number(result.limit) > 0) {
      result.percent = Math.min(100, Math.round((Number(result.remaining) / Number(result.limit)) * 100));
    } else if (result.percent == null) {
      result.percent = result.source === "9router-hint" ? null : 100;
    }
  }
  cache.set(cacheKey, { at: Date.now(), data: result });
  return result;
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
      return [pid, { keys: keyStats, aggregate: keyStats[0], nineRouterBase: NINE_ROUTER_BASE }];
    })
  );
  return Object.fromEntries(entries);
}

function clearQuotaCache() {
  cache.clear();
  nineRouterUp = null;
  nineRouterCheckedAt = 0;
}

module.exports = { checkProviderQuota, checkAllProviders, clearQuotaCache, NINE_ROUTER_BASE };
