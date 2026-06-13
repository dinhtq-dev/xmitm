console.log("[XMITM] Starting Admin UI Server...");
const { initConfig } = require("./src/configStore");
initConfig();
require("./src/admin-server");
