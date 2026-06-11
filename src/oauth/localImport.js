/**
 * localImport.js — Import OAuth/session from local apps (Cursor, Codex, …)
 */
const { importCursorFromLocal } = require("./cursorLocal");
const { importChatGPTFromLocal } = require("./chatgptLocal");
const { importOpenCodeFromLocal } = require("./opencodeLocal");

const LOCAL_IMPORTERS = {
  cursor: importCursorFromLocal,
  chatgpt: importChatGPTFromLocal,
  opencode: importOpenCodeFromLocal,
};

function importLocalOAuth(providerId) {
  const fn = LOCAL_IMPORTERS[providerId];
  if (!fn) throw new Error(`Provider "${providerId}" khong ho tro login tu app local`);
  const result = fn();
  if (providerId === "cursor") {
    return {
      kind: "oauth",
      providerId: "cursor",
      connectionId: result.id,
      label: result.label,
      email: result.email,
    };
  }
  return result;
}

function listLocalLoginProviders() {
  return Object.keys(LOCAL_IMPORTERS);
}

module.exports = { importLocalOAuth, listLocalLoginProviders };
