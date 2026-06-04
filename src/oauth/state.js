const crypto = require("crypto");

const pending = new Map();
const TTL_MS = 10 * 60 * 1000;

function createState(providerId) {
  const state = crypto.randomBytes(24).toString("hex");
  pending.set(state, { providerId, at: Date.now() });
  return state;
}

function consumeState(state) {
  const row = pending.get(state);
  pending.delete(state);
  if (!row) return null;
  if (Date.now() - row.at > TTL_MS) return null;
  return row;
}

function cleanupStates() {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    if (now - v.at > TTL_MS) pending.delete(k);
  }
}

setInterval(cleanupStates, 60000).unref?.();

module.exports = { createState, consumeState };
