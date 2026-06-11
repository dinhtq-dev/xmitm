// Standalone reader for MITM alias mapping.
const fs = require("fs");
const path = require("path");

// Read from aliases.json at the root of mitm-server
const CACHE_FILE = path.join(__dirname, "..", "aliases.json");

// Ensure default aliases.json exists
if (!fs.existsSync(CACHE_FILE)) {
  const defaultAliases = {
    cli: {},
    antigravity: {
      "gemini-default": "gemini-3-flash"
    },
    copilot: {},
    kiro: {},
    cursor: {}
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(defaultAliases, null, 2), "utf8");
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch { return null; }
}

function getMitmAlias(toolName) {
  const all = readCache();
  return all?.[toolName] || null;
}

module.exports = { getMitmAlias };
