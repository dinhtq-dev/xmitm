/**
 * cursorLocal.js — Import Cursor session from local IDE storage (no web OAuth)
 */
const crypto = require("crypto");
const { getCredentials } = require("../credentials");
const { upsertOAuthConnection, listOAuthConnections } = require("../authStore");

function importCursorFromLocal() {
  const creds = getCredentials("cursor");
  if (creds?.error) throw new Error(creds.error);
  if (!creds?.accessToken) {
    throw new Error(
      "Khong tim thay token Cursor. Mo Cursor IDE, dang nhap tai khoan, roi thu lai."
    );
  }

  const email = creds.extra?.email || null;
  const existing = listOAuthConnections("cursor").find(
    (c) => (email && c.email === email) || c.driver === "local"
  );

  return upsertOAuthConnection({
    id: existing?.id || crypto.randomUUID(),
    provider: "cursor",
    driver: "local",
    email,
    label: email || "Cursor (local)",
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken || "",
    expiresAt: null,
    extra: {
      machineId: creds.machineId || null,
      membershipType: creds.extra?.membershipType || null,
      subscriptionStatus: creds.extra?.subscriptionStatus || null,
      importedFrom: "local-ide",
    },
  });
}

module.exports = { importCursorFromLocal };
