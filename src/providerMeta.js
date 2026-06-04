/**
 * providerMeta.js — Provider catalog (API key vs OAuth modes)
 */
const PROVIDER_META = {
  openai: {
    label: "OpenAI", icon: "🤖", desc: "GPT-4, GPT-4o, o1…",
    defaultBaseUrl: "https://api.openai.com/v1",
    authModes: ["apikey"],
  },
  chatgpt: {
    label: "ChatGPT / Codex", icon: "💬", desc: "Codex CLI — login ChatGPT hoac API key",
    defaultBaseUrl: "https://api.openai.com/v1",
    authModes: ["apikey", "oauth"],
  },
  anthropic: {
    label: "Anthropic", icon: "🅰️", desc: "Claude API key",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    authModes: ["apikey"],
  },
  claude: {
    label: "Claude Code", icon: "🧠", desc: "Claude OAuth (Claude Code)",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    authModes: ["oauth"],
    oauthDriver: "anthropic",
  },
  deepseek: {
    label: "DeepSeek", icon: "🔍", desc: "DeepSeek-V3 / R1",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    authModes: ["apikey"],
  },
  groq: {
    label: "Groq", icon: "⚡", desc: "Ultra-fast inference",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    authModes: ["apikey"],
  },
  mistral: {
    label: "Mistral AI", icon: "💨", desc: "Mistral / Mixtral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    authModes: ["apikey"],
  },
  together: {
    label: "Together AI", icon: "🤝", desc: "Open-source models",
    defaultBaseUrl: "https://api.together.xyz/v1",
    authModes: ["apikey"],
  },
  cohere: {
    label: "Cohere", icon: "🪐", desc: "Command R+",
    defaultBaseUrl: "https://api.cohere.ai/v1",
    authModes: ["apikey"],
  },
  perplexity: {
    label: "Perplexity", icon: "🔮", desc: "Search-augmented AI",
    defaultBaseUrl: "https://api.perplexity.ai",
    authModes: ["apikey"],
  },
  gemini: {
    label: "Google Gemini", icon: "✨", desc: "AI Studio API key",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authModes: ["apikey"],
  },
  "gemini-cli": {
    label: "Gemini CLI", icon: "🖥️", desc: "Google account (Gemini CLI OAuth)",
    defaultBaseUrl: "https://cloudcode-pa.googleapis.com",
    authModes: ["oauth"],
    oauthDriver: "google",
  },
  antigravity: {
    label: "Antigravity", icon: "🚀", desc: "Google account (Antigravity)",
    defaultBaseUrl: "https://cloudcode-pa.googleapis.com",
    authModes: ["oauth"],
    oauthDriver: "google",
  },
  copilot: {
    label: "GitHub Copilot", icon: "🐙", desc: "GitHub OAuth",
    defaultBaseUrl: "https://api.github.com",
    authModes: ["oauth"],
    oauthDriver: "github",
  },
  cursor: {
    label: "Cursor IDE", icon: "✏️", desc: "Cursor account OAuth",
    defaultBaseUrl: "https://api2.cursor.sh",
    authModes: ["oauth"],
    oauthDriver: "cursor",
  },
};

function listProviderMeta() {
  return Object.entries(PROVIDER_META).map(([id, m]) => ({ id, ...m }));
}

function getProviderMeta(id) {
  return PROVIDER_META[id] ? { id, ...PROVIDER_META[id] } : null;
}

function defaultProviderEntries() {
  const providers = {};
  for (const [id, m] of Object.entries(PROVIDER_META)) {
    providers[id] = {
      baseUrl: m.defaultBaseUrl || "",
      keys: [],
      enabled: false,
      authMode: m.authModes.includes("apikey") ? "apikey" : "oauth",
    };
  }
  return providers;
}

module.exports = { PROVIDER_META, listProviderMeta, getProviderMeta, defaultProviderEntries };
