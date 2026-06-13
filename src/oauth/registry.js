/**
 * oauth/registry.js — OAuth driver config per provider (standalone, no 9router)
 */
const { getProviderMeta } = require("../providerMeta");
const { getOAuthAppCredentials } = require("../configStore");

const DRIVERS = {
  google: {
    id: "google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    envClientId: "OAUTH_GOOGLE_CLIENT_ID",
    envClientSecret: "OAUTH_GOOGLE_CLIENT_SECRET",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/cloud-platform",
    ],
  },
  github: {
    id: "github",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    envClientId: "OAUTH_GITHUB_CLIENT_ID",
    envClientSecret: "OAUTH_GITHUB_CLIENT_SECRET",
    defaultScopes: ["read:user", "user:email"],
  },
  anthropic: {
    id: "anthropic",
    authUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://claude.ai/oauth/token",
    envClientId: "OAUTH_ANTHROPIC_CLIENT_ID",
    envClientSecret: "OAUTH_ANTHROPIC_CLIENT_SECRET",
    defaultScopes: ["org:create", "user:profile", "user:inference"],
  },
  cursor: {
    id: "cursor",
    authUrl: null,
    tokenUrl: null,
    envClientId: "OAUTH_CURSOR_CLIENT_ID",
    envClientSecret: "OAUTH_CURSOR_CLIENT_SECRET",
    defaultScopes: [],
    disabled: true,
    disabledReason: "Cursor OAuth chua ho tro — can implement rieng",
  },
};

/** Tạm thời chỉ gemini-cli — các provider OAuth khác đã comment */
const PROVIDER_OAUTH = {
  // antigravity: { driver: "google", scopes: DRIVERS.google.defaultScopes },
  "gemini-cli": { driver: "google", scopes: DRIVERS.google.defaultScopes },
  // copilot: { driver: "github", scopes: ["read:user", "user:email"] },
  // claude: { driver: "anthropic", scopes: DRIVERS.anthropic.defaultScopes },
  // cursor: { driver: "cursor", scopes: [] },
  // chatgpt: { driver: "local", scopes: [] },
  // opencode: { driver: "local", scopes: [] },
};

function getOAuthConfig(providerId) {
  const meta = getProviderMeta(providerId);
  if (!meta?.authModes?.includes("oauth")) return null;
  const cfg = PROVIDER_OAUTH[providerId];
  if (!cfg) return null;
  const driver = DRIVERS[cfg.driver];
  if (!driver) return null;
  return {
    providerId,
    driver: driver.id,
    scopes: cfg.scopes || driver.defaultScopes || [],
    driverConfig: driver,
  };
}

function getDriverCredentials(driverId) {
  const driver = DRIVERS[driverId];
  if (!driver) return { ok: false, error: "Unknown OAuth driver" };
  if (driver.disabled) return { ok: false, error: driver.disabledReason || "OAuth driver disabled" };
  const creds = getOAuthAppCredentials(driverId);
  if (!creds.ok) return creds;
  return { ok: true, clientId: creds.clientId, clientSecret: creds.clientSecret, driver };
}

function listOAuthProvidersPublic() {
  const localProviders = new Set(["cursor", "chatgpt", "opencode"]);
  return Object.keys(PROVIDER_OAUTH).map((pid) => {
    if (localProviders.has(pid)) {
      return {
        providerId: pid,
        driver: "local",
        loginMode: "local",
        configured: true,
        configError: null,
        disabled: false,
      };
    }
    const cfg = getOAuthConfig(pid);
    const creds = cfg ? getDriverCredentials(cfg.driver) : { ok: false };
    return {
      providerId: pid,
      driver: cfg?.driver,
      loginMode: "oauth",
      configured: creds.ok,
      configError: creds.ok ? null : creds.error,
      disabled: cfg?.driverConfig?.disabled === true,
    };
  });
}

module.exports = {
  DRIVERS,
  getOAuthConfig,
  getDriverCredentials,
  listOAuthProvidersPublic,
};
