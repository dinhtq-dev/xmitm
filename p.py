import re, pathlib
p = pathlib.Path(r'D:/source/xmitm/src/admin.html')
h = p.read_text(encoding='utf-8')
needle = 'let serverProviders = { activeProvider: null, providers: {} };'
ins = '''let serverProviders = { activeProvider: null, providers: {} };
    let providerQuota = {};
    function formatKeyQuota(pid, idx) {
      const pq = providerQuota[pid];
      if (!pq || !pq.keys || !pq.keys[idx]) return '';
      const q = pq.keys[idx];
      return '<div class="mt-1 text-[9px] font-mono ' + (q.ok ? 'text-emerald-400' : 'text-slate-500') + '">' + (q.label || '...') + '</div>';
    }
    async function loadProviderQuotas(refresh) {
      try {
        const res = await fetch('/api/admin/providers/quota' + (refresh ? '?refresh=1' : ''));
        const data = await res.json();
        if (data.quota) providerQuota = data.quota;
      } catch (e) {}
      renderProviders();
    }'''
assert needle in h
h = h.replace(needle, ins)
h = re.sub(r'renderProviders\(\);\s*\}\s*\n\s*// .{1,8} Save to server', 'renderProviders();\n      loadProviderQuotas(false);\n    }\n\n    // -- Save to server', h, count=1)
h = h.replace('bg-black/30 rounded-lg px-3 py-1.5', 'bg-emerald-500/12 border border-emerald-500/30 rounded-lg px-3 py-2')
h = h.replace('text-slate-400 truncate flex-1 mr-2', 'text-emerald-300 truncate flex-1 mr-2')
if 'btn-refresh-quota' not in h:
    h = h.replace('<div id="providers-list"', '<button type="button" id="btn-refresh-quota" onclick="loadProviderQuotas(true)" class="mb-3 px-3 py-1.5 text-[10px] font-bold rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 cursor-pointer">Refresh quota</button>\n          <div id="providers-list"')
marker = 'removeProviderKey'
if 'formatKeyQuota(p.id' not in h:
    h = h.replace('                <button onclick="' + marker, '                PLACEHOLDER\n                <button onclick="' + marker, 1)
    h = h.replace('PLACEHOLDER', "")
if 'await loadProviderQuotas(true)' not in h:
    h = h.replace('closeAddKeyModal();\n      showToast', 'closeAddKeyModal();\n      await loadProviderQuotas(true);\n      showToast', 1)
p.write_text(h, encoding='utf-8')
print('patched')