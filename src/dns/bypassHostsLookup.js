/**
 * Outbound calls from Node (quota, provider API) must reach real upstream IPs.
 * When DNS Redirection is ON, hosts maps tool domains → 127.0.0.1 for the IDE.
 */
const dns = require("dns");
const https = require("https");
const { TOOL_HOSTS } = require("../../shared/constants/mitmToolHosts.js");

const CLOUDCODE_HOSTS = new Set([
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
]);

const REDIRECTED_HOSTS = new Set(
  Object.values(TOOL_HOSTS)
    .flat()
    .map((h) => String(h).toLowerCase())
);

const PUBLIC_DNS = ["8.8.8.8", "1.1.1.1", "8.8.4.4"];
const publicResolver = new dns.Resolver();
publicResolver.setServers(PUBLIC_DNS);

function isRedirectedHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return REDIRECTED_HOSTS.has(h) || CLOUDCODE_HOSTS.has(h);
}

function isLoopback(ip) {
  if (!ip) return true;
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("127.")) return true;
  return ip === "127.0.0.1";
}

function pickUpstreamIp(addresses) {
  return (addresses || []).find((ip) => !isLoopback(ip)) || null;
}

function resolve4Public(hostname) {
  return new Promise((resolve, reject) => {
    publicResolver.resolve4(hostname, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses || []);
    });
  });
}

/** Fallback khi UDP DNS (8.8.8.8) bi firewall chan */
function resolve4DoH(hostname) {
  return new Promise((resolve, reject) => {
    const path = `/resolve?name=${encodeURIComponent(hostname)}&type=A`;
    const req = https.get(
      {
        hostname: "dns.google",
        path,
        timeout: 12000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const ips = (data.Answer || [])
              .filter((a) => a.type === 1 && a.data)
              .map((a) => a.data);
            if (!ips.length) reject(new Error("DoH: no A record"));
            else resolve(ips);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("DoH timeout"));
    });
  });
}

async function resolveAddressesBypassHosts(hostname) {
  try {
    return await resolve4Public(hostname);
  } catch (e1) {
    try {
      return await resolve4DoH(hostname);
    } catch (e2) {
      throw new Error(`${e1.message}; DoH: ${e2.message}`);
    }
  }
}

async function resolveUpstreamEndpoint(hostname) {
  const host = String(hostname || "");
  const servername = host;

  if (!isRedirectedHost(host)) {
    const ip = await dns.promises.lookup(host, { family: 4 });
    if (isLoopback(ip)) {
      throw new Error(`${host} resolve ve loopback ${ip}`);
    }
    return { host: ip, servername, port: 443 };
  }

  let addresses;
  try {
    addresses = await resolveAddressesBypassHosts(host);
  } catch (e) {
    throw new Error(
      `DNS Redirection dang bat — khong lay duoc IP that cho ${host} (${e.message})`
    );
  }

  const ip = pickUpstreamIp(addresses);
  if (!ip) {
    throw new Error(
      `DNS Redirection dang bat — ${host} chi tra ve loopback. Thu tat DNS Redirection.`
    );
  }
  return { host: ip, servername, port: 443 };
}

function bypassHostsLookup(hostname, options, callback) {
  const host = String(hostname || "");
  if (!isRedirectedHost(host)) {
    return dns.lookup(host, options, callback);
  }
  resolveAddressesBypassHosts(host)
    .then((addresses) => {
      const ip = pickUpstreamIp(addresses);
      if (!ip) return callback(new Error(`DNS redirect: ${host} -> loopback`));
      if (options?.all) return callback(null, [{ address: ip, family: 4 }]);
      callback(null, ip, 4);
    })
    .catch((err) => callback(err));
}

module.exports = {
  bypassHostsLookup,
  resolveUpstreamEndpoint,
  resolveAddressesBypassHosts,
  isRedirectedHost,
  isLoopback,
  REDIRECTED_HOSTS,
};
