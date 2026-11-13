/**
 * ============================================================================
 * KRATOM WEB CONSOLE — v1.0.2 PRODUCTION (PATCHED)
 * ============================================================================
 * ✅ NEW v1.0.2:
 *   - 10 new commands: stockalert, restock, velocity, health, scorecard,
 *     executive, pnl, breakeven, deadstock, clv
 *   - getStock() supports BOTH STOCK_CACHE (index) + STATE.stockCache (dashboard)
 *   - recordSale() uses updateStockCacheDelta for real-time stock updates
 *   - Fixed dispatch for all quick chips in UI
 * ============================================================================
 */
(function () {
  'use strict';

  const V = 'v1.0.2-PRODUCTION';
  const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  const ALIAS = {
    RED: ['ฝาแดง', 'แดง', 'a'],
    BM: ['บีเอ็ม', 'บี', 'bm', 'b'],
    ORIGINAL: ['น้ำดิบ', 'น้ำ', 'ดิบ', 't']
  };

  // ============ DATA ACCESS ============
  function getData() {
    if (typeof STATE === 'undefined') return { logs: [], expenses: [], products: [], config: {} };
    if (STATE.filtered && Array.isArray(STATE.filtered.logs)) {
      return {
        logs: STATE.filtered.logs || [],
        expenses: STATE.filtered.expenses || [],
        products: (STATE.data && STATE.data.products) || STATE.filtered.products || [],
        config: (STATE.data && STATE.data.config) || STATE.filtered.config || {}
      };
    }
    return {
      logs: STATE.logs || [],
      expenses: STATE.expenses || [],
      products: STATE.products || [],
      config: STATE.config || {}
    };
  }

  function getApiUrl() {
    if (typeof STATE !== 'undefined' && STATE.apiUrl) return STATE.apiUrl;
    return localStorage.getItem('kratom_pos_apiUrl')
        || localStorage.getItem('kratom_web_apiUrl')
        || '';
  }

  function refreshUI() {
    try {
      if (typeof saveLocalData === 'function') saveLocalData();
      if (typeof renderProductCatalog === 'function') renderProductCatalog();
      if (typeof renderCart === 'function') renderCart();
      if (typeof renderStockPanel === 'function') renderStockPanel();
      if (typeof renderHistoryTable === 'function') renderHistoryTable();
      if (typeof renderManualHistoryList === 'function') renderManualHistoryList();
      if (typeof renderAll === 'function') renderAll();
      if (typeof renderDashboard === 'function') renderDashboard();
      if (typeof renderExecutivePage === 'function') renderExecutivePage();
      if (typeof renderAnalytics === 'function') renderAnalytics();
      try { sessionStorage.removeItem('kratom_dashboard_cache_v5'); } catch (e) { }
    } catch (e) { console.warn('[Console] refresh error:', e); }
  }

  // ============ HELPERS ============
  const money = n => '฿' + Math.round(Number(n) || 0).toLocaleString('th-TH');
  const num = n => (Number(n) || 0).toLocaleString('th-TH');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = d => { const x = new Date(d); return x.getDate() + ' ' + MONTHS[x.getMonth()] + ' ' + (x.getFullYear() + 543); };
  const fmtShort = d => { const x = new Date(d); return x.getDate() + '/' + (x.getMonth() + 1) + '/' + String(x.getFullYear() + 543).slice(-2); };
  const kv = (l, v, c) => `<div class="kv"><span class="kv-label">${l}</span><span class="kv-value"${c ? ` style="color:${c}"` : ''}>${v}</span></div>`;
  const bar = (p, c) => `<div class="bar"><div class="bar-fill" style="width:${Math.min(100, Math.max(0, p))}%;background:${c || '#10b981'}"></div></div>`;
  const section = t => `<div class="text-xs uppercase tracking-wider text-gray-400 mt-3 mb-1 font-bold">${t}</div>`;

  function getRecipeInfo(rt) {
    return {
      RED: { emoji: '🔴', label: 'ฝาแดง', color: '#ef4444' },
      BM: { emoji: '🟡', label: 'BM', color: '#f59e0b' },
      ORIGINAL: { emoji: '⚪', label: 'Original', color: '#9ca3af' }
    }[rt] || { emoji: '📦', label: rt || '-', color: '#6b7280' };
  }

  function getUnitCost(rt) {
    const c = getData().config || {};
    const lc = Number(c.costLeaves || 100);
    const r = Number(c.ratio || 25);
    const e = Number(c.extractPercent || 80) / 100;
    const lb = (1 / (r * e)) * lc;
    const bc = Number(c.costBottle || 5);
    const hc = Number(c.costHidden || 4);
    if (rt === 'RED') return lb + bc + hc + (20 / 60) * Number(c.costSyrupRed || 54) + (1 / 3) * Number(c.costCokeRed || 26);
    if (rt === 'ORIGINAL') return lb + bc + hc;
    return lb + bc + hc + (20 / 60) * Number(c.costSyrupBm || 34) + (1 / 3) * Number(c.costCokeBm || 26) + 3.33 * Number(c.costPlumBm || 1);
  }

  // ✅ PATCHED: try STOCK_CACHE, STATE.stockCache, then compute
  function getStock(name, id) {
    if (typeof STOCK_CACHE !== 'undefined' && STOCK_CACHE) {
      if (id && STOCK_CACHE[id] !== undefined) return STOCK_CACHE[id];
      if (STOCK_CACHE['name:' + name] !== undefined) return STOCK_CACHE['name:' + name];
    }
    if (typeof STATE !== 'undefined' && STATE.stockCache) {
      if (id && STATE.stockCache[id] !== undefined) return STATE.stockCache[id];
      if (STATE.stockCache['name:' + name] !== undefined) return STATE.stockCache['name:' + name];
    }
    const d = getData();
    let inQ = 0, outQ = 0;
    d.logs.filter(l => l.productName === name).forEach(l => {
      if (l.type === 'IN') inQ += Number(l.qty || 0);
      if (l.type === 'OUT') outQ += Number(l.qty || 0);
    });
    return inQ - outQ;
  }

  function statsInRange(logs, exps, s, e) {
    const sl = logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= s && new Date(l.timestamp) < e);
    const ex = exps.filter(x => new Date(x.timestamp) >= s && new Date(x.timestamp) < e);
    return {
      rev: sl.reduce((a, l) => a + Number(l.total || 0), 0),
      vol: sl.reduce((a, l) => a + Number(l.qty || 0), 0),
      exp: ex.reduce((a, x) => a + Number(x.amount || 0), 0),
      bills: sl.length
    };
  }

  function getPeriodStats(period) {
    const d = getData();
    const now = new Date();
    let start, end = new Date(now.getTime() + 86400000);
    switch (period) {
      case 'today': start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
      case 'yesterday': start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); end = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
      case '7days': start = new Date(now.getTime() - 7 * 86400000); break;
      case 'thisMonth': start = new Date(now.getFullYear(), now.getMonth(), 1); break;
      case 'lastMonth': start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth(), 1); break;
      default: start = new Date(0);
    }
    const s = statsInRange(d.logs, d.expenses, start, end);
    s.start = start;
    s.end = end;
    return s;
  }

  // ============ SALE PARSING ============
  function parseSaleCommand(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const t = raw.toLowerCase();
    let saleDate = null, rest = t;
    if (t.startsWith('วันนี้')) { saleDate = new Date(); rest = t.replace(/^วันนี้\s*/, ''); }
    else if (t.startsWith('พรุ่งนี้')) { saleDate = new Date(Date.now() + 86400000); rest = t.replace(/^พรุ่งนี้\s*/, ''); }
    else if (t.startsWith('เมื่อวาน')) { saleDate = new Date(Date.now() - 86400000); rest = t.replace(/^เมื่อวาน\s*/, ''); }
    else {
      const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s*/);
      if (m) {
        let y = Number(m[3]);
        if (y < 100) y += y < 50 ? 2000 : 1900;
        const dd = Number(m[1]), mm = Number(m[2]);
        if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
        saleDate = new Date(y, mm - 1, dd);
        rest = t.slice(m[0].length);
      }
    }
    if (!saleDate || !rest) return null;
    saleDate.setHours(12, 0, 0, 0);

    const allAlias = [];
    for (const rt in ALIAS) ALIAS[rt].forEach(a => allAlias.push({ a: a.toLowerCase(), rt }));
    allAlias.sort((x, y) => y.a.length - x.a.length);

    const items = [], consumed = [];
    allAlias.forEach(({ a, rt }) => {
      const esc2 = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?:^|\\s)(' + esc2 + ')\\s*(\\d+(?:\\.\\d+)?)', 'gi');
      let m;
      while ((m = re.exec(rest)) !== null) {
        const st = m.index + m[0].indexOf(m[1]);
        const en = m.index + m[0].length;
        if (consumed.some(r => !(en <= r.start || st >= r.end))) continue;
        items.push({ recipeType: rt, qty: parseFloat(m[2]), alias: m[1] });
        consumed.push({ start: st, end: en });
      }
    });
    if (items.length === 0) return null;
    return { saleDate, items };
  }

  // ============ RECORD SALE — PATCHED v1.0.2 ============
  function recordSale(parsed) {
    const d = getData();
    const apiUrl = getApiUrl();
    const results = [], errors = [];

    for (const item of parsed.items) {
      let product = d.products.find(p => p.recipeType === item.recipeType);
      if (!product && item.recipeType === 'ORIGINAL') {
        product = { id: 'P_ORIGINAL', name: 'น้ำดิบ Original (1000ml)', recipeType: 'ORIGINAL', price: 25, status: 'ACTIVE' };
        if (typeof STATE !== 'undefined') {
          if (Array.isArray(STATE.products)) STATE.products.push(product);
          else if (STATE.data && Array.isArray(STATE.data.products)) STATE.data.products.push(product);
        }
        if (apiUrl) {
          try {
            fetch(apiUrl, {
              method: 'POST', mode: 'no-cors',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify(Object.assign({ action: 'SAVE_PRODUCT' }, product))
            });
          } catch (e) { console.warn('[Console] product sync failed:', e); }
        }
      }
      if (!product) { errors.push('ไม่พบสินค้าสูตร ' + item.recipeType); continue; }

      const tx = {
        id: 'TX_WEB_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        timestamp: parsed.saleDate.toISOString(),
        type: 'OUT',
        qty: item.qty,
        unitPrice: Number(product.price),
        total: item.qty * Number(product.price),
        source: 'WEB_CONSOLE',
        paymentMethod: 'CASH',
        recipeType: item.recipeType,
        productName: product.name,
        action: 'POS_SALE',
        note: 'บันทึกผ่าน Web Console'
      };

      let inserted = false;
      if (typeof STATE !== 'undefined') {
        if (Array.isArray(STATE.logs) && STATE.logs !== d.logs) {
          STATE.logs.unshift(tx);
          inserted = true;
        }
        if (STATE.data && Array.isArray(STATE.data.logs) && STATE.data.logs !== d.logs) {
          STATE.data.logs.unshift(tx);
          inserted = true;
        }
      }
      if (!inserted && Array.isArray(d.logs)) d.logs.unshift(tx);

      // ✅ PATCHED: use updateStockCacheDelta if available
      if (typeof window.updateStockCacheDelta === 'function') {
        window.updateStockCacheDelta(product.id, product.name, -item.qty);
      } else if (typeof STATE !== 'undefined' && STATE.stockCache) {
        if (STATE.stockCache[product.id] !== undefined) STATE.stockCache[product.id] -= item.qty;
        if (STATE.stockCache['name:' + product.name] !== undefined) STATE.stockCache['name:' + product.name] -= item.qty;
        STATE.stockCacheTime = Date.now();
      }

      if (apiUrl) {
        try {
          fetch(apiUrl, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: 'POS_SALE' }, tx))
          });
        } catch (e) { console.warn('[Console] sale sync failed:', e); }
      }

      results.push({ item, product, log: tx });
    }

    refreshUI();

    const total = results.reduce((s, r) => s + r.log.total, 0);
    const qty = results.reduce((s, r) => s + r.log.qty, 0);

    let html = `<h4>✅ บันทึกการขายสำเร็จ</h4>
      <div class="text-xs text-gray-400 mb-2">📅 ${fmtDate(parsed.saleDate)}</div>
      <div class="text-2xl font-bold text-emerald-400">${money(total)}</div>
      <div class="text-xs text-gray-400 mb-2">📦 ${qty} ขวด · ${results.length} รายการ</div>
      <div class="mt-3 pt-3 border-t border-white/10">`;
    results.forEach(r => {
      const info = getRecipeInfo(r.item.recipeType);
      const stock = getStock(r.product.name, r.product.id);
      html += `<div class="kv"><span class="kv-label">${info.emoji} ${esc(r.product.name)}</span><span class="kv-value" style="color:${info.color}">${r.log.qty} × ${money(r.log.unitPrice)}</span></div>`;
      html += `<div class="text-[10px] text-gray-500 text-right">คงเหลือ ${stock} ขวด</div>`;
    });
    if (errors.length) html += `<div class="mt-2 text-xs text-red-400">⚠️ ${errors.length} รายการผิดพลาด</div>`;
    html += `</div>`;
    return html;
  }

  // ============ HELP ============
  function cmdHelp() {
    return `<h4>🍃 KRATOM Web Console</h4>
      <div class="text-xs text-gray-400 mb-2">${V} · 47+ commands</div>
      <div class="space-y-1 text-xs mt-2">
        <div class="text-emerald-400 font-bold">🛒 บันทึกการขาย</div>
        <div class="text-gray-400">• วันนี้ ฝาแดง14 BM16 T4</div>
        <div class="text-gray-400">• พรุ่งนี้ A14 BM16 T4</div>
        <div class="text-gray-400">• 15/10/26 A14 BM16 T4</div>
        <div class="text-amber-400 font-bold mt-2">📊 รายงาน</div>
        <div class="text-gray-400">• รายงานวันนี้ / รายงานสัปดาห์ / รายงานเดือน</div>
        <div class="text-cyan-400 font-bold mt-2">🎯 Advanced Analytics</div>
        <div class="text-gray-400">• ประสิทธิภาพ · ตัวชี้วัดธุรกิจ · วิเคราะห์เชิงลึก</div>
        <div class="text-gray-400">• rfm · abc · seasonal · basket · cohort</div>
        <div class="text-blue-400 font-bold mt-2">💰 การเงิน & KPI</div>
        <div class="text-gray-400">• กำไร · ต้นทุน · cashflow · kpi</div>
        <div class="text-gray-400">• pnl · breakeven · clv · deadstock</div>
        <div class="text-purple-400 font-bold mt-2">📦 สินค้า & สต๊อก</div>
        <div class="text-gray-400">• สินค้า · ท็อป · สต๊อก · สัดส่วนตลาด</div>
        <div class="text-gray-400">• stockalert · restock · velocity</div>
        <div class="text-pink-400 font-bold mt-2">🏆 Executive</div>
        <div class="text-gray-400">• health · scorecard · executive</div>
        <div class="text-gray-400 font-bold mt-2">🏷️ นามแฝง</div>
        <div class="text-gray-400">🔴 ฝาแดง แดง A · 🟡 บีเอ็ม บี BM B · ⚪ น้ำดิบ น้ำ ดิบ T</div>
      </div>`;
  }

  // ============ DASHBOARD ============
  function cmdDashboard() {
    const d = getData();
    const now = new Date();
    const today = statsInRange(d.logs, d.expenses, new Date(now.getFullYear(), now.getMonth(), now.getDate()), now);
    const week = statsInRange(d.logs, d.expenses, new Date(now.getTime() - 7 * 86400000), now);
    const month = statsInRange(d.logs, d.expenses, new Date(now.getFullYear(), now.getMonth(), 1), now);
    let totalStock = 0, lowStock = 0;
    (d.products || []).forEach(p => { const s = getStock(p.name, p.id); totalStock += Math.max(0, s); if (s <= 5) lowStock++; });
    return `<h4>📊 Dashboard ภาพรวม</h4>
      <div class="text-xs text-gray-400">${fmtDate(now)}</div>
      ${section('🌅 วันนี้')}
      ${kv('💰 รายได้', money(today.rev), '#10b981')}
      ${kv('📦 ขวด', num(today.vol))}
      ${kv('🧾 บิล', num(today.bills))}
      ${kv('💵 กำไร', money(today.rev - today.exp), today.rev - today.exp >= 0 ? '#f59e0b' : '#ef4444')}
      ${section('📅 7 วัน')}
      ${kv('💰 รายได้', money(week.rev), '#10b981')}
      ${kv('📦 ขวด', num(week.vol))}
      ${section('📆 เดือนนี้')}
      ${kv('💰 รายได้', money(month.rev), '#10b981')}
      ${kv('💵 กำไร', money(month.rev - month.exp), month.rev - month.exp >= 0 ? '#f59e0b' : '#ef4444')}
      ${section('📦 สต๊อก')}
      ${kv('รวม', num(totalStock) + ' ขวด', '#3b82f6')}
      ${kv('ต่ำกว่าเกณฑ์', num(lowStock) + ' รายการ', lowStock > 0 ? '#ef4444' : '#10b981')}`;
  }

  // ============ SUMMARY ============
  function cmdSummary() {
    const d = getData();
    const now = new Date();
    const today = statsInRange(d.logs, d.expenses, new Date(now.getFullYear(), now.getMonth(), now.getDate()), now);
    const week = statsInRange(d.logs, d.expenses, new Date(now.getTime() - 7 * 86400000), now);
    const month = statsInRange(d.logs, d.expenses, new Date(now.getFullYear(), now.getMonth(), 1), now);
    const lastMonth = statsInRange(d.logs, d.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1));
    const growth = lastMonth.rev > 0 ? ((month.rev - lastMonth.rev) / lastMonth.rev) * 100 : 0;
    const nm = month.rev > 0 ? ((month.rev - month.exp) / month.rev) * 100 : 0;
    let totalStock = 0, lowCount = 0;
    (d.products || []).forEach(p => { const s = getStock(p.name, p.id); totalStock += Math.max(0, s); if (s <= 5) lowCount++; });
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const rs = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const ps = {};
    rs.forEach(l => { if (!ps[l.productName]) ps[l.productName] = 0; ps[l.productName] += Number(l.qty || 0); });
    const top3 = Object.keys(ps).sort((a, b) => ps[b] - ps[a]).slice(0, 3);
    const growthEmoji = growth >= 0 ? '📈' : '📉';
    const growthColor = growth >= 0 ? '#10b981' : '#ef4444';
    const marginColor = nm >= 20 ? '#10b981' : nm >= 0 ? '#f59e0b' : '#ef4444';
    return `<h4>📊 สรุปภาพรวม</h4>
      <div class="text-xs text-gray-400 mb-2">${fmtDate(now)}</div>
      ${section('🌅 วันนี้')}
      ${kv('💰 รายได้', money(today.rev), '#10b981')}
      ${kv('📦 ปริมาณ', num(today.vol) + ' ขวด')}
      ${kv('🧾 บิล', num(today.bills))}
      ${section('📅 7 วัน')}
      ${kv('💰 รายได้', money(week.rev), '#10b981')}
      ${kv('📦 ปริมาณ', num(week.vol) + ' ขวด')}
      ${section('📆 เดือนนี้')}
      ${kv('💰 รายได้', money(month.rev), '#10b981')}
      ${kv('📈 เติบโต', growthEmoji + ' ' + (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%', growthColor)}
      ${kv('💵 กำไร', money(month.rev - month.exp), month.rev - month.exp >= 0 ? '#10b981' : '#ef4444')}
      ${kv('📊 Margin', nm.toFixed(1) + '%', marginColor)}
      ${section('📦 สต๊อก')}
      ${kv('รวม', num(totalStock) + ' ขวด', '#3b82f6')}
      ${kv('ใกล้หมด', num(lowCount) + ' รายการ', lowCount > 0 ? '#ef4444' : '#10b981')}
      ${section('🏆 Top 3 (30 วัน)')}
      ${top3.map((name, i) => kv(['🥇', '🥈', '🥉'][i] + ' ' + esc(name), ps[name] + ' ขวด', '#10b981')).join('')}`;
  }

  // ============ DAILY REPORT ============
  function cmdDailyReport() {
    const d = getData();
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const yStart = new Date(dayStart.getTime() - 86400000);
    const today = statsInRange(d.logs, d.expenses, dayStart, dayEnd);
    const yest = statsInRange(d.logs, d.expenses, yStart, dayStart);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= dayStart && new Date(l.timestamp) < dayEnd);
    const byProd = {};
    sales.forEach(l => { const k = l.productName; if (!byProd[k]) byProd[k] = { qty: 0, rev: 0, rt: l.recipeType }; byProd[k].qty += Number(l.qty); byProd[k].rev += Number(l.total); });
    const growth = yest.rev > 0 ? ((today.rev - yest.rev) / yest.rev) * 100 : 0;
    const nm = today.rev > 0 ? ((today.rev - today.exp) / today.rev) * 100 : 0;
    let html = `<h4>🌙 รายงานประจำวัน</h4>
      <div class="text-xs text-gray-400">${fmtDate(now)}</div>
      <div class="text-2xl font-bold text-emerald-400 mt-2">${money(today.rev)}</div>
      <div class="text-xs text-gray-400">📦 ${num(today.vol)} ขวด · 🧾 ${num(today.bills)} บิล · ${growth >= 0 ? '📈 +' : '📉 '}${growth.toFixed(1)}%</div>
      ${section('📋 สินค้าแต่ละตัว')}`;
    Object.keys(byProd).sort((a, b) => byProd[b].qty - byProd[a].qty).forEach(k => {
      const p = byProd[k];
      const info = getRecipeInfo(p.rt);
      html += kv(`${info.emoji} ${esc(k)}`, `${p.qty} ขวด · ${money(p.rev)}`, info.color);
    });
    if (Object.keys(byProd).length === 0) html += `<div class="text-xs text-gray-500">ไม่มีรายการขาย</div>`;
    html += `${section('💵 สรุปการเงิน')}
      ${kv('รายได้', money(today.rev), '#10b981')}
      ${kv('รายจ่าย', money(today.exp), '#ef4444')}
      ${kv('กำไรสุทธิ', money(today.rev - today.exp), today.rev - today.exp >= 0 ? '#f59e0b' : '#ef4444')}
      ${kv('Margin', nm.toFixed(1) + '%', nm >= 20 ? '#10b981' : nm >= 0 ? '#f59e0b' : '#ef4444')}`;
    return html;
  }

  // ============ WEEKLY REPORT ============
  function cmdWeeklyReport() {
    const d = getData();
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setHours(23, 59, 59, 999);
    const weekStart = new Date(weekEnd.getTime() - 7 * 86400000 + 1);
    weekStart.setHours(0, 0, 0, 0);
    const week = statsInRange(d.logs, d.expenses, weekStart, weekEnd);
    const prevStart = new Date(weekStart.getTime() - 7 * 86400000);
    const prev = statsInRange(d.logs, d.expenses, prevStart, weekStart);
    const growth = prev.rev > 0 ? ((week.rev - prev.rev) / prev.rev) * 100 : 0;
    let html = `<h4>📅 รายงานสัปดาห์</h4>
      <div class="text-xs text-gray-400">${fmtShort(weekStart)} - ${fmtShort(weekEnd)}</div>
      <div class="text-2xl font-bold text-emerald-400 mt-2">${money(week.rev)}</div>
      <div class="text-xs text-gray-400">📦 ${num(week.vol)} ขวด · 🧾 ${num(week.bills)} บิล · ${growth >= 0 ? '📈 +' : '📉 '}${growth.toFixed(1)}%</div>
      ${section('📊 ยอดขายรายวัน')}`;
    const dayArr = [];
    for (let i = 6; i >= 0; i--) {
      const ds = new Date(weekEnd.getTime() - i * 86400000); ds.setHours(0, 0, 0, 0);
      const de = new Date(ds.getTime() + 86400000);
      const s = statsInRange(d.logs, d.expenses, ds, de);
      dayArr.push({ ds, rev: s.rev, vol: s.vol });
    }
    const maxRev = Math.max(...dayArr.map(x => x.rev)) || 1;
    dayArr.forEach(x => {
      const pct = (x.rev / maxRev) * 100;
      html += `<div class="mb-1.5"><div class="flex justify-between text-xs"><span class="text-gray-400">${DAYS[x.ds.getDay()]} ${x.ds.getDate()}/${x.ds.getMonth() + 1}</span><span class="text-white font-bold">${money(x.rev)}</span></div>${bar(pct, x.rev === maxRev ? '#10b981' : '#3b82f6')}</div>`;
    });
    html += `${section('💵 สรุป')}${kv('รายได้', money(week.rev), '#10b981')}${kv('รายจ่าย', money(week.exp), '#ef4444')}${kv('กำไร', money(week.rev - week.exp), week.rev - week.exp >= 0 ? '#f59e0b' : '#ef4444')}`;
    return html;
  }

  // ============ MONTHLY REPORT ============
  function cmdMonthlyReport() {
    const d = getData();
    const now = new Date();
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const month = statsInRange(d.logs, d.expenses, mStart, mEnd);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const prev = statsInRange(d.logs, d.expenses, prevStart, prevEnd);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= mStart && new Date(l.timestamp) <= mEnd);
    const byProd = {};
    sales.forEach(l => { if (!byProd[l.productName]) byProd[l.productName] = { qty: 0, rev: 0, rt: l.recipeType }; byProd[l.productName].qty += Number(l.qty); byProd[l.productName].rev += Number(l.total); });
    const sorted = Object.keys(byProd).sort((a, b) => byProd[b].rev - byProd[a].rev);
    const growth = prev.rev > 0 ? ((month.rev - prev.rev) / prev.rev) * 100 : 0;
    const nm = month.rev > 0 ? ((month.rev - month.exp) / month.rev) * 100 : 0;
    let html = `<h4>📆 รายงานประจำเดือน</h4>
      <div class="text-xs text-gray-400">${MONTHS[now.getMonth()]} ${now.getFullYear() + 543}</div>
      <div class="text-2xl font-bold text-emerald-400 mt-2">${money(month.rev)}</div>
      <div class="text-xs text-gray-400">📦 ${num(month.vol)} ขวด · 🧾 ${num(month.bills)} บิล · ${growth >= 0 ? '📈 +' : '📉 '}${growth.toFixed(1)}%</div>
      ${section('🏆 สินค้าขายดี')}`;
    const medals = ['🥇', '🥈', '🥉'];
    sorted.slice(0, 10).forEach((k, i) => {
      const p = byProd[k];
      const info = getRecipeInfo(p.rt);
      html += kv(`${i < 3 ? medals[i] : '#' + (i + 1)} ${info.emoji} ${esc(k)}`, `${p.qty} ขวด · ${money(p.rev)}`, info.color);
    });
    html += `${section('💵 สรุป')}${kv('รายได้', money(month.rev), '#10b981')}${kv('รายจ่าย', money(month.exp), '#ef4444')}${kv('กำไร', money(month.rev - month.exp), month.rev - month.exp >= 0 ? '#f59e0b' : '#ef4444')}${kv('Margin', nm.toFixed(1) + '%', nm >= 20 ? '#10b981' : nm >= 0 ? '#f59e0b' : '#ef4444')}`;
    return html;
  }

  // ============ SALES REPORT ============
  function cmdSalesReport(period) {
    const p = getPeriodStats(period);
    const d = getData();
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= p.start && new Date(l.timestamp) < p.end);
    const red = sales.filter(l => l.recipeType === 'RED').reduce((s, l) => s + Number(l.qty), 0);
    const bm = sales.filter(l => l.recipeType === 'BM').reduce((s, l) => s + Number(l.qty), 0);
    const orig = sales.filter(l => l.recipeType === 'ORIGINAL').reduce((s, l) => s + Number(l.qty), 0);
    const cashRev = sales.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + Number(l.total), 0);
    const transRev = p.rev - cashRev;
    const periodText = { today: 'วันนี้', yesterday: 'เมื่อวาน', '7days': '7 วัน', thisMonth: 'เดือนนี้' }[period] || period;
    return `<h4>📊 รายงาน ${periodText}</h4>
      ${kv('💰 รายได้', money(p.rev), '#10b981')}
      ${kv('📦 ปริมาณ', num(p.vol) + ' ขวด')}
      ${kv('🧾 บิล', num(p.bills))}
      ${kv('🔴 ฝาแดง', num(red) + ' ขวด', '#ef4444')}
      ${kv('🟡 BM', num(bm) + ' ขวด', '#f59e0b')}
      ${kv('⚪ Original', num(orig) + ' ขวด', '#9ca3af')}
      ${kv('💵 เงินสด', money(cashRev), '#10b981')}
      ${kv('📱 โอน', money(transRev), '#3b82f6')}
      ${kv('💵 กำไร', money(p.rev - p.exp), p.rev - p.exp >= 0 ? '#f59e0b' : '#ef4444')}`;
  }

  // ============ PROFIT ============
  function cmdProfit() {
    const tm = getPeriodStats('thisMonth');
    const lm = getPeriodStats('lastMonth');
    const growth = lm.rev > 0 ? ((tm.rev - lm.rev) / lm.rev) * 100 : 0;
    const nm = tm.rev > 0 ? ((tm.rev - tm.exp) / tm.rev) * 100 : 0;
    return `<h4>💰 วิเคราะห์กำไร</h4>
      ${kv('เดือนนี้', money(tm.rev - tm.exp), '#10b981')}
      ${kv('เดือนก่อน', money(lm.rev - lm.exp))}
      ${kv('เติบโต', (growth >= 0 ? '📈 +' : '📉 ') + growth.toFixed(1) + '%', growth >= 0 ? '#10b981' : '#ef4444')}
      ${kv('Margin', nm.toFixed(1) + '%', nm >= 20 ? '#10b981' : nm >= 0 ? '#f59e0b' : '#ef4444')}
      ${kv('รายได้', money(tm.rev), '#10b981')}
      ${kv('รายจ่าย', money(tm.exp), '#ef4444')}`;
  }

  // ============ COST ============
  function cmdCost() {
    const d = getData();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthly = d.expenses.filter(e => new Date(e.timestamp) >= monthStart);
    const byCat = {};
    monthly.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount); });
    const catLabels = { LEAVES: '🍃 ใบ', COKE: '🥤 โค้ก', SYRUP_RED: '🧪 ยาแดง', SYRUP_BM: '🧪 ยา BM', BOTTLE: '🍾 ขวด', GAS: '🔥 แก๊ส', PLUM: '🫐 บ๊วย', OTHER: '📦 อื่นๆ' };
    const total = Object.values(byCat).reduce((a, b) => a + b, 0);
    let html = `<h4>💸 ต้นทุนเดือนนี้</h4>${kv('รวมทั้งหมด', money(total), '#ef4444')}`;
    Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).forEach(k => {
      const pct = total > 0 ? (byCat[k] / total) * 100 : 0;
      html += `<div class="mb-1">${kv(catLabels[k] || k, money(byCat[k]))}${bar(pct, '#ef4444')}</div>`;
    });
    return html;
  }

  // ============ STOCK ============
  function cmdStock() {
    const d = getData();
    let total = 0, low = [];
    let html = `<h4>📦 สต๊อกสินค้า</h4>`;
    (d.products || []).forEach(p => {
      const s = getStock(p.name, p.id);
      total += s;
      const icon = s <= 5 ? '🔴' : s <= 15 ? '🟡' : '🟢';
      const info = getRecipeInfo(p.recipeType);
      html += kv(`${info.emoji} ${esc(p.name)}`, `${icon} ${num(s)} ขวด`, s <= 5 ? '#ef4444' : s <= 15 ? '#f59e0b' : '#10b981');
      if (s <= 5) low.push(p.name);
    });
    html += kv('รวม', num(total) + ' ขวด', '#3b82f6');
    if (low.length) html += `<div class="mt-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-400">⚠️ ต้องเติม: ${low.join(', ')}</div>`;
    return html;
  }

  // ============ TOP PRODUCTS ============
  function cmdTopProducts() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const byProd = {};
    sales.forEach(l => { if (!byProd[l.productName]) byProd[l.productName] = { qty: 0, rev: 0, rt: l.recipeType }; byProd[l.productName].qty += Number(l.qty); byProd[l.productName].rev += Number(l.total); });
    const sorted = Object.keys(byProd).sort((a, b) => byProd[b].qty - byProd[a].qty).slice(0, 5);
    const totalQty = sales.reduce((s, l) => s + Number(l.qty), 0);
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    let html = `<h4>🏆 สินค้าขายดี Top 5 (30 วัน)</h4>`;
    sorted.forEach((k, i) => {
      const p = byProd[k];
      const pct = totalQty > 0 ? (p.qty / totalQty) * 100 : 0;
      const info = getRecipeInfo(p.rt);
      html += kv(`${medals[i]} ${info.emoji} ${esc(k)}`, `${p.qty} ขวด · ${pct.toFixed(1)}%`, info.color);
    });
    return html;
  }

  // ============ PRODUCT ANALYSIS ============
  function cmdProductAnalysis() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const totalRev = sales.reduce((s, l) => s + Number(l.total), 0);
    const totalVol = sales.reduce((s, l) => s + Number(l.qty), 0);
    let html = `<h4>📦 วิเคราะห์สินค้าทุกตัว (30 วัน)</h4>`;
    (d.products || []).forEach(p => {
      const ps = sales.filter(l => l.productName === p.name);
      const vol = ps.reduce((s, l) => s + Number(l.qty), 0);
      const rev = ps.reduce((s, l) => s + Number(l.total), 0);
      const stock = getStock(p.name, p.id);
      const share = totalVol > 0 ? (vol / totalVol) * 100 : 0;
      const cost = getUnitCost(p.recipeType);
      const margin = p.price > 0 ? ((p.price - cost) / p.price) * 100 : 0;
      const info = getRecipeInfo(p.recipeType);
      html += `<div class="mt-2 p-2 bg-black/30 rounded border border-white/5">
        <div class="flex justify-between text-xs mb-1"><span class="font-bold text-white">${info.emoji} ${esc(p.name)}</span><span class="text-emerald-400">${share.toFixed(1)}%</span></div>
        ${bar(share, share > 40 ? '#10b981' : share > 20 ? '#3b82f6' : '#f59e0b')}
        <div class="grid grid-cols-2 gap-1 text-[10px] mt-1">
          <div><span class="text-gray-500">ขาย:</span> <span class="text-white">${vol}</span></div>
          <div><span class="text-gray-500">รายได้:</span> <span class="text-blue-400">${money(rev)}</span></div>
          <div><span class="text-gray-500">Margin:</span> <span class="text-amber-400">${margin.toFixed(1)}%</span></div>
          <div><span class="text-gray-500">สต๊อก:</span> <span style="color:${stock <= 5 ? '#ef4444' : '#10b981'}">${stock}</span></div>
        </div>
      </div>`;
    });
    return html;
  }

  // ============ PRODUCT DETAIL ============
  function cmdProductDetail(name) {
    if (!name) return `<div class="text-red-400">❌ ระบุชื่อสินค้า เช่น "สินค้า ฝาแดง"</div>`;
    const d = getData();
    const product = (d.products || []).find(p => p.name.toLowerCase().includes(name.toLowerCase()));
    if (!product) return `<div class="text-red-400">❌ ไม่พบสินค้า: ${esc(name)}</div>`;
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && l.productName === product.name);
    const recent = sales.filter(l => new Date(l.timestamp) >= tda);
    const vol = recent.reduce((s, l) => s + Number(l.qty), 0);
    const rev = recent.reduce((s, l) => s + Number(l.total), 0);
    const stock = getStock(product.name, product.id);
    const cost = getUnitCost(product.recipeType);
    const margin = product.price > 0 ? ((product.price - cost) / product.price) * 100 : 0;
    const info = getRecipeInfo(product.recipeType);
    return `<h4>${info.emoji} ${esc(product.name)}</h4>
      ${kv('ราคาขาย', money(product.price), '#10b981')}
      ${kv('ต้นทุน/ขวด', money(cost), '#ef4444')}
      ${kv('กำไร/ขวด', money(product.price - cost), '#10b981')}
      ${kv('Margin', margin.toFixed(1) + '%', '#f59e0b')}
      ${section('📅 30 วันล่าสุด')}
      ${kv('ขาย', num(vol) + ' ขวด', '#3b82f6')}
      ${kv('รายได้', money(rev), '#10b981')}
      ${kv('เฉลี่ย/วัน', (vol / 30).toFixed(1) + ' ขวด')}
      ${kv('สต๊อกคงเหลือ', num(stock) + ' ขวด', stock <= 5 ? '#ef4444' : '#10b981')}`;
  }

  // ============ MARKET SHARE ============
  function cmdMarketShare() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const totalRev = sales.reduce((s, l) => s + Number(l.total), 0);
    let html = `<h4>📊 สัดส่วนตลาด (30 วัน)</h4>`;
    (d.products || []).forEach(p => {
      const ps = sales.filter(l => l.productName === p.name);
      const rev = ps.reduce((s, l) => s + Number(l.total), 0);
      const share = totalRev > 0 ? (rev / totalRev) * 100 : 0;
      const color = share > 40 ? '#10b981' : share > 20 ? '#3b82f6' : '#f59e0b';
      const info = getRecipeInfo(p.recipeType);
      html += `<div class="mb-2"><div class="flex justify-between text-xs mb-1"><span>${info.emoji} ${esc(p.name)}</span><span style="color:${color};font-weight:bold">${share.toFixed(1)}%</span></div>${bar(share, color)}</div>`;
    });
    return html;
  }

  // ============ KPI ============
  function cmdKPI() {
    const d = getData();
    const c = d.config || {};
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const p = statsInRange(d.logs, d.expenses, ms, now);
    const targetRev = Number(c.kpiTargetRevenue) || 50000;
    const targetVol = Number(c.kpiTargetVolume) || 1500;
    const targetProfit = Number(c.kpiTargetProfit) || 15000;
    const revPct = Math.min(100, (p.rev / targetRev) * 100);
    const volPct = Math.min(100, (p.vol / targetVol) * 100);
    const profPct = Math.min(100, ((p.rev - p.exp) / targetProfit) * 100);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - now.getDate() + 1;
    const kpiBar = (label, cur, tgt, pct) => {
      const color = pct >= 100 ? '#10b981' : pct >= 75 ? '#3b82f6' : pct >= 50 ? '#f59e0b' : '#ef4444';
      return `<div class="mb-2"><div class="flex justify-between text-xs mb-1"><span class="text-white">${label}</span><span style="color:${color};font-weight:bold">${pct.toFixed(0)}%</span></div>${bar(pct, color)}<div class="flex justify-between text-[10px] text-gray-500 mt-0.5"><span>${money(cur)}</span><span>เป้า: ${money(tgt)}</span></div></div>`;
    };
    return `<h4>🎯 KPI เดือนนี้</h4>
      <div class="text-xs text-gray-400 mb-2">เหลือ ${daysLeft} วัน</div>
      ${kpiBar('💰 รายได้', p.rev, targetRev, revPct)}
      ${kpiBar('📦 ปริมาณ', p.vol, targetVol, volPct)}
      ${kpiBar('💵 กำไร', p.rev - p.exp, targetProfit, profPct)}`;
  }

  function cmdKPITarget() {
    const d = getData();
    const c = d.config || {};
    return `<h4>🎯 เป้าหมาย KPI</h4>
      ${kv('รายได้/เดือน', money(c.kpiTargetRevenue || 50000))}
      ${kv('ปริมาณ/เดือน', num(c.kpiTargetVolume || 1500) + ' ขวด')}
      ${kv('กำไร/เดือน', money(c.kpiTargetProfit || 15000))}
      <div class="mt-2 text-xs text-gray-400">💡 ตั้งเป้าใหม่: ตั้งเป้า รายได้ 100000</div>`;
  }

  function cmdSetTarget(args) {
    const parts = args.trim().split(/\s+/);
    if (parts.length < 2) return `<div class="text-red-400">❌ รูปแบบ: ตั้งเป้า รายได้ 50000</div>`;
    const map = { 'รายได้': 'kpiTargetRevenue', 'revenue': 'kpiTargetRevenue', 'ปริมาณ': 'kpiTargetVolume', 'volume': 'kpiTargetVolume', 'กำไร': 'kpiTargetProfit', 'profit': 'kpiTargetProfit' };
    const key = map[parts[0]];
    const val = Number(parts[1]);
    if (!key) return `<div class="text-red-400">❌ ไม่รู้จัก: ${esc(parts[0])}</div>`;
    if (!isFinite(val) || val <= 0) return `<div class="text-red-400">❌ ค่าต้องเป็นตัวเลข > 0</div>`;
    if (typeof STATE !== 'undefined' && STATE.config) STATE.config[key] = val;
    if (typeof STATE !== 'undefined' && STATE.data && STATE.data.config) STATE.data.config[key] = val;
    const apiUrl = getApiUrl();
    if (apiUrl) try { fetch(apiUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'SAVE_CONFIG', config: { [key]: val } }) }); } catch (e) { }
    if (typeof saveLocalData === 'function') saveLocalData();
    return `<h4>✅ ตั้งเป้าใหม่สำเร็จ</h4>${kv('เป้าหมาย', num(val))}`;
  }

  // ============ TREND ============
  function cmdTrend() {
    const d = getData();
    const now = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const ds = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const de = new Date(ds.getTime() + 86400000);
      const s = statsInRange(d.logs, d.expenses, ds, de);
      days.push(s.rev);
    }
    const n = days.length;
    const avg = days.reduce((a, b) => a + b, 0) / n;
    const sumX = days.reduce((s, _, i) => s + i, 0);
    const sumY = days.reduce((s, v) => s + v, 0);
    const sumXY = days.reduce((s, v, i) => s + i * v, 0);
    const sumX2 = days.reduce((s, _, i) => s + i * i, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    let trendText, color;
    if (slope > avg * 0.05) { trendText = '📈 เพิ่มขึ้นชัดเจน'; color = '#10b981'; }
    else if (slope > 0) { trendText = '↗️ เพิ่มขึ้นเล็กน้อย'; color = '#3b82f6'; }
    else if (slope < -avg * 0.05) { trendText = '📉 ลดลงชัดเจน'; color = '#ef4444'; }
    else if (slope < 0) { trendText = '↘️ ลดลงเล็กน้อย'; color = '#f59e0b'; }
    else { trendText = '➡️ คงที่'; color = '#6b7280'; }
    const sparkLevels = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const maxSpark = Math.max(...days) || 1;
    const sparkline = days.map(v => sparkLevels[Math.min(7, Math.floor((v / maxSpark) * 8))]).join('');
    return `<h4>📈 Trend Analysis (30 วัน)</h4>
      <div class="text-center py-3"><div class="text-2xl" style="color:${color}">${trendText}</div><div class="text-xs text-gray-500">${(slope / avg * 100).toFixed(2)}% ต่อวัน</div></div>
      <div class="text-center text-emerald-400 text-xl font-mono tracking-tighter mt-2">${sparkline}</div>
      <div class="mt-3">${kv('เฉลี่ย/วัน', money(avg), '#10b981')}${kv('สูงสุด', money(Math.max(...days)))}${kv('ต่ำสุด', money(Math.min(...days)))}</div>`;
  }

  // ============ COMPARISON ============
  function cmdCompare() {
    const t = getPeriodStats('today');
    const y = getPeriodStats('yesterday');
    const change = y.rev > 0 ? ((t.rev - y.rev) / y.rev) * 100 : 0;
    const emoji = change > 5 ? '📈' : change < -5 ? '📉' : '➡️';
    const color = change > 5 ? '#10b981' : change < -5 ? '#ef4444' : '#f59e0b';
    const tm = getPeriodStats('thisMonth');
    const lm = getPeriodStats('lastMonth');
    const mChange = lm.rev > 0 ? ((tm.rev - lm.rev) / lm.rev) * 100 : 0;
    return `<h4>⚖️ เปรียบเทียบ</h4>
      ${section('🌅 วันนี้ vs เมื่อวาน')}
      ${kv('วันนี้', money(t.rev), '#10b981')}
      ${kv('เมื่อวาน', money(y.rev))}
      ${kv('เปลี่ยน', emoji + ' ' + (change >= 0 ? '+' : '') + change.toFixed(1) + '%', color)}
      ${section('📆 เดือนนี้ vs เดือนก่อน')}
      ${kv('เดือนนี้', money(tm.rev), '#10b981')}
      ${kv('เดือนก่อน', money(lm.rev))}
      ${kv('เปลี่ยน', (mChange >= 0 ? '📈 +' : '📉 ') + mChange.toFixed(1) + '%', mChange >= 0 ? '#10b981' : '#ef4444')}`;
  }

  // ============ FORECAST ============
  function cmdForecast() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const dailyRev = sales.reduce((s, l) => s + Number(l.total), 0) / 30;
    return `<h4>🔮 พยากรณ์ 7 วัน</h4>
      <div class="text-center py-3"><div class="text-2xl font-black text-purple-400">${money(dailyRev * 7)}</div><div class="text-xs text-gray-500">คาดการณ์รายได้</div></div>
      ${kv('รายได้/วัน', money(dailyRev), '#10b981')}
      ${kv('รายได้/7 วัน', money(dailyRev * 7))}
      ${kv('รายได้/30 วัน', money(dailyRev * 30))}`;
  }

  // ============ CASHFLOW ============
  function cmdCashflow() {
    const d = getData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const logs = d.logs.filter(l => new Date(l.timestamp) >= ms && l.type === 'OUT');
    const exps = d.expenses.filter(e => new Date(e.timestamp) >= ms);
    const cashIn = logs.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + Number(l.total), 0);
    const transIn = logs.filter(l => l.paymentMethod === 'TRANSFER').reduce((s, l) => s + Number(l.total), 0);
    const cashOut = exps.filter(e => e.paymentMethod === 'CASH').reduce((s, e) => s + Number(e.amount), 0);
    const transOut = exps.filter(e => e.paymentMethod === 'TRANSFER').reduce((s, e) => s + Number(e.amount), 0);
    const totalIn = cashIn + transIn;
    const totalOut = cashOut + transOut;
    const net = totalIn - totalOut;
    return `<h4>💵 Cash Flow เดือนนี้</h4>
      ${kv('⬆️ เงินเข้า', money(totalIn), '#10b981')}
      ${kv('💵 เงินสด', money(cashIn), '#10b981')}
      ${kv('📱 โอน', money(transIn), '#3b82f6')}
      ${kv('⬇️ เงินออก', money(totalOut), '#ef4444')}
      ${kv('💵 เงินสด', money(cashOut), '#ef4444')}
      ${kv('📱 โอน', money(transOut), '#ef4444')}
      ${kv('💰 สุทธิ', money(net), net >= 0 ? '#10b981' : '#ef4444')}`;
  }

  function cmdCashflowForecast() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const exps = d.expenses.filter(e => new Date(e.timestamp) >= tda);
    const dailyRev = sales.reduce((s, l) => s + Number(l.total), 0) / 30;
    const dailyExp = exps.reduce((s, e) => s + Number(e.amount), 0) / 30;
    const dailyNet = dailyRev - dailyExp;
    return `<h4>🔮 Cash Flow Forecast (30 วัน)</h4>
      <div class="text-center py-3"><div class="text-2xl font-black ${dailyNet >= 0 ? 'text-emerald-400' : 'text-red-400'}">${money(dailyNet * 30)}</div><div class="text-xs text-gray-500">คาดการณ์สุทธิ</div></div>
      ${kv('รายได้/วัน', money(dailyRev), '#10b981')}
      ${kv('รายจ่าย/วัน', money(dailyExp), '#ef4444')}
      ${kv('สุทธิ/วัน', money(dailyNet), dailyNet >= 0 ? '#10b981' : '#ef4444')}`;
  }

  // ============ CUSTOMER ============
  function cmdCustomer() {
    const d = getData();
    const sales = d.logs.filter(l => l.type === 'OUT');
    const total = sales.reduce((s, l) => s + Number(l.total), 0);
    const atv = sales.length > 0 ? total / sales.length : 0;
    return `<h4>👥 สถิติลูกค้า</h4>
      ${kv('บิลทั้งหมด', num(sales.length) + ' บิล')}
      ${kv('ยอดรวม', money(total), '#10b981')}
      ${kv('เฉลี่ย/บิล', money(atv), '#f59e0b')}`;
  }

  // ============ SALES KPI ============
  function cmdSalesKPIs() {
    const d = getData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const month = statsInRange(d.logs, d.expenses, ms, now);
    const days = Math.max(1, Math.ceil((now - ms) / 86400000));
    const velocity = month.vol / days;
    const atv = month.bills > 0 ? month.rev / month.bills : 0;
    const lm = getPeriodStats('lastMonth');
    const momGrowth = lm.rev > 0 ? ((month.rev - lm.rev) / lm.rev) * 100 : 0;
    let kpiScore = 0;
    kpiScore += momGrowth > 20 ? 25 : momGrowth > 10 ? 20 : momGrowth > 0 ? 15 : momGrowth > -10 ? 8 : 0;
    kpiScore += velocity > 50 ? 25 : velocity > 20 ? 20 : velocity > 10 ? 15 : velocity > 5 ? 8 : 0;
    kpiScore += atv > 100 ? 25 : atv > 60 ? 20 : atv > 40 ? 15 : 8;
    kpiScore += month.rev > 0 ? 25 : 0;
    const grade = kpiScore >= 90 ? 'A+' : kpiScore >= 80 ? 'A' : kpiScore >= 70 ? 'B+' : kpiScore >= 60 ? 'B' : kpiScore >= 50 ? 'C' : kpiScore >= 40 ? 'D' : 'F';
    const gColor = kpiScore >= 80 ? '#10b981' : kpiScore >= 60 ? '#3b82f6' : kpiScore >= 40 ? '#f59e0b' : '#ef4444';
    return `<h4>📊 Sales Performance KPI</h4>
      <div class="text-center py-3"><div class="text-4xl font-black" style="color:${gColor}">${grade}</div><div class="text-xs text-gray-500">KPI Score ${kpiScore}/100</div></div>
      ${section('💼 ดัชนีการขายหลัก')}
      ${kv('⚡ Velocity', velocity.toFixed(1) + ' ขวด/วัน', '#10b981')}
      ${kv('💰 Avg Daily Rev', money(month.rev / days), '#3b82f6')}
      ${kv('🧾 ATV', money(atv), '#8b5cf6')}
      ${kv('📈 MoM Growth', (momGrowth >= 0 ? '+' : '') + momGrowth.toFixed(1) + '%', momGrowth >= 0 ? '#10b981' : '#ef4444')}`;
  }

  // ============ BUSINESS KPI ============
  function cmdBusinessKPIs() {
    const d = getData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const logs = d.logs.filter(l => new Date(l.timestamp) >= ms && l.type === 'OUT');
    const exps = d.expenses.filter(e => new Date(e.timestamp) >= ms);
    const revenue = logs.reduce((s, l) => s + Number(l.total), 0);
    const expenses = exps.reduce((s, e) => s + Number(e.amount), 0);
    let cogs = 0;
    logs.forEach(l => { cogs += Number(l.qty) * getUnitCost(l.recipeType || 'RED'); });
    const gp = revenue - cogs;
    const np = revenue - expenses;
    const gm = revenue > 0 ? (gp / revenue) * 100 : 0;
    const nm = revenue > 0 ? (np / revenue) * 100 : 0;
    const roi = cogs > 0 ? (np / cogs) * 100 : 0;
    let totalStockValue = 0;
    (d.products || []).forEach(p => { totalStockValue += Math.max(0, getStock(p.name, p.id)) * p.price; });
    const invTurn = cogs > 0 && totalStockValue > 0 ? cogs / totalStockValue : 0;
    return `<h4>🏢 Business KPI Dashboard</h4>
      ${section('💰 Profitability')}
      ${kv('📊 Gross Margin', gm.toFixed(1) + '%', gm > 50 ? '#10b981' : gm > 30 ? '#3b82f6' : '#f59e0b')}
      ${kv('💵 Net Margin', nm.toFixed(1) + '%', nm > 20 ? '#10b981' : nm > 0 ? '#f59e0b' : '#ef4444')}
      ${kv('📈 ROI', roi.toFixed(1) + '%', roi > 30 ? '#10b981' : roi > 0 ? '#3b82f6' : '#ef4444')}
      ${section('⚙️ Efficiency')}
      ${kv('🔄 Inventory Turnover', invTurn.toFixed(2) + 'x', invTurn > 2 ? '#10b981' : '#f59e0b')}
      ${kv('📦 มูลค่าสต๊อก', money(totalStockValue), '#3b82f6')}
      ${section('💵 การเงิน')}
      ${kv('รายได้', money(revenue), '#10b981')}
      ${kv('รายจ่าย', money(expenses), '#ef4444')}
      ${kv('กำไร', money(np), np >= 0 ? '#f59e0b' : '#ef4444')}`;
  }

  // ============ DEEP ANALYSIS ============
  function cmdDeepAnalysis() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const totalRev = sales.reduce((s, l) => s + Number(l.total), 0);
    const totalVol = sales.reduce((s, l) => s + Number(l.qty), 0);
    const byProd = {};
    sales.forEach(l => { if (!byProd[l.productName]) byProd[l.productName] = { rev: 0, vol: 0, rt: l.recipeType }; byProd[l.productName].rev += Number(l.total); byProd[l.productName].vol += Number(l.qty); });
    const sorted = Object.keys(byProd).sort((a, b) => byProd[b].rev - byProd[a].rev);
    let cum = 0;
    const abc = { A: [], B: [], C: [] };
    sorted.forEach(k => {
      cum += byProd[k].rev;
      const pct = totalRev > 0 ? (cum / totalRev) * 100 : 0;
      if (pct <= 80) abc.A.push(k); else if (pct <= 95) abc.B.push(k); else abc.C.push(k);
    });
    const hhi = Object.values(byProd).reduce((s, p) => s + Math.pow(totalVol > 0 ? (p.vol / totalVol) * 100 : 0, 2), 0);
    const hhiColor = hhi > 2500 ? '#ef4444' : hhi > 1500 ? '#f59e0b' : '#10b981';
    return `<h4>🔬 Deep Analysis (30 วัน)</h4>
      ${kv('รายได้', money(totalRev), '#10b981')}
      ${kv('ปริมาณ', num(totalVol) + ' ขวด')}
      ${section('📦 ABC (Pareto)')}
      ${kv('🥇 Class A', abc.A.length + ' รายการ', '#10b981')}
      ${kv('🥈 Class B', abc.B.length + ' รายการ', '#f59e0b')}
      ${kv('🥉 Class C', abc.C.length + ' รายการ', '#ef4444')}
      ${section('📊 Market Concentration')}
      ${kv('HHI Score', hhi.toFixed(0), hhiColor)}
      ${kv('ระดับ', hhi > 2500 ? '⚠️ เสี่ยงสูง' : hhi > 1500 ? '🟡 ปานกลาง' : '✅ ดี', hhiColor)}
      ${section('🏆 Top Products')}
      ${sorted.slice(0, 5).map((k, i) => {
      const info = getRecipeInfo(byProd[k].rt);
      return kv(`${['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i]} ${info.emoji} ${esc(k)}`, `${byProd[k].vol} ขวด · ${money(byProd[k].rev)}`, info.color);
    }).join('')}`;
  }

  // ============ RFM ============
  function cmdRFM() {
    const d = getData();
    const sales = d.logs.filter(l => l.type === 'OUT');
    const now = new Date();
    const byCust = {};
    sales.forEach(l => {
      if (l.note && l.note.trim().length < 50 && !l.note.includes('บันทึกผ่าน')) {
        const c = l.note.trim();
        if (!byCust[c]) byCust[c] = { last: 0, first: Infinity, count: 0, total: 0 };
        const t = new Date(l.timestamp).getTime();
        if (t > byCust[c].last) byCust[c].last = t;
        if (t < byCust[c].first) byCust[c].first = t;
        byCust[c].count++;
        byCust[c].total += Number(l.total || 0);
      }
    });
    const customers = Object.keys(byCust).map(name => {
      const c = byCust[name];
      const rec = Math.floor((now - c.last) / 86400000);
      const rS = rec <= 7 ? 5 : rec <= 14 ? 4 : rec <= 30 ? 3 : rec <= 60 ? 2 : 1;
      const fS = c.count >= 10 ? 5 : c.count >= 5 ? 4 : c.count >= 3 ? 3 : c.count >= 2 ? 2 : 1;
      const mS = c.total >= 5000 ? 5 : c.total >= 2000 ? 4 : c.total >= 1000 ? 3 : c.total >= 300 ? 2 : 1;
      return { name, rec, count: c.count, total: c.total, rfm: rS + fS + mS };
    });
    const total = customers.length;
    const champ = customers.filter(c => c.rfm >= 12);
    const loyal = customers.filter(c => c.rfm >= 9 && c.rfm < 12);
    const risk = customers.filter(c => c.rfm >= 4 && c.rfm < 6);
    const lost = customers.filter(c => c.rfm < 4);
    const avgCLV = total > 0 ? customers.reduce((s, c) => s + c.total, 0) / total : 0;
    const top5 = customers.sort((a, b) => b.rfm - a.rfm || b.total - a.total).slice(0, 5);
    return `<h4>🎯 RFM Analysis</h4>
      ${kv('👥 ลูกค้าทั้งหมด', num(total) + ' คน')}
      ${kv('💰 Avg CLV', money(avgCLV), '#10b981')}
      ${section('👥 Segments')}
      ${kv('🏆 Champions', champ.length + ' คน', '#10b981')}
      ${kv('💎 Loyal', loyal.length + ' คน', '#3b82f6')}
      ${kv('⚠️ At Risk', risk.length + ' คน', '#fb923c')}
      ${kv('💤 Lost', lost.length + ' คน', '#ef4444')}
      ${section('⭐ Top 5 VIP')}
      ${top5.map((c, i) => kv(`${['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i]} ${esc(c.name)}`, `${money(c.total)} · RFM ${c.rfm}`, '#a78bfa')).join('')}`;
  }

  // ============ ABC ============
  function cmdABC() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const totalRev = sales.reduce((s, l) => s + Number(l.total), 0);
    const byProd = {};
    sales.forEach(l => { if (!byProd[l.productName]) byProd[l.productName] = { rev: 0, vol: 0, rt: l.recipeType }; byProd[l.productName].rev += Number(l.total); byProd[l.productName].vol += Number(l.qty); });
    const sorted = Object.keys(byProd).sort((a, b) => byProd[b].rev - byProd[a].rev);
    let cum = 0;
    const abcData = sorted.map((k, i) => {
      cum += byProd[k].rev;
      const cumPct = totalRev > 0 ? (cum / totalRev) * 100 : 0;
      const revPct = totalRev > 0 ? (byProd[k].rev / totalRev) * 100 : 0;
      const cls = cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C';
      const color = cls === 'A' ? '#10b981' : cls === 'B' ? '#f59e0b' : '#ef4444';
      return { rank: i + 1, name: k, rev: byProd[k].rev, vol: byProd[k].vol, rt: byProd[k].rt, revPct, cumPct, cls, color };
    });
    const A = abcData.filter(x => x.cls === 'A');
    const B = abcData.filter(x => x.cls === 'B');
    const C = abcData.filter(x => x.cls === 'C');
    return `<h4>🥇 ABC Analysis (Pareto 80/20)</h4>
      <div class="grid grid-cols-3 gap-2 mt-2">
        <div class="text-center p-2 bg-emerald-500/10 rounded border border-emerald-500/20"><div class="text-xs text-emerald-400">A</div><div class="text-lg font-bold text-white">${A.length}</div></div>
        <div class="text-center p-2 bg-amber-500/10 rounded border border-amber-500/20"><div class="text-xs text-amber-400">B</div><div class="text-lg font-bold text-white">${B.length}</div></div>
        <div class="text-center p-2 bg-red-500/10 rounded border border-red-500/20"><div class="text-xs text-red-400">C</div><div class="text-lg font-bold text-white">${C.length}</div></div>
      </div>
      ${section('🏆 Top 8')}
      ${abcData.slice(0, 8).map(p => {
      const info = getRecipeInfo(p.rt);
      return kv(`#${p.rank} ${info.emoji} ${esc(p.name.length > 15 ? p.name.substring(0, 15) + '...' : p.name)} [${p.cls}]`, `${money(p.rev)} · ${p.revPct.toFixed(1)}%`, p.color);
    }).join('')}`;
  }

  // ============ SEASONAL ============
  function cmdSeasonal() {
    const d = getData();
    const sales = d.logs.filter(l => l.type === 'OUT');
    const dayRev = [0, 0, 0, 0, 0, 0, 0];
    sales.forEach(l => { dayRev[new Date(l.timestamp).getDay()] += Number(l.total); });
    const maxDay = Math.max(...dayRev) || 1;
    const hourBuckets = new Array(4).fill(0);
    sales.forEach(l => { hourBuckets[Math.floor(new Date(l.timestamp).getHours() / 6)] += Number(l.total); });
    const maxHour = Math.max(...hourBuckets) || 1;
    return `<h4>📅 Seasonal Analysis</h4>
      ${section('📅 ยอดขายตามวัน')}
      ${dayRev.map((v, i) => `<div class="mb-1"><div class="flex justify-between text-xs"><span>${DAYS[i]}</span><span class="${v === maxDay ? 'text-amber-400' : 'text-white'} font-bold">${money(v)}</span></div>${bar((v / maxDay) * 100, v === maxDay ? '#f59e0b' : '#8b5cf6')}</div>`).join('')}
      ${section('⏰ ยอดขายตามช่วงเวลา')}
      ${['00-06', '06-12', '12-18', '18-24'].map((label, i) => `<div class="mb-1"><div class="flex justify-between text-xs"><span>${label}</span><span class="${hourBuckets[i] === maxHour ? 'text-amber-400' : 'text-white'} font-bold">${money(hourBuckets[i])}</span></div>${bar((hourBuckets[i] / maxHour) * 100, hourBuckets[i] === maxHour ? '#f59e0b' : '#06b6d4')}</div>`).join('')}`;
  }

  // ============ BASKET ============
  function cmdBasket() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const bills = {};
    sales.forEach(l => {
      const key = new Date(l.timestamp).toISOString().slice(0, 16) + '_' + (l.note || '');
      if (!bills[key]) bills[key] = new Set();
      bills[key].add(l.productName);
    });
    const multi = Object.values(bills).filter(s => s.size >= 2);
    const pairs = {};
    multi.forEach(set => {
      const arr = Array.from(set);
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const key = [arr[i], arr[j]].sort().join(' + ');
          pairs[key] = (pairs[key] || 0) + 1;
        }
      }
    });
    const sortedPairs = Object.keys(pairs).sort((a, b) => pairs[b] - pairs[a]).slice(0, 8);
    return `<h4>🛒 Basket Analysis</h4>
      ${kv('บิลทั้งหมด', num(Object.keys(bills).length) + ' บิล')}
      ${kv('บิล 2+ รายการ', num(multi.length) + ' บิล', '#10b981')}
      ${kv('สัดส่วน', (Object.keys(bills).length > 0 ? ((multi.length / Object.keys(bills).length) * 100).toFixed(1) : 0) + '%')}
      ${section('🔗 คู่ที่ซื้อบ่อย')}
      ${sortedPairs.length > 0 ? sortedPairs.map((p, i) => kv(`${['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'][i]} ${esc(p)}`, pairs[p] + ' ครั้ง', '#a78bfa')).join('') : '<div class="text-xs text-gray-500">ไม่มีคู่ที่ซื้อซ้ำ</div>'}`;
  }

  // ============ COHORT ============
  function cmdCohort() {
    const d = getData();
    const sales = d.logs.filter(l => l.type === 'OUT');
    const byCust = {};
    sales.forEach(l => {
      if (l.note && l.note.trim().length < 50 && !l.note.includes('บันทึกผ่าน')) {
        const c = l.note.trim();
        if (!byCust[c]) byCust[c] = { first: Infinity, bills: [], total: 0 };
        const t = new Date(l.timestamp).getTime();
        if (t < byCust[c].first) byCust[c].first = t;
        byCust[c].bills.push({ date: new Date(l.timestamp), total: Number(l.total || 0) });
        byCust[c].total += Number(l.total || 0);
      }
    });
    const totalCust = Object.keys(byCust).length;
    const totalRev = Object.values(byCust).reduce((s, c) => s + c.total, 0);
    const avgCLV = totalCust > 0 ? totalRev / totalCust : 0;
    const returning = Object.values(byCust).filter(c => c.bills.length >= 2).length;
    const retentionRate = totalCust > 0 ? (returning / totalCust) * 100 : 0;
    return `<h4>📈 Cohort Analysis</h4>
      ${kv('👥 ลูกค้า', num(totalCust) + ' คน')}
      ${kv('💰 Avg CLV', money(avgCLV), '#10b981')}
      ${kv('🔄 Retention Rate', retentionRate.toFixed(1) + '%', retentionRate >= 30 ? '#10b981' : retentionRate >= 15 ? '#f59e0b' : '#ef4444')}
      ${kv('🎯 ลูกค้าซื้อซ้ำ', num(returning) + ' คน', '#3b82f6')}
      ${section('💡 Insights')}
      <div class="text-xs text-gray-300 leading-relaxed">${retentionRate >= 30 ? '✅ Retention ดีมาก' : retentionRate >= 15 ? '🟡 Retention ปานกลาง' : '⚠️ Retention ต่ำ'}</div>`;
  }

  // ============ FULL ANALYSIS ============
  function cmdFullAnalysis() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const exps = d.expenses.filter(e => new Date(e.timestamp) >= tda);
    const revenue = sales.reduce((s, l) => s + Number(l.total), 0);
    const expenses = exps.reduce((s, e) => s + Number(e.amount), 0);
    const volume = sales.reduce((s, l) => s + Number(l.qty), 0);
    const profit = revenue - expenses;
    const nm = revenue > 0 ? (profit / revenue) * 100 : 0;
    const velocity = volume / 30;
    let health = 50;
    if (nm > 30) health += 20; else if (nm > 15) health += 10; else if (nm < 0) health -= 20;
    if (velocity > 20) health += 15; else if (velocity > 10) health += 8;
    health = Math.max(0, Math.min(100, health));
    const grade = health >= 80 ? 'A' : health >= 65 ? 'B' : health >= 50 ? 'C' : 'D';
    const gColor = health >= 80 ? '#10b981' : health >= 65 ? '#3b82f6' : health >= 50 ? '#f59e0b' : '#ef4444';
    return `<h4>📊 รายงาน BI (30 วัน)</h4>
      <div class="text-center py-3"><div class="text-4xl font-black" style="color:${gColor}">${health}</div><div class="text-sm font-bold" style="color:${gColor}">เกรด ${grade}</div></div>
      ${kv('รายได้', money(revenue), '#10b981')}
      ${kv('รายจ่าย', money(expenses), '#ef4444')}
      ${kv('กำไร', money(profit), profit >= 0 ? '#f59e0b' : '#ef4444')}
      ${kv('ปริมาณ', num(volume) + ' ขวด')}
      ${kv('Net Margin', nm.toFixed(1) + '%')}
      ${kv('Velocity', velocity.toFixed(1) + ' ขวด/วัน')}`;
  }

  // ============ 🆕 NEW v1.0.2 — STOCK ALERT ============
  function cmdStockAlert() {
    const d = getData();
    const alerts = [];
    (d.products || []).forEach(p => {
      const s = getStock(p.name, p.id);
      if (s <= 5) alerts.push({ p, s });
    });
    if (alerts.length === 0) return `<h4>✅ Stock Alert</h4><div class="text-xs text-emerald-400 mt-2">สต๊อกทุกรายการเพียงพอ</div>`;
    let html = `<h4>⚠️ Stock Alert (${alerts.length} รายการ)</h4>`;
    alerts.forEach(a => {
      const info = getRecipeInfo(a.p.recipeType);
      const icon = a.s <= 0 ? '🚫' : '⚠️';
      const color = a.s <= 0 ? '#ef4444' : '#f59e0b';
      html += kv(`${icon} ${info.emoji} ${esc(a.p.name)}`, `${a.s} ขวด`, color);
    });
    return html;
  }

  // ============ 🆕 NEW v1.0.2 — RESTOCK ============
  function cmdRestock() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const recs = [];
    (d.products || []).forEach(p => {
      const stock = getStock(p.name, p.id);
      const vol = sales.filter(l => l.productName === p.name).reduce((s, l) => s + Number(l.qty), 0);
      const dailySales = vol / 30;
      const daysLeft = dailySales > 0 ? Math.floor(stock / dailySales) : 999;
      let recQty = 0;
      if (dailySales > 0 && daysLeft < 14) recQty = Math.ceil(dailySales * 30 - stock);
      if (recQty > 0) recs.push({ p, stock, dailySales, daysLeft, recQty });
    });
    if (recs.length === 0) return `<h4>✅ Restock</h4><div class="text-xs text-emerald-400 mt-2">ไม่มีสินค้าที่ต้องเติม</div>`;
    let html = `<h4>📦 Restock Recommendations</h4>`;
    recs.forEach(r => {
      const info = getRecipeInfo(r.p.recipeType);
      const color = r.daysLeft <= 3 ? '#ef4444' : r.daysLeft <= 7 ? '#f59e0b' : '#10b981';
      html += `<div class="mt-2 p-2 bg-black/30 rounded border border-white/5">
        <div class="flex justify-between text-xs mb-1">
          <span>${info.emoji} ${esc(r.p.name)}</span>
          <span style="color:${color};font-weight:bold">เหลือ ${r.daysLeft} วัน</span>
        </div>
        <div class="flex justify-between text-[10px]">
          <span class="text-gray-500">สต๊อก: ${r.stock} ขวด</span>
          <span class="text-emerald-400 font-bold">แนะนำเติม +${r.recQty} ขวด</span>
        </div>
      </div>`;
    });
    return html;
  }

  // ============ 🆕 NEW v1.0.2 — VELOCITY ============
  function cmdVelocity() {
    const d = getData();
    const now = new Date();
    const t7 = new Date(now.getTime() - 7 * 86400000);
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT');
    const vel = (d.products || []).map(p => {
      const v7 = sales.filter(l => l.productName === p.name && new Date(l.timestamp) >= t7).reduce((s, l) => s + Number(l.qty), 0);
      const v30 = sales.filter(l => l.productName === p.name && new Date(l.timestamp) >= t30).reduce((s, l) => s + Number(l.qty), 0);
      return { p, v7: v7 / 7, v30: v30 / 30 };
    }).filter(v => v.v7 > 0 || v.v30 > 0).sort((a, b) => b.v7 - a.v7);
    if (vel.length === 0) return `<h4>⚡ Velocity</h4><div class="text-xs text-gray-500 mt-2">ไม่มีข้อมูล</div>`;
    let html = `<h4>⚡ Sales Velocity</h4><div class="text-[10px] text-gray-500 mb-2">7 วัน / 30 วัน (ขวด/วัน)</div>`;
    vel.forEach(v => {
      const info = getRecipeInfo(v.p.recipeType);
      const trend = v.v7 > v.v30 * 1.1 ? '📈' : v.v7 < v.v30 * 0.9 ? '📉' : '➡️';
      const color = v.v7 > v.v30 ? '#10b981' : '#f59e0b';
      html += kv(`${trend} ${info.emoji} ${esc(v.p.name)}`, `${v.v7.toFixed(2)} / ${v.v30.toFixed(2)}`, color);
    });
    return html;
  }

  // ============ 🆕 NEW v1.0.2 — HEALTH ============
  function cmdHealth() {
    const d = getData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const month = statsInRange(d.logs, d.expenses, ms, now);
    const lm = getPeriodStats('lastMonth');
    let cogs = 0;
    d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms).forEach(l => {
      cogs += Number(l.qty) * getUnitCost(l.recipeType || 'RED');
    });
    const rev = month.rev, exp = month.exp;
    const nm = rev > 0 ? ((rev - exp) / rev) * 100 : 0;
    const gm = rev > 0 ? ((rev - cogs) / rev) * 100 : 0;
    const growth = lm.rev > 0 ? ((rev - lm.rev) / lm.rev) * 100 : 0;
    const profitScore = nm > 25 ? 25 : nm > 15 ? 20 : nm > 5 ? 15 : nm > 0 ? 10 : 0;
    const effScore    = gm > 60 ? 25 : gm > 45 ? 20 : gm > 30 ? 15 : gm > 15 ? 8 : 0;
    const growthScore = growth > 20 ? 25 : growth > 10 ? 20 : growth > 0 ? 15 : growth > -10 ? 8 : 0;
    const stabScore   = 25;
    const total = profitScore + effScore + growthScore + stabScore;
    const grade = total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : total >= 40 ? 'D' : 'F';
    const gColor = total >= 85 ? '#10b981' : total >= 70 ? '#3b82f6' : total >= 55 ? '#f59e0b' : '#ef4444';
    const dimBar = (label, score, max, color) =>
      `<div class="mb-2"><div class="flex justify-between text-xs mb-1"><span class="text-white">${label}</span><span style="color:${color};font-weight:bold">${score}/${max}</span></div>${bar((score/max)*100, color)}</div>`;
    return `<h4>🏥 Business Health</h4>
      <div class="text-center py-3"><div class="text-4xl font-black" style="color:${gColor}">${total}</div><div class="text-sm font-bold" style="color:${gColor}">เกรด ${grade}</div></div>
      ${dimBar('💰 Profitability', profitScore, 25, profitScore >= 20 ? '#10b981' : profitScore >= 10 ? '#f59e0b' : '#ef4444')}
      ${dimBar('⚡ Efficiency',   effScore,    25, effScore    >= 20 ? '#10b981' : effScore    >= 10 ? '#f59e0b' : '#ef4444')}
      ${dimBar('📈 Growth',       growthScore, 25, growthScore >= 20 ? '#10b981' : growthScore >= 10 ? '#f59e0b' : '#ef4444')}
      ${dimBar('🎯 Stability',    stabScore,   25, '#10b981')}`;
  }

  // ============ 🆕 NEW v1.0.2 — SCORECARD ============
  function cmdScorecard() {
    const d = getData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const m = statsInRange(d.logs, d.expenses, ms, now);
    const lm = getPeriodStats('lastMonth');
    const growth = lm.rev > 0 ? ((m.rev - lm.rev) / lm.rev) * 100 : 0;
    const nm = m.rev > 0 ? ((m.rev - m.exp) / m.rev) * 100 : 0;
    const velocity = m.vol / Math.max(1, now.getDate());
    const metrics = [
      { label: '📈 Revenue Growth', value: growth, target: 10, fmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%' },
      { label: '💰 Net Margin',     value: nm,     target: 20, fmt: v => v.toFixed(1) + '%' },
      { label: '⚡ Velocity',       value: velocity, target: 20, fmt: v => v.toFixed(1) }
    ];
    let html = `<h4>🏆 Business Scorecard</h4>`;
    metrics.forEach(m => {
      const pct = Math.min(100, (Math.max(0, m.value) / m.target) * 100);
      const color = pct >= 100 ? '#10b981' : pct >= 75 ? '#3b82f6' : pct >= 50 ? '#f59e0b' : '#ef4444';
      html += `<div class="mb-3">
        <div class="flex justify-between text-xs mb-1"><span class="text-white">${m.label}</span><span style="color:${color};font-weight:bold">${m.fmt(m.value)}</span></div>
        ${bar(pct, color)}
        <div class="text-[10px] text-gray-500 mt-0.5">เป้า: ${m.fmt(m.target)} · ${pct.toFixed(0)}%</div>
      </div>`;
    });
    return html;
  }

  // ============ 🆕 NEW v1.0.2 — EXECUTIVE ============
  function cmdExecutive() {
    const d = getData();
    const now = new Date();
    const month = getPeriodStats('thisMonth');
    const lm = getPeriodStats('lastMonth');
    const growth = lm.rev > 0 ? ((month.rev - lm.rev) / lm.rev) * 100 : 0;
    const nm = month.rev > 0 ? ((month.rev - month.exp) / month.rev) * 100 : 0;
    const velocity = month.vol / Math.max(1, now.getDate());
    const insights = [];
    if (growth > 10) insights.push('📈 ยอดขายเติบโต ' + growth.toFixed(1) + '%');
    else if (growth < -10) insights.push('📉 ยอดขายลดลง ' + Math.abs(growth).toFixed(1) + '%');
    if (nm > 30) insights.push('💎 กำไรดีมาก ' + nm.toFixed(1) + '%');
    else if (nm < 0) insights.push('🔴 ขาดทุน! ต้องแก้ไข');
    if (velocity > 20) insights.push('🚀 ขายเร็ว ' + velocity.toFixed(1) + ' ขวด/วัน');
    else if (velocity < 5) insights.push('🐌 ขายช้า ' + velocity.toFixed(1) + ' ขวด/วัน');
    let html = `<h4>👔 Executive Summary</h4>
      <div class="text-xs text-gray-400 mb-2">${fmtDate(now)}</div>
      <div class="text-2xl font-bold text-emerald-400">${money(month.rev)}</div>
      <div class="text-xs text-gray-400 mb-2">${growth >= 0 ? '📈 +' : '📉 '}${growth.toFixed(1)}% vs เดือนก่อน</div>
      ${kv('💰 กำไร', money(month.rev - month.exp), month.rev - month.exp >= 0 ? '#10b981' : '#ef4444')}
      ${kv('📊 Margin', nm.toFixed(1) + '%', nm > 20 ? '#10b981' : nm > 0 ? '#f59e0b' : '#ef4444')}
      ${kv('📦 ปริมาณ', num(month.vol) + ' ขวด')}
      ${kv('⚡ Velocity', velocity.toFixed(1) + '/วัน', '#f59e0b')}
      ${section('💡 Insights')}`;
    insights.forEach(i => { html += `<div class="text-xs text-gray-300 mt-1">${i}</div>`; });
    return html;
  }

  // ============ 🆕 NEW v1.0.2 — P&L ============
  function cmdPnL() {
    const d = getData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const logs = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const exps = d.expenses.filter(e => new Date(e.timestamp) >= ms);
    const rev = logs.reduce((s, l) => s + Number(l.total), 0);
    let cogs = 0;
    logs.forEach(l => { cogs += Number(l.qty) * getUnitCost(l.recipeType || 'RED'); });
    const exp = exps.reduce((s, e) => s + Number(e.amount), 0);
    const gp = rev - cogs;
    const np = gp - exp;
    const gm = rev > 0 ? (gp / rev) * 100 : 0;
    const nm = rev > 0 ? (np / rev) * 100 : 0;
    return `<h4>📊 Profit & Loss</h4>
      ${kv('💰 รายได้', money(rev), '#10b981')}
      ${kv('📉 COGS', '-' + money(cogs), '#ef4444')}
      ${kv('💵 กำไรขั้นต้น', money(gp), gp >= 0 ? '#10b981' : '#ef4444')}
      ${kv('   GM%', gm.toFixed(1) + '%', gm > 50 ? '#10b981' : '#f59e0b')}
      ${kv('💸 ค่าใช้จ่าย', '-' + money(exp), '#ef4444')}
      ${kv('🎯 กำไรสุทธิ', money(np), np >= 0 ? '#10b981' : '#ef4444')}
      ${kv('   NM%', nm.toFixed(1) + '%', nm > 20 ? '#10b981' : nm > 0 ? '#f59e0b' : '#ef4444')}`;
  }

  // ============ 🆕 NEW v1.0.2 — BREAK-EVEN ============
  function cmdBreakeven() {
    const d = getData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const logs = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const exps = d.expenses.filter(e => new Date(e.timestamp) >= ms);
    const rev = logs.reduce((s, l) => s + Number(l.total), 0);
    const vol = logs.reduce((s, l) => s + Number(l.qty), 0);
    let cogs = 0;
    logs.forEach(l => { cogs += Number(l.qty) * getUnitCost(l.recipeType || 'RED'); });
    const exp = exps.reduce((s, e) => s + Number(e.amount), 0);
    const avgPrice = vol > 0 ? rev / vol : 35;
    const avgCost = vol > 0 ? cogs / vol : 15;
    const cm = avgPrice - avgCost;
    const fixedCost = Math.max(0, exp - cogs);
    const beUnits = cm > 0 ? Math.ceil(fixedCost / cm) : 0;
    const beRev = beUnits * avgPrice;
    const mos = rev > 0 && beRev > 0 ? Math.max(0, ((rev - beRev) / rev) * 100) : 100;
    const mosColor = mos > 30 ? '#10b981' : mos > 10 ? '#f59e0b' : '#ef4444';
    return `<h4>⚖️ Break-Even</h4>
      <div class="text-center py-2"><div class="text-3xl font-black text-purple-400">${num(beUnits)} ขวด</div><div class="text-xs text-gray-500">จุดคุ้มทุน</div></div>
      ${kv('รายได้จุดคุ้มทุน', money(beRev), '#f59e0b')}
      ${kv('รายได้จริง', money(rev), '#10b981')}
      ${kv('Margin of Safety', mos.toFixed(1) + '%', mosColor)}
      ${kv('Contribution Margin', money(cm), '#10b981')}
      ${kv('Fixed Cost', money(fixedCost), '#ef4444')}`;
  }

  // ============ 🆕 NEW v1.0.2 — DEAD STOCK ============
  function cmdDeadStock() {
    const d = getData();
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const sales = d.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= tda);
    const dead = (d.products || []).filter(p => !sales.some(l => l.productName === p.name));
    if (dead.length === 0) return `<h4>✅ Dead Stock</h4><div class="text-xs text-emerald-400 mt-2">ไม่มี Dead Stock — สินค้าทุกตัวมียอดขายใน 30 วัน</div>`;
    let html = `<h4>💤 Dead Stock (${dead.length})</h4><div class="text-xs text-gray-400 mb-2">ขายไม่ออก 30 วัน</div>`;
    dead.forEach(p => {
      const info = getRecipeInfo(p.recipeType);
      const stock = getStock(p.name, p.id);
      html += kv(`${info.emoji} ${esc(p.name)}`, `${stock} ขวด`, '#ef4444');
    });
    return html;
  }

  // ============ 🆕 NEW v1.0.2 — CLV ============
  function cmdCLV() {
    const d = getData();
    const sales = d.logs.filter(l => l.type === 'OUT');
    const byCust = {};
    sales.forEach(l => {
      if (l.note && l.note.trim().length < 50 && !l.note.includes('บันทึกผ่าน')) {
        const c = l.note.trim();
        if (!byCust[c]) byCust[c] = { last: 0, first: Infinity, count: 0, total: 0 };
        const t = new Date(l.timestamp).getTime();
        if (t > byCust[c].last) byCust[c].last = t;
        if (t < byCust[c].first) byCust[c].first = t;
        byCust[c].count++;
        byCust[c].total += Number(l.total);
      }
    });
    const keys = Object.keys(byCust);
    if (keys.length === 0) return `<h4>💎 CLV</h4><div class="text-xs text-gray-500 mt-2">ไม่มีข้อมูลลูกค้า</div>`;
    const clv = keys.map(k => {
      const c = byCust[k];
      const months = Math.max(1, (c.last - c.first) / (30 * 86400000));
      return { name: k, clv: (c.total / c.count) * (c.count / months) * months, total: c.total };
    }).sort((a, b) => b.clv - a.clv);
    const avg = clv.reduce((s, c) => s + c.clv, 0) / clv.length;
    let html = `<h4>💎 Customer Lifetime Value</h4>
      ${kv('ลูกค้า', num(keys.length) + ' ราย')}
      ${kv('Avg CLV', money(avg), '#8b5cf6')}
      ${section('🏆 Top 5')}`;
    clv.slice(0, 5).forEach((c, i) => {
      html += kv(`${['🥇','🥈','🥉','4️⃣','5️⃣'][i]} ${esc(c.name)}`, money(c.clv), '#8b5cf6');
    });
    return html;
  }

  // ============ MAIN DISPATCHER ============
  function processCommand(text) {
    const raw = String(text || '').trim();
    if (!raw) return cmdHelp();
    const t = raw.toLowerCase();

    // Sale command
    const sale = parseSaleCommand(raw);
    if (sale) {
      try { return recordSale(sale); }
      catch (e) { return `<div class="text-red-400">❌ บันทึกไม่สำเร็จ: ${esc(e.message)}</div>`; }
    }

    // Date-like → help
    if (/^(วันนี้|พรุ่งนี้|เมื่อวาน|\d{1,2}[\/\-]\d{1,2})/.test(t)) {
      return `<div class="text-amber-400">❓ ไม่เข้าใจรายการขาย</div>
        <div class="text-xs text-gray-400 mt-2">รูปแบบ: วันนี้ ฝาแดง14 BM16 T4</div>
        <div class="text-xs text-gray-400">นามแฝง: 🔴 A/a · 🟡 BM/b · ⚪ T/t</div>`;
    }

    // ====== HELP ======
    if (['help', 'ช่วยเหลือ', 'เมนู', 'menu', '?', 'คำสั่ง'].includes(t)) return cmdHelp();
    if (['test', 'ทดสอบ', 'ping'].includes(t)) return `<h4>✅ ระบบทำงานปกติ</h4><div class="text-xs text-gray-400">${V}</div>`;

    // ====== SUMMARY ======
    if (['สรุป', 'summary', 'สรุปทั้งหมด', 'all', 'allinone', 'ภาพรวม', 'overview'].includes(t)) return cmdSummary();

    // ====== DASHBOARD ======
    if (['แดชบอร์ด', 'dashboard', 'สรุปภาพรวม'].includes(t)) return cmdDashboard();

    // ====== REPORTS ======
    if (['รายงาน', 'รายงานวันนี้', 'รายงานวัน', 'รายงานประจำวัน', 'daily', 'dailyreport', 'daily report'].includes(t)) return cmdDailyReport();
    if (['รายงานสัปดาห์', 'รายงานสัปดาห์นี้', 'รายงานรายสัปดาห์', 'weekly', 'weeklyreport', 'weekly report'].includes(t)) return cmdWeeklyReport();
    if (['รายงานเดือน', 'รายงานเดือนนี้', 'รายงานรายเดือน', 'monthly', 'monthlyreport', 'monthly report'].includes(t)) return cmdMonthlyReport();

    // ====== PERIODS ======
    if (['วันนี้', 'today'].includes(t)) return cmdSalesReport('today');
    if (['เมื่อวาน', 'yesterday'].includes(t)) return cmdSalesReport('yesterday');
    if (['7วัน', '7days'].includes(t)) return cmdSalesReport('7days');
    if (['เดือนนี้', 'month', 'thismonth'].includes(t)) return cmdSalesReport('thisMonth');

    // ====== FINANCE ======
    if (['กำไร', 'profit', 'ขาดทุน'].includes(t)) return cmdProfit();
    if (['ต้นทุน', 'cost', 'ค่าใช้จ่าย'].includes(t)) return cmdCost();
    if (['cashflow', 'กระแสเงินสด'].includes(t)) return cmdCashflow();
    if (['พยากรณ์เงิน', 'forecastcash', 'cashflowforecast'].includes(t)) return cmdCashflowForecast();

    // ====== PRODUCTS ======
    if (['สต๊อก', 'สต็อก', 'stock', 'inventory'].includes(t)) return cmdStock();
    if (['ท็อป', 'top', 'ขายดี'].includes(t)) return cmdTopProducts();
    if (['สินค้า', 'products', 'วิเคราะห์สินค้า'].includes(t)) return cmdProductAnalysis();
    if (t.startsWith('สินค้า ') || t.startsWith('product ')) {
      const name = raw.replace(/^(สินค้า|product)\s+/i, '').trim();
      return cmdProductDetail(name);
    }
    if (['สัดส่วนตลาด', 'marketshare', 'ส่วนแบ่ง'].includes(t)) return cmdMarketShare();

    // ====== KPI ======
    if (['kpi', 'ตัวชี้วัด'].includes(t)) return cmdKPI();
    if (['เป้าหมาย', 'target'].includes(t)) return cmdKPITarget();
    if (t.startsWith('ตั้งเป้า ') || t.startsWith('target ')) {
      return cmdSetTarget(raw.replace(/^(ตั้งเป้า|target)\s+/i, ''));
    }

    // ====== ANALYTICS ======
    if (['แนวโน้ม', 'trend'].includes(t)) return cmdTrend();
    if (['เปรียบเทียบ', 'compare'].includes(t)) return cmdCompare();
    if (['พยากรณ์', 'forecast'].includes(t)) return cmdForecast();
    if (['วิเคราะห์', 'analysis', 'bi', 'รายงาน bi'].includes(t)) return cmdFullAnalysis();
    if (['ลูกค้า', 'customer', 'บิล'].includes(t)) return cmdCustomer();

    // ====== ADVANCED ======
    if (['ประสิทธิภาพ', 'saleskpi', 'sales kpi', 'sales-kpi', 'skpi'].includes(t)) return cmdSalesKPIs();
    if (['ตัวชี้วัดธุรกิจ', 'ตัวชี้วัด', 'businesskpi', 'business kpi', 'business-kpi', 'bkpi', 'kpi2'].includes(t)) return cmdBusinessKPIs();
    if (['วิเคราะห์เชิงลึก', 'deep', 'deepanalysis', 'deep-analysis', 'เจาะลึก'].includes(t)) return cmdDeepAnalysis();
    if (['rfm', 'จัดกลุ่มลูกค้า', 'แบ่งกลุ่มลูกค้า'].includes(t)) return cmdRFM();
    if (['abc', 'abc analysis', 'พาเรโต', 'pareto'].includes(t)) return cmdABC();
    if (['seasonal', 'seasonality', 'ฤดูกาล', 'ตามเดือน'].includes(t)) return cmdSeasonal();
    if (['basket', 'market basket', 'ตะกร้า', 'ซื้อคู่'].includes(t)) return cmdBasket();
    if (['cohort', 'cohort analysis', 'retention', 'ลูกค้าใหม่'].includes(t)) return cmdCohort();

    // ====== 🆕 NEW v1.0.2 — Quick chips + extras ======
    if (['stockalert', 'stock alert', 'แจ้งเตือนสต๊อก', 'สต๊อกต่ำ', 'alert'].includes(t)) return cmdStockAlert();
    if (['restock', 'restock rec', 'ควรเติม', 'แนะนำเติม'].includes(t)) return cmdRestock();
    if (['velocity', 'sales velocity', 'ความเร็วขาย', 'ความเร็ว'].includes(t)) return cmdVelocity();
    if (['scorecard', 'score', 'คะแนน'].includes(t)) return cmdScorecard();
    if (['health', 'healthcheck', 'business health', 'สุขภาพธุรกิจ'].includes(t)) return cmdHealth();
    if (['executive', 'executive summary', 'สรุปผู้บริหาร'].includes(t)) return cmdExecutive();
    if (['pnl', 'p&l', 'กำไรขาดทุน', 'งบกำไรขาดทุน'].includes(t)) return cmdPnL();
    if (['breakeven', 'break-even', 'be', 'จุดคุ้มทุน'].includes(t)) return cmdBreakeven();
    if (['deadstock', 'dead stock', 'สินค้าค้าง', 'สินค้าขายไม่ออก', 'dead'].includes(t)) return cmdDeadStock();
    if (['clv', 'ltv', 'customer lifetime value', 'มูลค่าลูกค้า'].includes(t)) return cmdCLV();

    return `<div class="text-amber-400">❓ ไม่รู้จักคำสั่ง: "${esc(text)}"</div>
      <div class="text-xs text-gray-400 mt-2">พิมพ์ <span class="text-emerald-400 font-mono">ช่วยเหลือ</span> เพื่อดูทั้งหมด</div>`;
  }

  // ============ BOOT ============
  function boot() {
    if (!document.getElementById('wc-styles')) {
      const s = document.createElement('style');
      s.id = 'wc-styles';
      s.textContent = `
        .kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed rgba(255,255,255,.05);font-size:12px;gap:8px}
        .kv:last-child{border-bottom:none}
        .kv-label{color:#9ca3af;flex:1}
        .kv-value{color:#fff;font-weight:700;text-align:right}
        .bar{height:4px;background:rgba(255,255,255,.05);border-radius:999px;overflow:hidden;margin:4px 0}
        .bar-fill{height:100%;border-radius:999px;transition:width .3s}
      `;
      document.head.appendChild(s);
    }
    console.log('%c🍃 Web Console ' + V + ' ready', 'color:#10b981;font-weight:bold;font-size:14px');
    console.log('%c✓ 47+ commands · real-time stock · 10 new commands', 'color:#6ee7b7;font-size:11px');
  }

  // ============ EXPORT ============
  window.WebConsole = {
    version: V,
    processCommand: processCommand,
    parseSaleCommand: parseSaleCommand,
    recordSale: recordSale,
    cmdHelp: cmdHelp,
    boot: boot,
    // Existing
    cmdStockAlert: cmdStockAlert,
    cmdRestock: cmdRestock,
    cmdVelocity: cmdVelocity,
    cmdHealth: cmdHealth,
    cmdScorecard: cmdScorecard,
    cmdExecutive: cmdExecutive,
    cmdPnL: cmdPnL,
    cmdBreakeven: cmdBreakeven,
    cmdDeadStock: cmdDeadStock,
    cmdCLV: cmdCLV,
    // Debug helpers
    _getData: getData,
    _refreshUI: refreshUI,
    _getApiUrl: getApiUrl,
    _getStock: getStock
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
