const fs = require('fs');
const p = 'D:/source/xmitm/src/admin.html';
let h = fs.readFileSync(p, 'utf8');
const oldFn = `    function formatKeyQuota(pid, idx) {
      const pq = providerQuota[pid];
      if (!pq || !pq.keys || !pq.keys[idx]) return '';
      const q = pq.keys[idx];
      return '<div class="mt-1 text-[9px] font-mono ' + (q.ok ? 'text-emerald-400' : 'text-slate-500') + '">' + (q.label || '...') + (q.source === '9router' ? ' (9router)' : '') + '</div>';
    }`;
const newFn = `    function quotaPercent(q) {
      if (!q || !q.ok) return 0;
      if (q.percent != null && !isNaN(q.percent)) return Math.min(100, Math.max(0, Number(q.percent)));
      if (q.remaining != null && q.limit != null && Number(q.limit) > 0) {
        return Math.min(100, Math.round((Number(q.remaining) / Number(q.limit)) * 100));
      }
      return 100;
    }
    function quotaBarColor(q, pct) {
      if (!q || !q.ok || q.status === 'invalid_key') return 'bg-rose-500';
      if (pct >= 50) return 'bg-emerald-500';
      if (pct >= 20) return 'bg-amber-500';
      return 'bg-rose-500';
    }
    function formatKeyQuota(pid, idx) {
      const pq = providerQuota[pid];
      if (!pq || !pq.keys || !pq.keys[idx]) return '';
      const q = pq.keys[idx];
      const pct = quotaPercent(q);
      const bar = quotaBarColor(q, pct);
      const label = q.label || (q.ok ? 'Key OK' : '—');
      const src = q.source === '9router' ? ' · 9router' : '';
      const pctText = q.ok ? (pct + '%') : '';
      return '<div class="mt-2 space-y-1">'
        + '<div class="h-1.5 w-full rounded-full bg-slate-800/80 overflow-hidden">'
        + '<div class="h-full rounded-full transition-all duration-300 ' + bar + '" style="width:' + pct + '%"></div>'
        + '</div>'
        + '<div class="flex items-center justify-between gap-2">'
        + '<span class="text-[9px] font-mono ' + (q.ok ? 'text-emerald-400' : 'text-slate-500') + '">' + label + src + '</span>'
        + (pctText ? '<span class="text-[9px] font-bold font-mono text-emerald-300">' + pctText + '</span>' : '')
        + '</div></div>';
    }`;
if (!h.includes(oldFn.trim().slice(0, 40))) {
  console.error('old fn not found');
  process.exit(1);
}
h = h.replace(oldFn, newFn);
fs.writeFileSync(p, h);
console.log('ok');
