const fs = require("fs");
const p = "D:/source/xmitm/src/admin.html";
let h = fs.readFileSync(p, "utf8");

// Remove refresh button block
h = h.replace(/\s*<button type="button" id="btn-refresh-quota"[\s\S]*?<\/button><span id="quota-last-updated"[\s\S]*?<\/span>\s*/g, "\n          ");

// Remove Chua co du lieu - use loading UI instead
h = h.replace(
  `      if (!q) {
        return '<div class="mt-2 space-y-1"><div class="h-2 w-full rounded-full bg-slate-800 overflow-hidden"><div class="h-full w-full rounded-full bg-emerald-500/50"></div></div><span class="text-[9px] font-mono text-emerald-400/80">Chua co du lieu quota - bam Refresh</span></div>';
      }`,
  `      if (!q) {
        return '<div class="mt-2 space-y-1"><div class="h-2 w-full rounded-full bg-slate-800 overflow-hidden"><div class="h-full w-1/3 rounded-full bg-slate-500 animate-pulse"></div></div><span class="text-[9px] font-mono text-slate-500">Dang kiem tra...</span></div>';
      }`
);

// Silent quota load - no toast on error, no quota-last-updated
h = h.replace(
  `      } catch (e) {
        showToast('Khong tai duoc quota', 'error');
      }
      providerQuotaLoading = false;
      const el = document.getElementById('quota-last-updated');
      if (el && providerQuotaUpdatedAt) el.textContent = 'Cap nhat: ' + providerQuotaUpdatedAt.toLocaleTimeString('vi-VN');
      renderProviders();`,
  `      } catch (e) { /* silent */ }
      providerQuotaLoading = false;
      renderProviders();`
);

// Poll always on - do not stop when leaving providers tab
h = h.replace(
  `      if (tab === 'providers') startProviderQuotaPoll(); else stopProviderQuotaPoll();`,
  `      if (tab === 'providers' && !providerQuotaTimer) startProviderQuotaPoll();`
);

// loadProviders: only render, poll handles quota
h = h.replace(
  `      renderProviders();
      loadProviderQuotas(false);
    }

    // -- Save to server`,
  `      renderProviders();
    }

    // -- Save to server`
);

// Thicker progress bar
h = h.replace('h-1.5 w-full rounded-full bg-slate-800/80', 'h-2 w-full rounded-full bg-slate-800/80');

fs.writeFileSync(p, h);
console.log("done");