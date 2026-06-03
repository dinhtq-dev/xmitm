const fs = require('fs');
const htmlPath = 'D:/source/xmitm/src/admin.html';
const quotaPath = 'D:/source/xmitm/src/providerQuota.js';
let h = fs.readFileSync(htmlPath, 'utf8');

// 1) Add loading state + poll after providerQuota = {}
h = h.replace(
  'let providerQuota = {};',
  `let providerQuota = {};
    let providerQuotaLoading = false;
    let providerQuotaUpdatedAt = null;
    let providerQuotaTimer = null;

    function startProviderQuotaPoll() {
      stopProviderQuotaPoll();
      loadProviderQuotas(true);
      providerQuotaTimer = setInterval(() => loadProviderQuotas(true), 60000);
    }
    function stopProviderQuotaPoll() {
      if (providerQuotaTimer) { clearInterval(providerQuotaTimer); providerQuotaTimer = null; }
    }`
);

// 2) Improve formatKeyQuota - always show bar
const oldFmt = `    function formatKeyQuota(pid, idx) {
      const pq = providerQuota[pid];
      if (!pq || !pq.keys || !pq.keys[idx]) return '';
      const q = pq.keys[idx];`;
const newFmt = `    function formatKeyQuota(pid, idx) {
      const pq = providerQuota[pid];
      const q = pq && pq.keys && pq.keys[idx] ? pq.keys[idx] : null;
      if (!q && providerQuotaLoading) {
        return '<div class="mt-2 space-y-1"><div class="h-2 w-full rounded-full bg-slate-800 overflow-hidden"><div class="h-full w-1/3 rounded-full bg-slate-600 animate-pulse"></div></div><span class="text-[9px] font-mono text-slate-500">Dang kiem tra key...</span></div>';
      }
      if (!q) {
        return '<div class="mt-2 space-y-1"><div class="h-2 w-full rounded-full bg-slate-800 overflow-hidden"><div class="h-full w-full rounded-full bg-emerald-500/50"></div></div><span class="text-[9px] font-mono text-emerald-400/80">Chua co du lieu quota - bam Refresh</span></div>';
      }`;
if (!h.includes(oldFmt)) { console.error('fmt not found'); process.exit(1); }
h = h.replace(oldFmt, newFmt);

// 3) loadProviderQuotas with loading + timestamp
h = h.replace(
  `    async function loadProviderQuotas(refresh) {
      try {
        const res = await fetch('/api/admin/providers/quota' + (refresh ? '?refresh=1' : ''));
        const data = await res.json();
        if (data.quota) providerQuota = data.quota;
      } catch (e) {}
      renderProviders();
    }`,
  `    async function loadProviderQuotas(refresh) {
      providerQuotaLoading = true;
      renderProviders();
      try {
        const res = await fetch('/api/admin/providers/quota' + (refresh ? '?refresh=1' : ''));
        const data = await res.json();
        if (data.quota) providerQuota = data.quota;
        providerQuotaUpdatedAt = new Date();
      } catch (e) {
        showToast('Khong tai duoc quota', 'error');
      }
      providerQuotaLoading = false;
      renderProviders();
    }`
);

// 4) Fix key row layout - column + strong green
const oldKeys = `            \${keys.map((k, i) => \`
              <div class="flex items-center justify-between bg-emerald-500/12 border border-emerald-500/30 rounded-lg px-3 py-2">
                <span class="text-[11px] font-mono text-emerald-300 truncate flex-1 mr-2 \${i === 0 ? 'text-indigo-300' : ''}">\${i === 0 ? '▶ ' : ''}\${k.length > 18 ? k.slice(0, 12) + '…' + k.slice(-6) : k}</span>
                \${formatKeyQuota(p.id, i)}
                <button onclick="removeProviderKey('\${p.id}', \${i})" class="text-rose-500 hover:text-rose-400 text-xs shrink-0 cursor-pointer">✖</button>
              </div>\`).join('')}`;

const newKeys = `            \${keys.map((k, i) => {
              const q = providerQuota[p.id]?.keys?.[i];
              const keyOk = q && q.ok;
              const rowBg = keyOk
                ? 'bg-emerald-500/25 border-2 border-emerald-400/50 shadow-sm shadow-emerald-500/10'
                : (q && !q.ok ? 'bg-rose-500/15 border border-rose-500/40' : 'bg-emerald-500/18 border-2 border-emerald-500/35');
              return \\\`
              <div class="rounded-lg px-3 py-2.5 \\\${rowBg}">
                <div class="flex items-center justify-between gap-2 mb-1">
                  <span class="text-[11px] font-mono font-semibold text-emerald-200 truncate flex-1">\\\${i === 0 ? '▶ ' : ''}\\\${k.length > 18 ? k.slice(0, 12) + '…' + k.slice(-6) : k}</span>
                  <button type="button" onclick="event.stopPropagation(); removeProviderKey('\\\${p.id}', \\\${i})" class="text-rose-400 hover:text-rose-300 text-xs shrink-0 cursor-pointer px-1">✖</button>
                </div>
                \\\${formatKeyQuota(p.id, i)}
              </div>\\\`;
            }).join('')}`;

if (h.includes('flex items-center justify-between bg-emerald-500/12')) {
  h = h.replace(
    /\$\{keys\.map\(\(k, i\) => `[\s\S]*?\)\.join\(''\)\}/,
    newKeys.replace(/\\\$/g, '${')
  );
} else {
  console.error('keys block not found');
  process.exit(1);
}

// 5) Refresh button label + last updated
h = h.replace(
  'Refresh quota</button>',
  'Refresh quota</button><span id="quota-last-updated" class="text-[9px] text-slate-600 font-mono ml-2"></span>'
);

// 6) Update timestamp in loadProviderQuotas render
h = h.replace(
  'providerQuotaLoading = false;\n      renderProviders();',
  `providerQuotaLoading = false;
      const el = document.getElementById('quota-last-updated');
      if (el && providerQuotaUpdatedAt) el.textContent = 'Cap nhat: ' + providerQuotaUpdatedAt.toLocaleTimeString('vi-VN');
      renderProviders();`
);

// 7) switchTab - start/stop poll
if (!h.includes('startProviderQuotaPoll')) {
  h = h.replace(
    "function switchTab(tab) {",
    "function switchTab(tab) {\n      if (tab === 'providers') startProviderQuotaPoll(); else stopProviderQuotaPoll();"
  );
}

// 8) init
h = h.replace(
  '    loadProviders();',
  '    loadProviders();\n    startProviderQuotaPoll();'
);

fs.writeFileSync(htmlPath, h);

// providerQuota.js - AIza gemini + better labels
let q = fs.readFileSync(quotaPath, 'utf8');
q = q.replace(
  '  if (!result && providerId === "gemini") result = await probeGemini(key);',
  '  if (!result && (providerId === "gemini" || (key && key.startsWith("AIza")))) result = await probeGemini(key);'
);
q = q.replace(
  'if (res.ok) return { ok: true, status: "ok", percent: 100, label: "Key OK (quota: AI Studio)", source: "gemini" };',
  'if (res.ok) return { ok: true, status: "ok", percent: 100, label: "Key hop le - quota xem Google AI Studio", source: "gemini" };'
);
q = q.replace(
  'return { ok: true, status: "ok", label: "So du: " + u.total_balance + " " + (u.currency || "USD"), source: "deepseek" };',
  'return { ok: true, status: "ok", percent: 100, label: "So du: " + u.total_balance + " " + (u.currency || "USD"), source: "deepseek" };'
);
fs.writeFileSync(quotaPath, q);

console.log('patched html + quota');
