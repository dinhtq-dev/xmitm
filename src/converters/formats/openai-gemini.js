/**
 * OpenAI chat.completions ↔ Gemini / Antigravity (Code Assist) wire format.
 */
const crypto = require("crypto");

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      if (typeof p.text === "string") return p.text;
      if (typeof p.input_text === "string") return p.input_text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function openAiRoleToGemini(role) {
  if (role === "assistant") return "model";
  if (role === "system") return "system";
  return "user";
}

function openAiMessagesToGeminiContents(messages = []) {
  const contents = [];
  let systemParts = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (text) systemParts.push({ text });
      continue;
    }
    const parts = [];
    const text = extractText(msg.content);
    if (text) parts.push({ text });
    if (parts.length === 0) continue;
    contents.push({
      role: openAiRoleToGemini(msg.role),
      parts,
    });
  }

  return { contents, systemInstruction: systemParts.length ? { parts: systemParts } : null };
}

function openAiToolsToGemini(tools = []) {
  const declarations = [];
  for (const t of tools) {
    if (!t || t.type !== "function" || !t.function) continue;
    const fn = t.function;
    declarations.push({
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters || { type: "object", properties: {} },
    });
  }
  if (!declarations.length) return null;
  return [{ functionDeclarations: declarations }];
}

function openAiBodyToAntigravity(body, { project, model, stream = false } = {}) {
  const { contents, systemInstruction } = openAiMessagesToGeminiContents(body.messages || []);
  const generationConfig = {};
  if (body.temperature != null) generationConfig.temperature = body.temperature;
  if (body.max_tokens != null) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.top_p != null) generationConfig.topP = body.top_p;

  const request = { contents };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const tools = openAiToolsToGemini(body.tools);
  if (tools) request.tools = tools;

  return {
    project: project || process.env.ANTIGRAVITY_PROJECT_ID || "",
    model: model || body.model || "gemini-2.0-flash",
    request,
    userAgent: "antigravity",
    requestId: `xmitm-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    requestType: stream ? "stream" : "agent",
  };
}

function unwrapGeminiBody(body) {
  if (!body || typeof body !== "object") return body;
  if (body.response && typeof body.response === "object") return body.response;
  return body;
}

function finishReasonToOpenAi(reason) {
  const r = String(reason || "").toUpperCase();
  if (r === "STOP") return "stop";
  if (r === "MAX_TOKENS") return "length";
  if (r.includes("TOOL")) return "tool_calls";
  return "stop";
}

function geminiResponseToOpenAi(body, modelName) {
  const gemini = unwrapGeminiBody(body);
  const candidate = gemini?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map((p) => p?.text || "").filter(Boolean).join("");
  const usage = gemini?.usageMetadata || {};

  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName || gemini?.modelVersion || "antigravity",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReasonToOpenAi(candidate?.finishReason),
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokenCount || 0,
      completion_tokens: usage.candidatesTokenCount || 0,
      total_tokens: usage.totalTokenCount || 0,
    },
  };
}

function geminiStreamChunkToOpenAiSse(line, modelName, state = {}) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed === "data: [DONE]") return trimmed ? `${trimmed}\n\n` : null;
  if (!trimmed.startsWith("data:")) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(5).trim());
  } catch {
    return null;
  }

  const gemini = unwrapGeminiBody(parsed);
  const candidate = gemini?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const delta = parts.map((p) => p?.text || "").join("");
  if (!delta && !candidate?.finishReason) return null;

  if (!state.id) state.id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const chunk = {
    id: state.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName || gemini?.modelVersion || "antigravity",
    choices: [
      {
        index: 0,
        delta: delta ? { content: delta } : {},
        finish_reason: candidate?.finishReason ? finishReasonToOpenAi(candidate.finishReason) : null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

module.exports = {
  extractText,
  openAiMessagesToGeminiContents,
  openAiBodyToAntigravity,
  geminiResponseToOpenAi,
  geminiStreamChunkToOpenAiSse,
  unwrapGeminiBody,
};
