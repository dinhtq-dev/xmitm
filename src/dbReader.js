// Standalone reader for MITM alias mapping — reads from config.json
const { getAliases } = require("./configStore");

function getMitmAlias(toolName) {
  const all = getAliases();
  return all?.[toolName] || null;
}

module.exports = { getMitmAlias };
