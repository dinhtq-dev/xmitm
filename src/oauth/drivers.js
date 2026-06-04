const https = require("https");
const http = require("http");
const { URL } = require("url");

function postForm(urlStr, bodyObj) {
  const body = new URLSearchParams(bodyObj).toString();
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { reject(e); return; }
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        Accept: "application/json",
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(json.error_description || json.error || json.message || text || `HTTP ${res.statusCode}`));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("OAuth token request timeout")); });
    req.write(body);
    req.end();
  });
}

function getJson(urlStr, headers) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { headers: headers || {}, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json.message || `HTTP ${res.statusCode}`));
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function exchangeGoogle({ clientId, clientSecret, code, redirectUri }) {
  const token = await postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  let email = null;
  try {
    const info = await getJson("https://www.googleapis.com/oauth2/v2/userinfo", {
      Authorization: `Bearer ${token.access_token}`,
    });
    email = info.email || null;
  } catch { /* optional */ }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    expiresIn: token.expires_in,
    email,
    label: email || "Google account",
    extra: { scope: token.scope || null },
  };
}

async function refreshGoogle({ clientId, clientSecret, refreshToken }) {
  const token = await postForm("https://oauth2.googleapis.com/token", {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refreshToken,
    expiresIn: token.expires_in,
  };
}

async function exchangeGithub({ clientId, clientSecret, code, redirectUri }) {
  const token = await postForm("https://github.com/login/oauth/access_token", {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const accessToken = token.access_token;
  let email = null;
  let login = null;
  try {
    const user = await getJson("https://api.github.com/user", {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "xmitm-oauth",
    });
    login = user.login || null;
    email = user.email || null;
    if (!email) {
      const emails = await getJson("https://api.github.com/user/emails", {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "xmitm-oauth",
      });
      const primary = Array.isArray(emails) ? emails.find((e) => e.primary) : null;
      email = primary?.email || (Array.isArray(emails) && emails[0]?.email) || null;
    }
  } catch { /* optional */ }
  return {
    accessToken,
    refreshToken: "",
    expiresIn: null,
    email,
    label: login || email || "GitHub account",
    extra: { login },
  };
}

module.exports = {
  exchangeGoogle,
  refreshGoogle,
  exchangeGithub,
};
