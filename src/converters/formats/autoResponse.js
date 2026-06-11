/**
 * Auto-detect response format và convert về format client đích.
 * Không cần biết provider/model — chỉ cần biết convert cho ai (codex/claude).
 */
const crypto = require("crypto");
const { detectResponseFormat, CLIENT_NATIVE } = require("../detectFormat");
const { geminiResponseToOpenAi } = require("./openai-gemini");

const CANONICAL = {
  openai: "openai",
  "openai-sse": "openai",
  "openai-responses": "openai",
  gemini: "gemini",
  anthropic: "anthropic",
  codewhisperer: "codewhisperer",
  "codewhisperer-stream": "codewhisperer",
};

function normalizeFormat(fmt) {
  return CANONICAL[fmt] || fmt;
}

function targetFormatForClient(clientTool) {
  return normalizeFormat(CLIENT_NATIVE[clientTool] || "openai");
}

function anthropicToOpenAi(body, modelName) {
  const blocks = Array.isArray(body?.content) ? body.content : [];
  const text = blocks
    .filter((b) => b && (b.type === "text" || b.text))
    .map((b) => b.text || "")
    .filter(Boolean)
    .join("");
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName || body?.model || "claude",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: body?.stop_reason === "end_turn" ? "stop" : (body?.stop_reason || "stop"),
      },
    ],
    usage: {
      prompt_tokens: body?.usage?.input_tokens || 0,
      completion_tokens: body?.usage?.output_tokens || 0,
      total_tokens: (body?.usage?.input_tokens || 0) + (body?.usage?.output_tokens || 0),
    },
  };
}

function openAiToAnthropic(body) {
  const choice = body?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  return {
    type: "message",
    id: `msg_${crypto.randomBytes(12).toString("hex")}`,
    role: "assistant",
    content: [{ type: "text", text }],
    model: body?.model || "assistant",
    stop_reason: "end_turn",
    usage: {
      input_tokens: body?.usage?.prompt_tokens || 0,
      output_tokens: body?.usage?.completion_tokens || 0,
    },
  };
}

/**
 * @returns {{ body, converted: boolean, sourceFormat: string, targetFormat: string, reason?: string }}
 */
function autoConvertResponse(body, clientTool, opts = {}) {
  const targetFormat = normalizeFormat(opts.targetFormat || targetFormatForClient(clientTool));
  const detected = detectResponseFormat({
    body,
    contentType: opts.contentType || "",
    clientTool: null,
  });
  const sourceFormat = normalizeFormat(detected.format);

  if (!body || sourceFormat === "unknown") {
    return { body, converted: false, sourceFormat, targetFormat, reason: "unknown_source" };
  }
  if (sourceFormat === targetFormat) {
    return { body, converted: false, sourceFormat, targetFormat, reason: "already_match" };
  }

  const model = opts.model || body?.model;
  let out = body;

  if (sourceFormat === "gemini" && targetFormat === "openai") {
    out = geminiResponseToOpenAi(body, model);
  } else if (sourceFormat === "anthropic" && targetFormat === "openai") {
    out = anthropicToOpenAi(body, model);
  } else if (sourceFormat === "openai" && targetFormat === "anthropic") {
    out = openAiToAnthropic(body);
  } else if (sourceFormat === "gemini" && targetFormat === "anthropic") {
    out = openAiToAnthropic(geminiResponseToOpenAi(body, model));
  } else {
    return { body, converted: false, sourceFormat, targetFormat, reason: `unsupported:${sourceFormat}->${targetFormat}` };
  }

  return { body: out, converted: true, sourceFormat, targetFormat };
}

module.exports = {
  autoConvertResponse,
  targetFormatForClient,
  anthropicToOpenAi,
  openAiToAnthropic,
};
