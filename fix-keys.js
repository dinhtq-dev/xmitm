const fs = require("fs");
const p = "D:/source/xmitm/src/admin.html";
const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
let start = lines.findIndex(l => l.trim().startsWith("${keys.map((k, i) =>"));
if (start < 0) { console.error("no start"); process.exit(1); }
let end = start;
while (end < lines.length && !lines[end].trim().startsWith("}).join('')}")) end++;
const insert = [
  "            ${keys.map((k, i) => {",
  "              const q = providerQuota[p.id]?.keys?.[i];",
  "              const keyOk = q && q.ok;",
  "              const rowBg = keyOk",
  "                ? 'bg-emerald-500/25 border-2 border-emerald-400/50 shadow-sm shadow-emerald-500/10'",
  "                : (q && !q.ok ? 'bg-rose-500/15 border border-rose-500/40' : 'bg-emerald-500/18 border-2 border-emerald-500/35');",
  "              return `",
  "              <div class=\"rounded-lg px-3 py-2.5 ${rowBg}\">",
  "                <div class=\"flex items-center justify-between gap-2 mb-1\">",
  "                  <span class=\"text-[11px] font-mono font-semibold text-emerald-200 truncate flex-1\">${i === 0 ? '\u25b6 ' : ''}${k.length > 18 ? k.slice(0, 12) + '\u2026' + k.slice(-6) : k}</span>",
  "                  <button type=\"button\" onclick=\"event.stopPropagation(); removeProviderKey('${p.id}', ${i})\" class=\"text-rose-400 hover:text-rose-300 text-xs shrink-0 cursor-pointer px-1\">\u2716</button>",
  "                </div>",
  "                ${formatKeyQuota(p.id, i)}",
  "              </div>`;",
  "            }).join('')}"
];
lines.splice(start, end - start + 1, ...insert);
fs.writeFileSync(p, lines.join("\n"));
console.log("ok", start, end);