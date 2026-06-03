const fs = require("fs");
const p = "D:/source/xmitm/src/admin.html";
let h = fs.readFileSync(p, "utf8");
h = h.replace(
  `    async function loadProviderQuotas(refresh) {
      providerQuotaLoading = true;
      renderProviders();
      try {
        const res = await fetch('/api/admin/providers/quota' + (refresh ? '?refresh=1' : ''));
        const data = await res.json();
        if (data.quota) providerQuota = data.quota;
        providerQuotaUpdatedAt = new Date();
      } catch (e) { /* silent */ }
      providerQuotaLoading = false;
      renderProviders();
    }`,
  `    async function loadProviderQuotas(refresh) {
      const onProvidersTab = currentTab === 'providers';
      if (onProvidersTab) { providerQuotaLoading = true; renderProviders(); }
      try {
        const res = await fetch('/api/admin/providers/quota' + (refresh ? '?refresh=1' : ''));
        const data = await res.json();
        if (data.quota) providerQuota = data.quota;
        providerQuotaUpdatedAt = new Date();
      } catch (e) { /* silent */ }
      providerQuotaLoading = false;
      if (onProvidersTab) renderProviders();
    }`
);
// Unify loading text
h = h.replace(/Dang kiem tra key\.\.\./g, "Dang kiem tra...");
fs.writeFileSync(p, h);
console.log("ok2");