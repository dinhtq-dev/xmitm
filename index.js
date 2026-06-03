const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, ".env") });

console.log("[XMITM] Starting Admin UI Server...");
require("./src/admin-server");
