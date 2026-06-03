const fs = require('fs');
const p = 'D:/source/xmitm/src/providerQuota.js';
let s = fs.readFileSync(p, 'utf8');
function addPercent(label) {
  return s => {
    if (!s.includes('percent:')) {
      s = s.replace(label, label.replace('ok: true', 'ok: true, percent: 100'));
    }
    return s;
  };
}
const fixes = [
  ['return { ok: true, status: "ok", label: "Key OK", source: "probe" };', 'return { ok: true, status: "ok", percent: 100, label: "Key OK", source: "probe" };'],
  ['return { ok: true, status: "ok", label: "Key OK (quota: AI Studio)", source: "gemini" };', 'return { ok: true, status: "ok", percent: 100, label: "Key OK (quota: AI Studio)", source: "gemini" };'],
];
for (const [a,b] of fixes) {
  if (s.includes(a)) s = s.replace(a, b);
}
// add percent calc helper at end of checkProviderQuota before cache
if (!s.includes('function withPercent')) {
  s = s.replace(
    '  cache.set(cacheKey, { at: Date.now(), data: result });',
    `  if (result.ok && result.percent == null) {
    if (result.remaining != null && result.limit != null && Number(result.limit) > 0) {
      result.percent = Math.min(100, Math.round((Number(result.remaining) / Number(result.limit)) * 100));
    } else {
      result.percent = 100;
    }
  }
  cache.set(cacheKey, { at: Date.now(), data: result });`
  );
}
fs.writeFileSync(p, s);
console.log('quota js ok');
