/**
 * tokenTracker.js — Parses token usage from response bodies and aggregates stats
 * in a persistent JSON file for cost/usage reporting.
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");
const { log, err } = require("./logger");

const STATS_FILE = path.join(DATA_DIR, "token-usage-stats.json");

// Default pricing per 1M tokens (in USD)
const MODEL_PRICING = {
  // Gemini CLI / Antigravity / Studio models
  "gemini-2.5-flash": { input: 0.075, output: 0.30 },
  "gemini-2.5-flash-lite": { input: 0.0375, output: 0.15 },
  "gemini-2.5-pro": { input: 1.25, output: 5.00 },
  "gemini-2.0-flash": { input: 0.075, output: 0.30 },
  "gemini-3-flash-preview": { input: 0.075, output: 0.30 },
  "gemini-3-pro-preview": { input: 1.25, output: 5.00 },
  "gemini-3.1-pro-preview": { input: 1.25, output: 5.00 },
  "gemini-3.5-flash-low": { input: 0.075, output: 0.30 },
  "gemini-3.5-flash-medium": { input: 0.075, output: 0.30 },
  "gemini-3.5-flash-high": { input: 0.075, output: 0.30 },
  "gemini-default": { input: 0.075, output: 0.30 },

  // Claude / Anthropic
  "claude-3-5-sonnet": { input: 3.00, output: 15.00 },
  "claude-3-5-haiku": { input: 0.80, output: 4.00 },
  "claude-3-opus": { input: 15.00, output: 75.00 },

  // OpenAI
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.150, output: 0.60 },
  "o1": { input: 15.00, output: 60.00 },
  "o1-mini": { input: 3.00, output: 12.00 },

  // Fallback default (flash-like pricing)
  "_default": { input: 0.10, output: 0.40 }
};

function getPricing(model) {
  if (!model) return MODEL_PRICING._default;
  const normalized = model.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_PRICING)) {
    if (normalized.includes(key)) return value;
  }
  return MODEL_PRICING._default;
}

function calculateCost(model, inputTokens, outputTokens) {
  const pricing = getPricing(model);
  const inputCost = (inputTokens / 1000000) * pricing.input;
  const outputCost = (outputTokens / 1000000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(6));
}

// Safely loads stats or returns empty initial stats structure
function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = fs.readFileSync(STATS_FILE, "utf-8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && parsed.daily) {
        return parsed;
      }
    }
  } catch (e) {
    err(`Failed to read token usage stats: ${e.message}`);
  }

  return {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCost: 0,
    daily: {}
  };
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {
    err(`Failed to write token usage stats: ${e.message}`);
  }
}

/**
 * Extracts usage info from a raw text body (either JSON or SSE text stream).
 */
