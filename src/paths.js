const fs = require("fs");
const path = require("path");

// Keep all data inside the local directory of mitm-server
const DATA_DIR = path.join(__dirname, "..", "data");
const MITM_DIR = path.join(DATA_DIR, "mitm");

try {
  fs.mkdirSync(MITM_DIR, { recursive: true });
} catch (e) {}

module.exports = { DATA_DIR, MITM_DIR };
