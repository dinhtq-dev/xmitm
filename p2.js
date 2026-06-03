const fs = require('fs');
const p = 'D:/source/xmitm/src/admin.html';
let h = fs.readFileSync(p, 'utf8');
const old = `              <div class="flex items-center justify-between bg-emerald-500/12 border border-emerald-500/30 rounded-lg px-3 py-2">
                <span class="text-[11px] font-mono text-emerald-300 truncate flex-1 mr-2 ${'${'}i === 0 ? 'text-indigo-300' : ''}${'}'}">${'${'}i === 0 ? '▶ ' : ''}${'${'}k.length > 18 ? k.slice(0, 12) + '…' + k.slice(-6) : k}</span>
                ${'${'}formatKeyQuota(p.id, i)}
                <button onclick="removeProviderKey('${'${'}p.id}', ${'${'}i})" class="text-rose-500 hover:text-rose-400 text-xs shrink-0 cursor-pointer">✖</button>
              </div>`;
const neu = `              <div class="bg-emerald-500/12 border border-emerald-500/30 rounded-lg px-3 py-2 ${'${'}i === 0 ? 'ring-1 ring-emerald-500/40' : ''}">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-mono text-emerald-300 truncate flex-1 mr-2">${'${'}i === 0 ? '▶ ' : ''}${'${'}k.length > 18 ? k.slice(0, 12) + '…' + k.slice(-6) : k}</span>
                  <button type="button" onclick="event.stopPropagation(); removeProviderKey('${'${'}p.id}', ${'${'}i})" class="text-rose-500 hover:text-rose-400 text-xs shrink-0 cursor-pointer">✖</button>
                </div>
                ${'${'}formatKeyQuota(p.id, i)}
              </div>`;
if (h.includes('flex items-center justify-between bg-emerald-500/12')) {
  h = h.replace(old, neu);
  fs.writeFileSync(p, h);
  console.log('layout ok');
} else console.log('skip layout');
