const fs = require('fs');
const p = 'D:/source/xmitm/src/admin.html';
let h = fs.readFileSync(p, 'utf8');
const needle = 'let serverProviders = { activeProvider: null, providers: {} };';
const ins = `let serverProviders = { activeProvider: null, providers: {} };
    let providerQuota = {};
    function formatKeyQuota(pid, idx) {
      const pq = providerQuota[pid];
      if (!pq || !pq.keys || !pq.keys[idx]) return '';
      const q = pq.keys[idx];
      return '<div class="mt-1 text-[9px] font-mono ' + (q.ok ? 'text-emerald-400' : 'text-slate-500') + '">' + (q.label || '...') + (q.source === '9router' ? ' (9router)' : '') + '</div>';
    }
    async function loadProviderQuotas(refresh) {
      try {
        const res = await fetch('/api/admin/providers/quota' + (refresh ? '?refresh=1' : ''));
        const data = await res.json();
        if (data.quota) providerQuota = data.quota;
      } catch (e) {}
      renderProviders();
    }`;
if (!h.includes(needle)) { console.error('needle'); process.exit(1); }
h = h.replace(needle, ins);
h = h.replace(/renderProviders\(\);\r?\n    \}\r?\n\r?\n    \/\/ .{2} Save to server/, 'renderProviders();\n      loadProviderQuotas(false);\n    }\n\n    // -- Save to server');
h = h.split('bg-black/30 rounded-lg px-3 py-1.5').join('bg-emerald-500/12 border border-emerald-500/30 rounded-lg px-3 py-2');
h = h.split('text-slate-400 truncate flex-1 mr-2').join('text-emerald-300 truncate flex-1 mr-2');
if (!h.includes('btn-refresh-quota')) {
  h = h.replace('<div id="providers-list"', '<button type="button" id="btn-refresh-quota" onclick="loadProviderQuotas(true)" class="mb-3 px-3 py-1.5 text-[10px] font-bold rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 cursor-pointer">Refresh quota</button>\n          <div id="providers-list"');
}
if (!h.includes('formatKeyQuota(p.id')) {
  h = h.replace('                <button onclick="removeProviderKey', '                ${formatKeyQuota(p.id, i)}\n                <button onclick="removeProviderKey');
}
if (!h.includes('await loadProviderQuotas(true)')) {
  h = h.replace('closeAddKeyModal();\n      showToast', 'closeAddKeyModal();\n      await loadProviderQuotas(true);\n      showToast');
}
fs.writeFileSync(p, h);
console.log('patched');