const fs=require("fs");
const path=require("path");
const p=path.join(__dirname,"..","src","admin.html");
let h=fs.readFileSync(p,"utf8");
const a=`    let serverProviders = { activeProvider: null, providers: {} };

    //`;
const b=`    let serverProviders = { activeProvider: null, providers: {} };
    let providerQuota = {};
    function quotaBarClass(q){if(!q||!q.ok)return"bg-slate-700";if(q.status==="invalid_key")return"bg-rose-500";return"bg-emerald-500";}
    function formatKeyQuota(pid,idx){const pq=providerQuota[pid];if(!pq||!pq.keys||!pq.keys[idx])return"";const q=pq.keys[idx];const label=q.label||(q.ok?"Key OK":"-");return'<div class="mt-1 text-[9px] font-mono '+(q.ok?"text-emerald-400":"text-slate-500")+'">'+label+(q.source==="9router"?" (9router)":"")+"</div>";}
    async function loadProviderQuotas(refresh){try{const res=await fetch("/api/admin/providers/quota"+(refresh?"?refresh=1":""));const data=await res.json();if(data.quota)providerQuota=data.quota;}catch(e){}renderProviders();}
    //`;
if(!h.includes(a)){console.error("A missing");process.exit(1);}
h=h.replace(a,b);
h=h.replace("renderProviders();\n    }\n\n    // ── Save to server","renderProviders();\n      loadProviderQuotas(false);\n    }\n\n    // ── Save to server");
const old=`              <div class="flex items-center justify-between bg-black/30 rounded-lg px-3 py-1.5">
                <span class="text-[11px] font-mono text-slate-400 truncate flex-1 mr-2`;
if(h.includes(old)){
  h=h.replace(old,`              <div class="rounded-lg px-3 py-2 bg-emerald-500/12 border border-emerald-500/30">
                <span class="text-[11px] font-mono text-emerald-300 truncate flex-1 mr-2`);
}
h=h.replace("showToast(`Key saved to config (${pid})`);","showToast(`Key saved to config (${pid})`);\n      await loadProviderQuotas(true);");
fs.writeFileSync(p,h);
console.log("ok");
