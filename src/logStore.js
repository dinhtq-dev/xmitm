/**
 * logStore.js — shared ring buffer for request/response logs.
 *
 * Both server.js (MITM proxy) and admin-server.js (Admin UI) import this.
 * The MITM proxy writes logs to a JSON file; the admin server reads them on demand.
 *
 * Trade-off: file-based IPC is simple and survives crashes.
 * MAX_LOGS caps at 50 in the file, UI only shows the 20 most recent.
 */
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const LOG_FILE = path.join(DATA_DIR, "request-log.json");
const MAX_LOGS = 50; // keep 50 in the file, UI shows 20

// In-memory ring buffer (used by server.js)
let buffer = [];

function init() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = fs.readFileSync(LOG_FILE, "utf-8");
      buffer = JSON.parse(data);
      if (!Array.isArray(buffer)) buffer = [];
    }
  } catch {
    buffer = [];
  }
}

/**
 * Add a log entry.
 * @param {object} entry - { method, url, host, tool, model, mappedModel, upstreamModel, promptTokens, completionTokens, totalTokens, action, requestBody, responseStatus, responseBody, duration }
 */
function addLog(entry) {
  const logEntry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  buffer.push(logEntry);
  if (buffer.length > MAX_LOGS) {
    buffer = buffer.slice(buffer.length - MAX_LOGS);
  }
  // Persist to file (async but fire-and-forget)
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(buffer, null, 2));
  } catch {
    /* ignore */
  }
  return logEntry;
}

/**
 * Get all logs (returns latest first, capped at 20 for UI).
 * Reads from file on each call so admin server picks up logs
 * written by the MITM proxy process.
 */
function getLogs() {
  // Reload from file to pick up logs written by MITM proxy process
  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = fs.readFileSync(LOG_FILE, "utf-8");
      buffer = JSON.parse(data);
      if (!Array.isArray(buffer)) buffer = [];
    }
  } catch {
    buffer = [];
  }
  return buffer.slice().reverse().slice(0, 20);
}

function clearLogs() {
  buffer = [];
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify([]));
  } catch {
    /* ignore */
  }
}

module.exports = { init, addLog, getLogs, clearLogs, LOG_FILE };