function extractUsageFromText(bodyText) {
  if (!bodyText || typeof bodyText !== "string") return null;

  // 1. Try parsing as complete JSON first
  try {
    const json = JSON.parse(bodyText);
    // OpenAI format
    if (json?.usage) {
      const input = json.usage.prompt_tokens || json.usage.input_tokens || 0;
      const output = json.usage.completion_tokens || json.usage.output_tokens || 0;
      if (input > 0 || output > 0) {
        return { input, output };
      }
    }
    // Anthropic API format
    if (json?.usage?.input_tokens || json?.usage?.output_tokens) {
      return {
        input: json.usage.input_tokens || 0,
        output: json.usage.output_tokens || 0
      };
    }
    // Gemini API format
    if (json?.usageMetadata) {
      return {
        input: json.usageMetadata.promptTokenCount || 0,
        output: json.usageMetadata.candidatesTokenCount || 0
      };
    }
  } catch {
    // Silent catch, proceed to stream parsing
  }

  // 2. Try parsing SSE/Chunked Stream (often seen in Gemini CLI / Antigravity SSE or OpenAI streaming)
  let lastPromptToken = 0;
  let lastCandidatesToken = 0;
  let lastOpenAiPromptToken = 0;
  let lastOpenAiCompletionToken = 0;

  // Search line by line or using regex
  const sseLines = bodyText.split(/\r?\n/);
  for (const line of sseLines) {
    if (!line.trim() || !line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (dataStr === "[DONE]") continue;

    try {
      const parsed = JSON.parse(dataStr);
      // Gemini SSE
      if (parsed?.response?.usageMetadata) {
        const u = parsed.response.usageMetadata;
        if (u.promptTokenCount) lastPromptToken = u.promptTokenCount;
        if (u.candidatesTokenCount) lastCandidatesToken = u.candidatesTokenCount;
      }
      // OpenAI SSE
      if (parsed?.usage) {
        if (parsed.usage.prompt_tokens) lastOpenAiPromptToken = parsed.usage.prompt_tokens;
        if (parsed.usage.completion_tokens) lastOpenAiCompletionToken = parsed.usage.completion_tokens;
      }
    } catch {
      // Ignore invalid JSON chunks
    }
  }

  if (lastPromptToken > 0 || lastCandidatesToken > 0) {
    return { input: lastPromptToken, output: lastCandidatesToken };
  }
  if (lastOpenAiPromptToken > 0 || lastOpenAiCompletionToken > 0) {
    return { input: lastOpenAiPromptToken, output: lastOpenAiCompletionToken };
  }

  // 3. Last resort regex matching for streamed JSON fragments
  const promptMatch = bodyText.match(/"promptTokenCount"\s*:\s*(\d+)/);
  const candidatesMatch = bodyText.match(/"candidatesTokenCount"\s*:\s*(\d+)/);
  if (promptMatch || candidatesMatch) {
    return {
      input: promptMatch ? parseInt(promptMatch[1], 10) : 0,
      output: candidatesMatch ? parseInt(candidatesMatch[1], 10) : 0
    };
  }

  const openAiPromptMatch = bodyText.match(/"prompt_tokens"\s*:\s*(\d+)/);
  const openAiCompletionMatch = bodyText.match(/"completion_tokens"\s*:\s*(\d+)/);
  if (openAiPromptMatch || openAiCompletionMatch) {
    return {
      input: openAiPromptMatch ? parseInt(openAiPromptMatch[1], 10) : 0,
      output: openAiCompletionMatch ? parseInt(openAiCompletionMatch[1], 10) : 0
    };
  }

  return null;
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sumDailyBuckets(stats, predicate) {
  let requests = 0;
  let input = 0;
  let output = 0;
  let cost = 0;

  for (const [dateKey, item] of Object.entries(stats.daily || {})) {
    if (!predicate(dateKey)) continue;
    requests += item.requests || 0;
    input += item.inputTokens || 0;
    output += item.outputTokens || 0;
    cost += item.cost || 0;
  }

  return {
    requests,
    inputTokens: input,
    outputTokens: output,
    cost: Number(cost.toFixed(6)),
  };
}

function inLastCalendarDays(days) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffKey = localDateKey(cutoff);
  return (dateKey) => dateKey >= cutoffKey;
}

function inRolling24Hours(dateKey) {
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  const dayStart = new Date(`${dateKey}T00:00:00`).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  return dayEnd > limit;
}

/**
 * Tracks a new request. Call this from server.js when response is fully sent.
 */
function trackRequest({ model, bodyText }) {
  const usage = extractUsageFromText(bodyText);
  if (!usage) return; // No token usage found, skip tracking (e.g., handshake, errors, or non-LLM requests)

  const input = usage.input;
  const output = usage.output;
  const cost = calculateCost(model, input, output);
  const dateStr = localDateKey();

  const stats = loadStats();
  stats.totalRequests += 1;
  stats.totalInputTokens += input;
  stats.totalOutputTokens += output;
  stats.estimatedCost = Number((stats.estimatedCost + cost).toFixed(6));

  if (!stats.daily[dateStr]) {
    stats.daily[dateStr] = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0
    };
  }

  const d = stats.daily[dateStr];
  d.requests += 1;
  d.inputTokens += input;
  d.outputTokens += output;
  d.cost = Number((d.cost + cost).toFixed(6));

  saveStats(stats);
  log(`🪙 [TokenTracker] Tracked usage: +${input} in, +${output} out for model "${model || "unknown"}". Cost: ~$${cost}`);
}

/**
 * Retrieves aggregate statistics for the dashboard.
 */
function getSummaryStats() {
  const stats = loadStats();
  const todayStr = localDateKey();

  return {
    lifetime: {
      requests: stats.totalRequests,
      inputTokens: stats.totalInputTokens,
      outputTokens: stats.totalOutputTokens,
      cost: Number((stats.estimatedCost || 0).toFixed(6)),
    },
    today: sumDailyBuckets(stats, (d) => d === todayStr),
    last24h: sumDailyBuckets(stats, inRolling24Hours),
    last7d: sumDailyBuckets(stats, inLastCalendarDays(7)),
    last30d: sumDailyBuckets(stats, inLastCalendarDays(30)),
    last60d: sumDailyBuckets(stats, inLastCalendarDays(60)),
    dailyRaw: stats.daily,
    meta: {
      todayKey: todayStr,
      trackedDays: Object.keys(stats.daily || {}).length,
    },
  };
}

module.exports = {
  trackRequest,
  getSummaryStats,
  extractUsageFromText,
  MODEL_PRICING
};
