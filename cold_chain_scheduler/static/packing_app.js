/* ============================================================
 * 大件货品智能配载 - 前端逻辑 v2
 * 功能：车队配置（多车）、多车厢自动分配、3D 可视化、
 *       车辆切换、装卸顺序单（后装先卸）、Excel 导入、CSV 导出
 * ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

(() => {
'use strict';

const $ = (sel) => document.querySelector(sel);

let items = [];          // 货物清单
let fleet = [];          // 车队 [{id,name,l,w,h,max_weight,qty}]
let lastFleetResult = null; // solveFleet 结果
let currentVehicleIdx = 0;  // 当前查看的车辆索引
let currentView = '3d';
let routeData = null;    // 配送路线 { routes: [{ vehicle_name, stops: [{name, ...}] }] }
let scene = null, camera = null, renderer = null, controls = null;
let boxMeshes = [];

const COLOR_PALETTE = [
  '#0e7fd4', '#00a8a8', '#e67e22', '#9b59b6', '#e74c3c', '#27ae60',
  '#f39c12', '#2980b9', '#8e44ad', '#16a085', '#d35400', '#2c3e50',
];

// ---------- 工具 ----------
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function uid() { return 'it_' + Math.random().toString(36).slice(2, 9); }
function uidV() { return 'vh_' + Math.random().toString(36).slice(2, 9); }
function num(v, def = 0) { const n = parseFloat(v); return isNaN(n) ? def : n; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// 车队管理
// ============================================================
function renderFleet() {
  const list = $('#fleetList');
  list.innerHTML = '';
  fleet.forEach((v, idx) => {
    const zones = v.temp_zones && v.temp_zones.length ? v.temp_zones : ['cold', 'normal'];
    const zoneChk = (z) => zones.includes(z) ? 'checked' : '';
    const card = document.createElement('div');
    card.className = 'fleet-card';
    card.innerHTML = `
      <div class="fleet-card-head">
        <input class="fv-name" value="${esc(v.name)}" placeholder="车辆名称">
        <span style="display:flex;gap:6px">
          <span style="font-size:11px;color:#8ba0b5">数量</span>
          <input class="fv-qty" type="number" value="${v.qty}" min="1" style="width:52px;border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px">
          <button class="btn-mini fv-del" style="color:#d9534f">✕</button>
        </span>
      </div>
      <div class="fleet-grid">
        <label>长L (cm)<input class="fv-l" type="number" value="${v.l}" min="1"></label>
        <label>宽W (cm)<input class="fv-w" type="number" value="${v.w}" min="1"></label>
        <label>高H (cm)<input class="fv-h" type="number" value="${v.h}" min="1"></label>
        <label>载重 (kg)<input class="fv-wt" type="number" value="${v.max_weight}" min="1"></label>
        <div style="grid-column:1/-1" class="fv-zones">
          <span style="font-size:11px;color:#8ba0b5">温区：</span>
          <label style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px"><input type="checkbox" class="fz fz-frozen" ${zoneChk('frozen')}>冷冻-18℃</label>
          <label style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px"><input type="checkbox" class="fz fz-cold" ${zoneChk('cold')}>冷藏2~8℃</label>
          <label style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px"><input type="checkbox" class="fz fz-normal" ${zoneChk('normal')}>常温</label>
        </div>
      </div>`;
    list.appendChild(card);

    card.querySelector('.fv-name').addEventListener('change', e => { v.name = e.target.value.trim() || '车辆'; });
    card.querySelector('.fv-qty').addEventListener('change', e => { v.qty = Math.max(1, Math.floor(num(e.target.value, 1))); });
    card.querySelector('.fv-l').addEventListener('change', e => { v.l = Math.max(1, num(e.target.value, 420)); });
    card.querySelector('.fv-w').addEventListener('change', e => { v.w = Math.max(1, num(e.target.value, 210)); });
    card.querySelector('.fv-h').addEventListener('change', e => { v.h = Math.max(1, num(e.target.value, 210)); });
    card.querySelector('.fv-wt').addEventListener('change', e => { v.max_weight = Math.max(1, num(e.target.value, 3000)); });
    const syncZones = () => {
      const zs = [];
      if (card.querySelector('.fz-frozen').checked) zs.push('frozen');
      if (card.querySelector('.fz-cold').checked) zs.push('cold');
      if (card.querySelector('.fz-normal').checked) zs.push('normal');
      v.temp_zones = zs.length ? zs : ['cold', 'normal'];
    };
    card.querySelectorAll('.fz').forEach(cb => cb.addEventListener('change', syncZones));
    card.querySelector('.fv-del').addEventListener('click', () => {
      fleet.splice(idx, 1);
      renderFleet();
    });
  });
}

function addVehicle() {
  fleet.push({
    id: uidV(), name: `厢式货车${fleet.length + 1}`,
    l: 420, w: 210, h: 210, max_weight: 3000, qty: 1,
    temp_zones: ['cold', 'normal'],
  });
  renderFleet();
}

function fleetToContainerList() {
  const list = [];
  fleet.forEach(v => {
    const qty = Math.max(1, Math.floor(v.qty) || 1);
    for (let k = 0; k < qty; k++) {
      list.push({
        id: v.id + '_' + k, name: `${v.name}#${k + 1}`,
        l: v.l, w: v.w, h: v.h, max_weight: v.max_weight,
        temp_zones: v.temp_zones && v.temp_zones.length ? v.temp_zones : undefined,
      });
    }
  });
  return list;
}

// ============================================================
// 货物表格
// ============================================================
function renderItems() {
  const tbody = $('#itemsBody');
  tbody.innerHTML = '';
  items.forEach((it, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = idx;
    tr.innerHTML = `
      <td><input class="f-name" value="${esc(it.name)}" placeholder="货品名"></td>
      <td><input class="f-l" type="number" value="${it.l}" min="1"></td>
      <td><input class="f-w" type="number" value="${it.w}" min="1"></td>
      <td><input class="f-h" type="number" value="${it.h}" min="1"></td>
      <td><input class="f-wt" type="number" value="${it.weight}" min="0"></td>
      <td><input class="f-qty" type="number" value="${it.qty}" min="1"></td>
      <td style="text-align:center"><input class="f-rot" type="checkbox" ${it.canRotate ? 'checked' : ''}></td>
      <td><input class="f-stack" type="number" value="${it.maxStack !== Infinity ? it.maxStack : ''}" placeholder="不限"></td>
      <td><input class="f-stop" value="${esc(it.stop || '')}" placeholder="站点名（可选）"></td>
      <td>
        <select class="f-temp" title="温层">
          <option value="frozen" ${it.tempClass === 'frozen' ? 'selected' : ''}>🧊冷冻</option>
          <option value="cold" ${(!it.tempClass || it.tempClass === 'cold') ? 'selected' : ''}>❄️冷藏</option>
          <option value="normal" ${it.tempClass === 'normal' ? 'selected' : ''}>☀️常温</option>
        </select>
      </td>
      <td style="text-align:center">
        <span class="color-dot" style="background:${it.color}"></span>
        <button class="btn-mini del-btn" style="color:#d9534f">✕</button>
      </td>`;
    tbody.appendChild(tr);
  });
  $$('.del-btn').forEach(btn => btn.addEventListener('click', (e) => {
    const idx = parseInt(e.target.closest('tr').dataset.idx, 10);
    items.splice(idx, 1);
    renderItems();
  }));
  $$('#itemsBody tr').forEach(tr => {
    const idx = parseInt(tr.dataset.idx, 10);
    const it = items[idx];
    const bind = (sel, key, fn) => {
      const el = tr.querySelector(sel);
      if (!el) return;
      el.addEventListener('change', () => { it[key] = fn(el); });
    };
    bind('.f-name', 'name', el => el.value.trim() || '货品');
    bind('.f-l', 'l', el => Math.max(1, num(el.value, 1)));
    bind('.f-w', 'w', el => Math.max(1, num(el.value, 1)));
    bind('.f-h', 'h', el => Math.max(1, num(el.value, 1)));
    bind('.f-wt', 'weight', el => Math.max(0, num(el.value, 0)));
    bind('.f-qty', 'qty', el => Math.max(1, Math.floor(num(el.value, 1))));
    bind('.f-stack', 'maxStack', el => el.value.trim() === '' ? Infinity : Math.max(0, num(el.value, 0)));
    bind('.f-stop', 'stop', el => el.value.trim());
    bind('.f-temp', 'tempClass', el => el.value);
    tr.querySelector('.f-rot').addEventListener('change', (e) => { it.canRotate = e.target.checked; });
  });
}

function addItem() {
  items.push({
    id: uid(), name: '新货品', l: 100, w: 80, h: 60,
    weight: 50, qty: 1, canRotate: true, tempClass: 'cold',
    maxStack: Infinity, color: COLOR_PALETTE[items.length % COLOR_PALETTE.length],
  });
  renderItems();
}

function loadDemoItems() {
  items = [
    { id: uid(), name: '对开门冰箱', l: 90, w: 75, h: 190, weight: 95, qty: 2, canRotate: false, maxStack: 300, color: '#0e7fd4', type: '家电', stop: '站点A', tempClass: 'normal' },
    { id: uid(), name: '立式空调', l: 50, w: 40, h: 175, weight: 55, qty: 2, canRotate: false, maxStack: 200, color: '#00a8a8', type: '家电', stop: '站点B', tempClass: 'normal' },
    { id: uid(), name: '滚筒洗衣机', l: 60, w: 60, h: 85, weight: 70, qty: 3, canRotate: true, maxStack: 150, color: '#e67e22', type: '家电', stop: '站点C', tempClass: 'normal' },
    { id: uid(), name: '医疗器械箱', l: 80, w: 60, h: 60, weight: 120, qty: 3, canRotate: true, maxStack: 500, color: '#9b59b6', type: '医疗', stop: '站点A', tempClass: 'cold' },
    { id: uid(), name: '标准托盘货', l: 120, w: 100, h: 150, weight: 200, qty: 2, canRotate: false, maxStack: 800, color: '#27ae60', type: '托盘', stop: '站点B', tempClass: 'normal' },
    { id: uid(), name: '冷链保温箱', l: 65, w: 45, h: 40, weight: 15, qty: 6, canRotate: true, maxStack: 200, color: '#16a085', type: '冷链', stop: '站点C', tempClass: 'cold' },
  ];
  renderItems();
  toast('✅ 已载入 6 类示例货品（共 18 件，含配送站点与温层）', 'ok');
}

function loadDemoFleet() {
  fleet = [
    { id: uidV(), name: '4.2米厢式货车', l: 420, w: 210, h: 210, max_weight: 3000, qty: 2, temp_zones: ['cold', 'normal'] },
  ];
  renderFleet();
}

// ============================================================
// Excel 导入（货物）
// ============================================================
function handleExcel(file) {
  if (typeof XLSX === 'undefined') { toast('Excel 解析库未加载（需联网）', 'err'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
      if (!rows.length) throw new Error('Excel 无数据');
      const newItems = [];
      rows.forEach(r => {
        const name = r['名称'] || r['货品名称'] || r['品名'];
        if (!name) return;
        const l = parseFloat(r['长cm'] ?? r['长'] ?? 0);
        const w = parseFloat(r['宽cm'] ?? r['宽'] ?? 0);
        const h = parseFloat(r['高cm'] ?? r['高'] ?? 0);
        if (!l || !w || !h) return;
        newItems.push({
          id: uid(), name: String(name), l, w, h,
          weight: parseFloat(r['重量kg'] ?? r['重量'] ?? 0) || 0,
          qty: Math.max(1, parseInt(r['数量'] ?? 1, 10) || 1),
          canRotate: String(r['可旋转'] ?? '是').includes('是') || String(r['可旋转'] ?? 'true').toLowerCase() === 'true',
          maxStack: (() => { const s = parseFloat(r['承重kg'] ?? r['承重'] ?? ''); return isNaN(s) ? Infinity : s; })(),
          color: COLOR_PALETTE[(items.length + newItems.length) % COLOR_PALETTE.length],
          type: r['类型'] || '普通',
        });
      });
      if (!newItems.length) throw new Error('未识别到有效货品行（需包含 名称/长/宽/高 列）');
      items = items.concat(newItems);
      renderItems();
      toast(`✅ 已导入 ${newItems.length} 类货品`, 'ok');
    } catch (err) {
      toast('导入失败: ' + err.message, 'err');
    }
  };
  reader.readAsArrayBuffer(file);
}

// ============================================================
// OrderStore 集成：直读调度页保存的路线（免 JSON 搬运）
// ============================================================
function loadRoutesFromStore(silent) {
  if (typeof OrderModel === 'undefined') {
    if (!silent) toast('❌ OrderModel 未加载', 'err');
    return false;
  }
  const saved = OrderStore.getRoutes();
  if (!saved || !saved.routes || !saved.routes.length) {
    if (!silent) toast('📭 暂无调度结果（请先在「智能调度」页执行求解）', 'err');
    return false;
  }
  // 归一化为 routeData（与 handleRouteFile 相同结构）
  const norm = saved.routes.map(r => ({
    vehicle_name: `车辆${r.vehicle_id} ${r.plate}`,
    plate: r.plate,
    stops: r.stops.map(s => s.name),
    temp_zones: r.temp_zones,
    temp_label: r.temp_label,
  }));
  routeData = {
    schedule_date: saved.summary && saved.summary.schedule_date,
    savedAt: OrderStore.savedAt(),
    routes: norm,
  };
  if (lastFleetResult) renderCurrentVehicle();
  if (!silent) {
    const when = routeData.savedAt ? new Date(routeData.savedAt).toLocaleString('zh-CN') : '';
    toast(`✅ 已读取调度结果：${norm.length} 条路线（${when || saved.summary.schedule_date}），配载将按站点顺序装车`, 'ok');
  }
  return true;
}

// ============================================================
// 配载求解（多车）
// ============================================================
function doPack() {
  if (!items.length) { toast('请先添加货品', 'err'); return; }
  if (!fleet.length) { toast('请先配置车队', 'err'); return; }
  const containers = fleetToContainerList();
  const strategy = $('#strategy') ? $('#strategy').value : 'volume';

  // 路线站点顺序 → 车辆名映射（stop-aware 装箱 + 站点感知分配）
  const routeStops = {};
  if (routeData && routeData.routes) {
    routeData.routes.forEach(r => {
      if (r.stops && r.stops.length) routeStops[r.vehicle_name] = r.stops;
    });
  }

  $('#packBtn').disabled = true;
  $('#packBtn').textContent = '⏳ 配载中...';
  $('#progressWrap').hidden = false;
  let p = 0;
  const timer = setInterval(() => {
    p = Math.min(p + 25, 90);
    $('#progressFill').style.width = p + '%';
  }, 120);

  setTimeout(() => {
    clearInterval(timer);
    try {
      const t0 = performance.now();
      const result = PackingSolver.solveFleet(containers, items, {
        strategy,
        routeStops: Object.keys(routeStops).length ? routeStops : undefined,
      });
      result.solve_ms = Math.round(performance.now() - t0);
      lastFleetResult = result;
      currentVehicleIdx = 0;
      renderFleetResult(result);
      const un = result.stats.unpacked_items;
      const tempRej = result.vehicles.reduce((a, v) => a + (v.result ? (v.result.stats.temp_rejected_count || 0) : 0), 0);
      let msg = `✅ 配载完成：${result.stats.packed_items}/${result.stats.total_items} 件装入 ${result.stats.used_vehicles} 辆车`;
      if (tempRej) msg += `，${tempRej} 件温层不符被拒装`;
      if (un) msg += `，${un} 件未装`;
      toast(msg, un || tempRej ? 'err' : 'ok');
    } catch (e) {
      toast('❌ 配载失败: ' + e.message, 'err');
    } finally {
      $('#packBtn').disabled = false;
      $('#packBtn').textContent = '🧊 一键智能配载';
      $('#progressWrap').hidden = true;
      $('#progressFill').style.width = '0%';
    }
  }, 50);
}

// ============================================================
// 结果渲染
// ============================================================
function renderFleetResult(r) {
  const s = r.stats;
  $('#kpiRow').hidden = false;
  $('#kPacked').textContent = s.packed_items + '/' + s.total_items;
  $('#kVolRate').textContent = s.volume_rate + '%';
  // 加权重量率
  let totalCapW = 0, totalW = 0;
  r.vehicles.forEach(v => {
    if (v.result) { totalCapW += v.vehicle.max_weight; totalW += v.result.stats.total_weight; }
  });
  $('#kWtRate').textContent = totalCapW ? Math.round(totalW / totalCapW * 1000) / 10 + '%' : '-';
  $('#kLayers').textContent = Math.max(...r.vehicles.map(v => v.result ? v.result.stats.layers : 0));
  $('#kVehUsed').textContent = s.used_vehicles + '/' + s.fleet_size;
  $('#kUnpacked').textContent = s.unpacked_items;

  $('#viewerCard').hidden = false;
  $('#emptyState').hidden = true;

  // 车辆切换 chips
  $('#vehSwitchCard').hidden = false;
  const chips = $('#vehChips');
  chips.innerHTML = '';
  r.vehicles.forEach((v, i) => {
    const res = v.result;
    const chip = document.createElement('div');
    chip.className = 'veh-chip' + (i === currentVehicleIdx ? ' active' : '');
    const loaded = res ? res.stats.packed_count : 0;
    const rate = res ? res.stats.volume_rate : 0;
    const tempTag = res && res.stats.stop_aware ? ' · 🗺️按站装车' : '';
    const tempRej = res && res.stats.temp_rejected_count ? ` · 🚫温层拒装${res.stats.temp_rejected_count}` : '';
    chip.innerHTML = `${esc(v.vehicle.name)}<small>${loaded} 件 · ${rate}%${res && res.reason === 'no_items' ? ' · 未使用' : ''}${tempTag}${tempRej}</small>`;
    chip.addEventListener('click', () => {
      currentVehicleIdx = i;
      renderCurrentVehicle();
      chips.querySelectorAll('.veh-chip').forEach((c, ci) => c.classList.toggle('active', ci === i));
    });
    chips.appendChild(chip);
  });

  // 未装清单（全部车辆装不下的）
  const ub = $('#unpackedBox');
  if (r.unpacked && r.unpacked.length) {
    ub.hidden = false;
    $('#unpackedList').innerHTML = r.unpacked.map(u =>
      `<div class="un-item">🔺 ${esc(u.name)} × ${u.qty}（${u.l}×${u.w}×${u.h}cm / ${u.weight}kg）</div>`).join('');
  } else {
    ub.hidden = true;
  }

  renderCurrentVehicle();
}

function getCurrentVehicle() {
  if (!lastFleetResult) return null;
  return lastFleetResult.vehicles[currentVehicleIdx] || null;
}

function renderCurrentVehicle() {
  const v = getCurrentVehicle();
  if (!v || !v.result) return;
  const r = v.result;
  $('#viewTitle').textContent = `｜ ${v.vehicle.name}（${v.vehicle.l}×${v.vehicle.w}×${v.vehicle.h}cm）`;
  renderLoadList(r);
  renderOrders(r);
  render3D(r);
  setView(currentView);
}

// ---------- 装载清单 ----------
function renderLoadList(r) {
  const list = $('#loadList');
  list.innerHTML = '';
  r.boxes.forEach((b, i) => {
    const div = document.createElement('div');
    div.className = 'load-item';
    div.innerHTML = `
      <div class="li-head">
        <span><span class="color-dot" style="background:${b.color || '#999'}"></span>${esc(b.name)}</span>
        <span style="color:#5b6f84">#${i + 1}</span>
      </div>
      <div class="li-dim">
        尺寸: ${b.l} × ${b.w} × ${b.h} cm<br>
        位置: X=${b.x} Y=${b.y} Z=${b.z}<br>
        重量: ${b.item.weight} kg
      </div>`;
    list.appendChild(div);
  });
}

// ---------- 装卸顺序单（支持配送路线联动） ----------
// 获取当前车辆的站点访问顺序（若有路线数据）
function getStopOrderForVehicle(vehicleName) {
  if (!routeData || !routeData.routes || !routeData.routes.length) return null;
  // 匹配车辆名（模糊匹配：车辆名包含或包含于）
  const r = routeData.routes.find(rt =>
    (rt.vehicle_name && (rt.vehicle_name === vehicleName ||
      rt.vehicle_name.includes(vehicleName) || vehicleName.includes(rt.vehicle_name))) ||
    (rt.vehicle && (rt.vehicle === vehicleName ||
      rt.vehicle.includes(vehicleName) || vehicleName.includes(rt.vehicle)))
  );
  if (!r || !r.stops || !r.stops.length) return null;
  // stops 可能是字符串数组或对象数组
  return r.stops.map(s => (typeof s === 'string' ? s : (s.name || s.stop_name || '')));
}

// 计算卸货顺序：优先按站点访问顺序（先到先卸），站点内按"后装先卸+上层先卸"
function computeUnloadOrderWithStops(boxes, stopOrder) {
  // 若没有站点信息或路线，退回纯物理顺序（上层先卸）
  if (!stopOrder || !stopOrder.length) {
    return computeUnloadOrderPhysical(boxes);
  }
  // 站点访问顺序 map: 站点名 -> 优先级（越小越先卸）
  const stopPrio = {};
  stopOrder.forEach((s, i) => { if (s) stopPrio[s] = i; });
  const hasStopInfo = boxes.some(b => b.item.stop && stopPrio[b.item.stop] !== undefined);
  if (!hasStopInfo) return computeUnloadOrderPhysical(boxes);

  // 按站点优先级分组
  const byStop = {};
  boxes.forEach(b => {
    const stop = b.item.stop || '';
    const key = stopPrio[stop] !== undefined ? stop : '__tail__';
    if (!byStop[key]) byStop[key] = [];
    byStop[key].push(b);
  });
  // 站点排序：有优先级的按访问顺序，未知站点放最后
  const orderedStops = Object.keys(byStop).sort((a, b) => {
    if (a === '__tail__') return 1;
    if (b === '__tail__') return -1;
    return stopPrio[a] - stopPrio[b];
  });
  // 每个站点内部按物理顺序（上层先卸）
  const unloadOrder = [];
  orderedStops.forEach(stop => {
    const siteBoxes = byStop[stop];
    computeUnloadOrderPhysical(siteBoxes).forEach(b => unloadOrder.push(b));
  });
  return unloadOrder;
}

// 纯物理卸货顺序：迭代取"无上方阻挡"货品（上层先卸）
function computeUnloadOrderPhysical(boxes) {
  const remaining = boxes.slice();
  const order = [];
  while (remaining.length) {
    let found = null, foundIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      const b = remaining[i];
      let blocked = false;
      for (const o of remaining) {
        if (o === b) continue;
        const ox = Math.max(0, Math.min(b.x + b.l, o.x + o.l) - Math.max(b.x, o.x));
        const oz = Math.max(0, Math.min(b.z + b.w, o.z + o.w) - Math.max(b.z, o.z));
        if (o.y >= b.y + b.h - 1e-6 && ox > 1 && oz > 1) { blocked = true; break; }
      }
      if (!blocked) { found = b; foundIdx = i; break; }
    }
    if (!found) { found = remaining[0]; foundIdx = 0; }
    order.push(found);
    remaining.splice(foundIdx, 1);
  }
  return order;
}

function renderOrders(r) {
  const loadList = $('#loadOrderList');
  const unloadList = $('#unloadOrderList');
  loadList.innerHTML = '';
  unloadList.innerHTML = '';

  const veh = getCurrentVehicle();
  const vehicleName = veh ? veh.vehicle.name : '';
  const stopOrder = getStopOrderForVehicle(vehicleName);

  // 装车顺序：先装后到站点的货品（便于后装先卸）→ 按站点访问顺序倒序
  const loadOrder = [];
  if (stopOrder && stopOrder.length) {
    const stopPrio = {};
    stopOrder.forEach((s, i) => { if (s) stopPrio[s] = i; });
    const hasStopInfo = r.boxes.some(b => b.item.stop && stopPrio[b.item.stop] !== undefined);
    if (hasStopInfo) {
      // 按站点优先级倒序（后访问的站点先装，放最里面）
      const byStop = {};
      r.boxes.forEach(b => {
        const stop = b.item.stop || '';
        const key = stopPrio[stop] !== undefined ? stop : '__tail__';
        if (!byStop[key]) byStop[key] = [];
        byStop[key].push(b);
      });
      const orderedStops = Object.keys(byStop).sort((a, b) => {
        if (a === '__tail__') return -1;
        if (b === '__tail__') return 1;
        return stopPrio[a] - stopPrio[b];
      });
      orderedStops.reverse(); // 倒序装车
      orderedStops.forEach(stop => {
        byStop[stop].forEach(b => loadOrder.push(b));
      });
    } else {
      r.boxes.forEach(b => loadOrder.push(b));
    }
  } else {
    r.boxes.forEach(b => loadOrder.push(b));
  }

  const unloadOrder = computeUnloadOrderWithStops(r.boxes, stopOrder);

  loadOrder.forEach((b, i) => {
    const stopTag = b.item.stop ? `<span style="color:#0e7fd4;font-size:10.5px">→ ${esc(b.item.stop)}</span>` : '';
    const li = document.createElement('li');
    li.innerHTML = `<b>${esc(b.name)}</b> ${stopTag} <span class="o-dim">${b.l}×${b.w}×${b.h}cm / ${b.item.weight}kg / 位置X${b.x} Y${b.y} Z${b.z}</span>`;
    loadList.appendChild(li);
  });
  unloadOrder.forEach((b, i) => {
    const stopTag = b.item.stop ? `<span style="color:#e67e22;font-size:10.5px">→ ${esc(b.item.stop)}</span>` : '';
    const li = document.createElement('li');
    li.innerHTML = `<b>${esc(b.name)}</b> ${stopTag} <span class="o-dim">${b.l}×${b.w}×${b.h}cm / 位置X${b.x} Y${b.y} Z${b.z}</span>`;
    unloadList.appendChild(li);
  });

  // 显示路线联动提示 + 站点深度报告
  const orderHead = document.querySelector('.order-head');
  if (orderHead) {
    const hint = document.getElementById('routeLinkHint');
    if (hint) hint.remove();
    const d = document.createElement('div');
    d.id = 'routeLinkHint';
    d.style.cssText = 'font-size:11px;color:#0e7fd4;margin-bottom:8px;';
    let text = '';
    if (stopOrder && stopOrder.length) {
      text = `🗺️ 已联动配送路线（${vehicleName}）：${stopOrder.join(' → ')}，卸货按站点顺序自动排序`;
    } else if (routeData) {
      text = '🗺️ 已导入路线但未匹配到当前车辆或站点，使用物理顺序';
    }
    d.textContent = text;
    orderHead.appendChild(d);

    // stopReport：各站点区块深度 + 物理阻挡违规
    const sr = r.stopReport;
    const oldRep = document.getElementById('stopReportBox');
    if (oldRep) oldRep.remove();
    if (sr && sr.enabled && sr.stops.length) {
      const rep = document.createElement('div');
      rep.id = 'stopReportBox';
      rep.style.cssText = 'font-size:11px;color:#5b6f84;margin-bottom:8px;background:#f0f7ff;border-radius:6px;padding:8px 10px;';
      const rows = sr.stops.map(s =>
        `<span style="display:inline-block;margin:2px 8px 2px 0">${s.stop ? esc(s.stop) : '(未知站点)'}：${s.count}件 · 深度${s.depth_pct}%</span>`
      ).join('');
      const viol = sr.violations
        ? `<div style="color:#b57410;margin-top:4px">⚠️ ${sr.violations} 处物理阻挡（后到站货物挡住先到站货物，卸货需挪箱）</div>`
        : '<div style="color:#1e8e4e;margin-top:4px">✅ 无物理阻挡，按站卸货无需翻箱</div>';
      rep.innerHTML = `<b>📦 站点装车分布</b>（深度=距车门比例，越小越先卸）<br>${rows}${viol}`;
      orderHead.appendChild(rep);
    }
  }
}

// ============================================================
// 配送路线导入（与调度模块联动）
// ============================================================
function handleRouteFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      // 兼容调度模块导出的格式：{ routes: [...] } 或数组
      const routes = Array.isArray(data) ? data : (data.routes || null);
      if (!routes || !routes.length) throw new Error('未找到 routes 字段');
      // 归一化：每条 route 含 vehicle_name 与 stops（字符串数组）
      const norm = routes.map(rt => ({
        vehicle_name: rt.vehicle_name || rt.vehicle || rt.vehicleName || rt.name || '车辆',
        stops: (rt.stops || []).map(s => typeof s === 'string' ? s : (s.name || s.stop_name || '')),
      })).filter(rt => rt.stops.length);
      if (!norm.length) throw new Error('路线无有效站点');
      routeData = { routes: norm };
      toast(`✅ 已导入 ${norm.length} 条配送路线（含站点顺序），配载后可联动装卸顺序`, 'ok');
      // 若有结果，刷新当前车辆的装卸顺序
      if (lastFleetResult) renderCurrentVehicle();
    } catch (err) {
      toast('路线导入失败: ' + err.message, 'err');
    }
  };
  reader.readAsText(file);
}

// 生成示例路线（演示联动）
function loadDemoRoute() {
  routeData = {
    routes: [
      { vehicle_name: '厢式货车1#1', stops: ['站点A', '站点B', '站点C'] },
      { vehicle_name: '厢式货车1#2', stops: ['站点C', '站点B', '站点A'] },
    ],
  };
  toast('✅ 已生成示例配送路线（站点A→B→C）', 'ok');
  if (lastFleetResult) renderCurrentVehicle();
}

// ============================================================
// 3D 视图（Three.js）
// ============================================================
function initThree() {
  const canvas = $('#viewer3d');
  const wrap = $('#viewer3dWrap');
  const w = wrap.clientWidth || 800;
  const h = 620;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f9fd);

  camera = new THREE.PerspectiveCamera(45, w / h, 1, 20000);
  camera.position.set(700, 550, 900);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.target.set(200, 100, 100);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(400, 600, 300);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
  dir2.position.set(-300, 200, -200);
  scene.add(dir2);

  const grid = new THREE.GridHelper(1200, 24, 0xccd8e4, 0xdde6ef);
  scene.add(grid);

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    const nw = wrap.clientWidth || 800;
    renderer.setSize(nw, h);
    camera.aspect = nw / h;
    camera.updateProjectionMatrix();
  });
}

function render3D(r) {
  if (!renderer) initThree();
  boxMeshes.forEach(m => { scene.remove(m); });
  boxMeshes = [];

  const c = r.stats.container;

  const boxGeo = new THREE.BoxGeometry(c.l, c.h, c.w);
  const boxMat = new THREE.MeshBasicMaterial({
    color: 0x0e7fd4, wireframe: true, transparent: true, opacity: 0.25,
  });
  const containerMesh = new THREE.Mesh(boxGeo, boxMat);
  containerMesh.position.set(c.l / 2, c.h / 2, c.w / 2);
  scene.add(containerMesh);
  boxMeshes.push(containerMesh);

  const floorGeo = new THREE.PlaneGeometry(c.l, c.w);
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x0e7fd4, transparent: true, opacity: 0.06, side: THREE.DoubleSide });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(c.l / 2, 0, c.w / 2);
  scene.add(floor);
  boxMeshes.push(floor);

  // 车门标记（x=L 端，卸货方向参照物）
  const doorGeo = new THREE.PlaneGeometry(c.w, c.h);
  const doorMat = new THREE.MeshBasicMaterial({ color: 0xe67e22, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const door = new THREE.Mesh(doorGeo, doorMat);
  door.rotation.y = Math.PI / 2;
  door.position.set(c.l, c.h / 2, c.w / 2);
  scene.add(door);
  boxMeshes.push(door);

  const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
  // 温层高亮色（stop-aware 模式下覆盖货品色，让温区一目了然）
  const TEMP_3D = { frozen: 0x5b8def, cold: 0x16a085, normal: 0xb8c4d0 };
  r.boxes.forEach((b, i) => {
    const useTempColor = r.stats.stop_aware !== undefined && b.item.tempClass && b.item.tempClass !== 'normal';
    const color = useTempColor
      ? new THREE.Color(TEMP_3D[b.item.tempClass] || b.color)
      : new THREE.Color(b.color || '#9b59b6');
    const geo = new THREE.BoxGeometry(b.l, b.h, b.w);
    const mat = new THREE.MeshPhongMaterial({
      color, transparent: true, opacity: 0.88,
      specular: 0x333333, shininess: 20,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(b.x + b.l / 2, b.y + b.h / 2, b.z + b.w / 2);
    scene.add(mesh);
    boxMeshes.push(mesh);

    const edges = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(edges, edgeMat);
    line.position.copy(mesh.position);
    scene.add(line);
    boxMeshes.push(line);

    const tempName = { frozen: '冷冻-18℃', cold: '冷藏2~8℃', normal: '常温' }[b.item.tempClass] || '';
    mesh.userData = {
      name: b.name, dim: `${b.l}×${b.w}×${b.h}`, weight: b.item.weight,
      pos: `X=${b.x} Y=${b.y} Z=${b.z}`,
      stop: b.item.stop || '', temp: tempName,
    };
  });

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  $('#viewer3d').addEventListener('click', (e) => {
    const rect = e.target.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const meshes = boxMeshes.filter(m => m.isMesh && m.userData && m.userData.name);
    const hits = raycaster.intersectObjects(meshes);
    if (hits.length) {
      const d = hits[0].object.userData;
      toast(`📦 ${d.name}｜${d.dim}cm｜${d.weight}kg${d.temp ? '｜' + d.temp : ''}${d.stop ? '｜→ ' + d.stop : ''}｜位置 ${d.pos}`);
    }
  });

  controls.target.set(c.l / 2, c.h / 2, c.w / 2);
  const dist = Math.max(c.l, c.w, c.h) * 2.6;
  camera.position.set(c.l / 2 + dist * 0.75, c.h / 2 + dist * 0.6, c.w / 2 + dist * 0.9);
  controls.update();
}

// ============================================================
// 视图切换
// ============================================================
function setView(mode) {
  currentView = mode;
  $('#viewer3dWrap').hidden = mode !== '3d';
  $('#loadListWrap').hidden = mode !== 'list';
  $('#orderWrap').hidden = mode !== 'order';
  $('#tab3d').classList.toggle('active', mode === '3d');
  $('#tabList').classList.toggle('active', mode === 'list');
  $('#tabOrder').classList.toggle('active', mode === 'order');
  if (mode === '3d' && renderer) {
    const wrap = $('#viewer3dWrap');
    renderer.setSize(wrap.clientWidth || 800, 620);
  }
}

// ============================================================
// CSV 导出（含装卸顺序）
// ============================================================
function doExportCsv() {
  if (!lastFleetResult) { toast('请先执行配载', 'err'); return; }
  const rows = [];
  rows.push(['车辆', '货品名称', '长cm', '宽cm', '高cm', '重量kg', '位置X', '位置Y', '位置Z', '装车顺序', '卸货顺序']);
  let loadSeq = 0, unloadSeq = 0;
  lastFleetResult.vehicles.forEach((v, vi) => {
    if (!v.result) return;
    const r = v.result;
    // 计算卸货顺序（顶层优先）
    const loadOrder = r.boxes.slice();
    const remaining = r.boxes.slice();
    const unloadOrder = [];
    while (remaining.length) {
      let found = null, fi = -1;
      for (let i = 0; i < remaining.length; i++) {
        const b = remaining[i];
        let blocked = false;
        for (const o of remaining) {
          if (o === b) continue;
          const ox = Math.max(0, Math.min(b.x + b.l, o.x + o.l) - Math.max(b.x, o.x));
          const oz = Math.max(0, Math.min(b.z + b.w, o.z + o.w) - Math.max(b.z, o.z));
          if (o.y >= b.y + b.h - 1e-6 && ox > 1 && oz > 1) { blocked = true; break; }
        }
        if (!blocked) { found = b; fi = i; break; }
      }
      if (!found) { found = remaining[0]; fi = 0; }
      unloadOrder.push(found);
      remaining.splice(fi, 1);
    }
    const unloadIdx = new Map(unloadOrder.map((b, i) => [b, i]));
    loadOrder.forEach((b, i) => {
      rows.push([
        v.vehicle.name, b.name, b.l, b.w, b.h, b.item.weight,
        b.x, b.y, b.z, i + 1, (unloadIdx.get(b) ?? 0) + 1,
      ]);
    });
  });
  rows.push([]);
  const s = lastFleetResult.stats;
  rows.push(['汇总', `共 ${s.packed_items}/${s.total_items} 件，用车 ${s.used_vehicles}/${s.fleet_size} 辆，体积利用率 ${s.volume_rate}%`]);
  const csv = rows.map(row =>
    row.map(cell => {
      const str = String(cell ?? '');
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    }).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '配载方案_含装卸顺序.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('📄 配载方案（含装卸顺序）已导出', 'ok');
}

// ============================================================
// 配载方案 JSON 导出（可导入调度模块联动）
// ============================================================
function doExportJson() {
  if (!lastFleetResult) { toast('请先执行配载', 'err'); return; }
  const payload = {
    app: 'cold_chain_packing',
    version: '3.0',
    exported_at: new Date().toISOString(),
    stats: lastFleetResult.stats,
    vehicles: lastFleetResult.vehicles.map(v => ({
      vehicle: v.vehicle,
      reason: v.reason,
      boxes: v.result ? v.result.boxes.map(b => ({
        name: b.name, l: b.l, w: b.w, h: b.h,
        weight: b.item.weight, x: b.x, y: b.y, z: b.z,
      })) : [],
    })),
    unpacked: lastFleetResult.unpacked,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '配载方案.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('📄 配载方案 JSON 已导出（可导入调度模块）', 'ok');
}

// ============================================================
// 装卸工单打印（司机任务单）
// ============================================================
function doPrintWorkOrder() {
  if (!lastFleetResult) { toast('请先执行配载', 'err'); return; }
  const s = lastFleetResult.stats;
  const dateStr = new Date().toLocaleDateString('zh-CN');

  let html = `<div class="print-root">
    <div class="print-header">
      <h1>🧊 装卸工单（司机任务单）</h1>
      <div class="print-meta">日期：${dateStr} ｜ 共 ${s.packed_items}/${s.total_items} 件货品 ｜ 用车 ${s.used_vehicles}/${s.fleet_size} 辆 ｜ 体积利用率 ${s.volume_rate}%</div>
    </div>`;

  lastFleetResult.vehicles.forEach((v, vi) => {
    if (!v.result || !v.result.boxes.length) return;
    const r = v.result;
    const veh = v.vehicle;
    const stopOrder = getStopOrderForVehicle(veh.name);
    const loadOrder = r.boxes.slice();
    const unloadOrder = computeUnloadOrderWithStops(r.boxes, stopOrder);
    const gravity = r.gravity || {};

    html += `
      <div class="print-veh">
        <div class="print-veh-head">
          <b>🚛 ${esc(veh.name)}</b>
          <span>车厢 ${veh.l}×${veh.w}×${veh.h}cm ｜ 载重 ${veh.max_weight}kg ｜ 已装 ${r.stats.packed_count} 件 / ${r.stats.total_weight}kg ｜ 体积率 ${r.stats.volume_rate}%</span>
        </div>
        ${stopOrder && stopOrder.length ? `<div class="print-route">🗺️ 配送路线：${stopOrder.map(esc).join(' → ')}</div>` : ''}
        ${gravity.load_shift && gravity.load_shift !== 'uniform' ? `<div class="print-gravity ${gravity.level}">⚠️ 偏载提示：${esc(gravity.load_shift)}（等级：${gravity.level === 'ok' ? '正常' : gravity.level === 'warn' ? '警告' : '危险'}）</div>` : '<div class="print-gravity ok">✅ 装载重心均衡</div>'}
        <table class="print-table">
          <thead><tr><th>#</th><th>货品</th><th>尺寸(cm)</th><th>重量</th><th>配送站点</th><th>装车序</th><th>卸货序</th></tr></thead>
          <tbody>`;
    const unloadIdx = new Map(unloadOrder.map((b, i) => [b, i]));
    loadOrder.forEach((b, i) => {
      html += `<tr>
        <td>${i + 1}</td>
        <td>${esc(b.name)}</td>
        <td>${b.l}×${b.w}×${b.h}</td>
        <td>${b.item.weight}kg</td>
        <td>${b.item.stop ? esc(b.item.stop) : '—'}</td>
        <td>${i + 1}</td>
        <td>${(unloadIdx.get(b) ?? 0) + 1}</td>
      </tr>`;
    });
    html += `</tbody></table>
      </div>`;
  });

  // 未装货品
  if (lastFleetResult.unpacked && lastFleetResult.unpacked.length) {
    html += `<div class="print-unpacked"><b>⚠️ 未装入货品（需增派车辆）：</b>${lastFleetResult.unpacked.map(u => `${esc(u.name)}×${u.qty}`).join('、')}</div>`;
  }

  html += `<div class="print-footer">
    <div>装车员签字：__________</div>
    <div>司机签字：__________</div>
    <div>验收员签字：__________</div>
  </div></div>`;

  openPrintWindow(html, '装卸工单打印');
}

// ============================================================
// 装载合规校验报告（重心/偏载）
// ============================================================
function doComplianceReport() {
  if (!lastFleetResult) { toast('请先执行配载', 'err'); return; }
  const s = lastFleetResult.stats;
  const dateStr = new Date().toLocaleDateString('zh-CN');

  // 汇总所有车辆合规状态
  const vehReports = lastFleetResult.vehicles.filter(v => v.result && v.result.boxes.length);
  const allOk = vehReports.every(v => v.result.gravity && v.result.gravity.level === 'ok');

  let html = `<div class="print-root">
    <div class="print-header">
      <h1>📋 装载合规校验报告</h1>
      <div class="print-meta">日期：${dateStr} ｜ 总评：<b class="${allOk ? 'ok' : 'warn'}">${allOk ? '✅ 全部合规' : '⚠️ 存在待关注项'}</b></div>
    </div>
    <table class="print-table">
      <thead><tr><th>车辆</th><th>体积率</th><th>重量</th><th>纵向偏载</th><th>横向偏载</th><th>重心高度</th><th>偏载状态</th><th>等级</th></tr></thead>
      <tbody>`;
  vehReports.forEach(v => {
    const r = v.result;
    const g = r.gravity || { level: 'ok', offset_pct: { x: 0, y: 0, z: 0 }, load_shift: 'uniform' };
    const lv = g.level === 'ok' ? '✅' : g.level === 'warn' ? '⚠️' : '🔴';
    const lvName = g.level === 'ok' ? '正常' : g.level === 'warn' ? '警告' : '危险';
    html += `<tr>
      <td>${esc(v.vehicle.name)}</td>
      <td>${r.stats.volume_rate}%</td>
      <td>${r.stats.total_weight}kg</td>
      <td>${g.offset_pct.x >= 0 ? '+' : ''}${(g.offset_pct.x || 0).toFixed(1)}%</td>
      <td>${g.offset_pct.z >= 0 ? '+' : ''}${(g.offset_pct.z || 0).toFixed(1)}%</td>
      <td>${g.offset_pct.y >= 0 ? '+' : ''}${(g.offset_pct.y || 0).toFixed(1)}%</td>
      <td>${esc(g.load_shift || 'uniform')}</td>
      <td>${lv} ${lvName}</td>
    </tr>`;
  });
  html += `</tbody></table>`;

  // 每辆车的详细检查项
  vehReports.forEach(v => {
    const r = v.result;
    const g = r.gravity || { checks: [] };
    html += `
      <div class="print-veh">
        <div class="print-veh-head"><b>🚛 ${esc(v.vehicle.name)}</b>
          <span>车厢 ${v.vehicle.l}×${v.vehicle.w}×${v.vehicle.h}cm ｜ 重心 X=${g.center ? g.center.x : '-'} Y=${g.center ? g.center.y : '-'} Z=${g.center ? g.center.z : '-'}</span>
        </div>`;
    if (g.checks && g.checks.length) {
      html += `<table class="print-table"><thead><tr><th>检查项</th><th>结果</th><th>判定</th><th>说明</th></tr></thead><tbody>`;
      g.checks.forEach(c => {
        html += `<tr><td>${esc(c.name)}</td><td>${esc(c.value)}</td><td>${c.ok ? '✅ 通过' : '⚠️ 关注'}</td><td>${esc(c.detail)}</td></tr>`;
      });
      html += `</tbody></table>`;
    }
    html += `</div>`;
  });

  // 合规建议
  html += `<div class="print-advice"><b>📌 合规建议：</b>
    <ul>
      <li>纵向/横向偏载 &lt; 10% 为安全范围；&gt; 10% 建议调整货品位置。</li>
      <li>重货优先置于车厢底部中央，避免集中一侧造成侧倾。</li>
      <li>冷链药品全程保持 2~8℃；装载后建议复核温度监控装置。</li>
    </ul>
  </div>
  <div class="print-footer">
    <div>调度员签字：__________</div>
    <div>安全员签字：__________</div>
    <div>日期：__________</div>
  </div></div>`;

  openPrintWindow(html, '装载合规校验报告');
}

// 打开打印窗口
function openPrintWindow(html, title) {
  const w = window.open('', '_blank', 'width=1000,height=760');
  if (!w) { toast('浏览器阻止了弹窗，请允许弹出窗口', 'err'); return; }
  w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
    <title>${title}</title>
    <style>
      body { font-family: "Microsoft YaHei", sans-serif; margin: 30px; color: #1f2d3d; }
      .print-header { border-bottom: 3px solid #0e7fd4; padding-bottom: 12px; margin-bottom: 18px; }
      .print-header h1 { font-size: 22px; color: #0e7fd4; margin: 0 0 6px; }
      .print-meta { font-size: 13px; color: #5b6f84; }
      .print-veh { border: 1px solid #dbe6f2; border-radius: 10px; padding: 14px; margin-bottom: 14px; page-break-inside: avoid; }
      .print-veh-head { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 8px; }
      .print-veh-head span { font-size: 12px; color: #5b6f84; }
      .print-route { font-size: 12px; color: #0e7fd4; margin-bottom: 6px; }
      .print-gravity { font-size: 12px; padding: 6px 10px; border-radius: 6px; margin-bottom: 8px; }
      .print-gravity.ok { background: #e8f8ef; color: #1e8e4e; }
      .print-gravity.warn { background: #fdf3e0; color: #b57410; }
      .print-gravity.danger { background: #fdecea; color: #c0392b; }
      .print-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .print-table th { background: #eef4fa; text-align: left; padding: 7px 8px; border: 1px solid #dbe6f2; }
      .print-table td { padding: 6px 8px; border: 1px solid #e4ecf5; }
      .print-table tr:nth-child(even) td { background: #f8fafc; }
      .print-unpacked { border: 1px dashed #f0c4c2; background: #fdf2f1; color: #c0392b; padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; font-size: 13px; }
      .print-advice { background: #eef7ff; border: 1px solid #cfe4f7; border-radius: 8px; padding: 12px 16px; font-size: 13px; margin-bottom: 16px; }
      .print-advice ul { margin: 6px 0 0 18px; padding: 0; }
      .print-advice li { margin: 4px 0; }
      .print-footer { display: flex; justify-content: space-between; margin-top: 30px; padding-top: 12px; border-top: 1px dashed #ccc; font-size: 13px; color: #5b6f84; }
      @media print {
        body { margin: 12px; }
        .print-veh { page-break-inside: avoid; }
      }
    </style></head><body>${html}
    <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 400); };<\/script>
  </body></html>`);
  w.document.close();
}

// ============================================================
// 一键全流程：调度 → 配载 → 工单
// ============================================================
let _scheduleData = null; // 调度数据（内置需求数据）

async function loadScheduleData() {
  if (_scheduleData) return _scheduleData;
  // 单文件版：window.__EMBEDDED_SCHEDULE_DATA__
  if (window.__EMBEDDED_SCHEDULE_DATA__) {
    _scheduleData = window.__EMBEDDED_SCHEDULE_DATA__;
    return _scheduleData;
  }
  // 在线版：fetch data/demo_input.json
  try {
    const res = await fetch('data/demo_input.json');
    if (res.ok) {
      _scheduleData = await res.json();
      return _scheduleData;
    }
  } catch (e) { /* fallthrough */ }
  throw new Error('调度数据不可用');
}

function setFlowStep(step, state) {
  const el = document.querySelector(`.flow-step[data-step="${step}"]`);
  if (!el) return;
  el.className = 'flow-step ' + (state || '');
}

function runFlowStep(step) {
  setFlowStep(step, 'active');
  // 前序步骤标记完成
  for (let i = 1; i < step; i++) setFlowStep(i, 'done');
}

async function doFullFlow() {
  const btn = $('#fullFlowBtn');
  const steps = $('#flowSteps');
  steps.hidden = false;
  btn.disabled = true;
  btn.style.opacity = 0.7;

  try {
    // Step 1: 规划配送路线（VRP）
    runFlowStep(1);
    toast('🚀 步骤1/4：正在规划配送路线...');
    const schedData = await loadScheduleData();
    if (typeof VrpSolver === 'undefined') throw new Error('调度引擎未加载');

    const maxNodes = Math.max(5, Math.min(206, Math.floor(num($('#flowMaxNodes').value, 30))));
    const timeLimit = Math.max(3, Math.min(120, Math.floor(num($('#flowTimeLimit').value, 20))));
    const itemsPerStop = Math.max(1, Math.min(20, Math.floor(num($('#flowItemsPerStop').value, 3))));

    const schedRes = VrpSolver.solve({
      nodes: schedData.nodes,
      vehicles: schedData.vehicles,
      params: schedData.params,
      warnings: schedData.warnings || [],
      schedule_date: '2026-08-07',
      max_nodes: maxNodes,
    });

    if (!schedRes.routes.length) throw new Error('路线规划失败，无可配送路线');
    setFlowStep(1, 'done');
    await new Promise(r => setTimeout(r, 300));

    // Step 2: 路线站点匹配货物
    runFlowStep(2);
    toast('🚀 步骤2/4：站点匹配货物...');
    // 同步 OrderStore（执行跟踪数据源；调度页刷新可见）
    try {
      if (typeof OrderModel !== 'undefined') OrderStore.setRoutes(schedRes);
    } catch (e) { console.warn('OrderStore 写入失败:', e); }
    // 生成配送路线（车辆名 → 站点顺序）
    const routes = schedRes.routes.map(r => ({
      vehicle_name: r.node_names[0] ? `车辆${r.vehicle_id} ${r.plate}` : `车辆${r.vehicle_id}`,
      plate: r.plate,
      stops: r.node_names.filter((n, i) => i > 0 && i < r.node_names.length - 1),
    })).filter(r => r.stops.length);
    routeData = { routes };
    // 生成货物：每个站点生成 itemsPerStop 件（尺寸随机的大件货品）
    const genItems = [];
    const dims = [
      [90, 75, 190], [60, 60, 85], [80, 60, 60], [65, 45, 40],
      [120, 100, 150], [50, 40, 175], [100, 80, 60], [70, 50, 120],
    ];
    const names = ['对开门冰箱', '滚筒洗衣机', '医疗器械箱', '冷链保温箱', '标准托盘货', '立式空调', '大型设备箱', '货架组件'];
    const wtByIdx = [95, 70, 120, 15, 200, 55, 150, 45];
    const colors = COLOR_PALETTE;
    routes.forEach((rt, ri) => {
      rt.stops.forEach((stop, si) => {
        for (let k = 0; k < itemsPerStop; k++) {
          const di = (ri * 7 + si * 3 + k) % dims.length;
          genItems.push({
            id: uid(), name: names[di],
            l: dims[di][0], w: dims[di][1], h: dims[di][2],
            weight: wtByIdx[di], qty: 1,
            canRotate: di !== 0 && di !== 5, // 冰箱/空调不可倒置
            maxStack: di === 0 || di === 5 ? 200 : Infinity,
            color: colors[di % colors.length],
            type: '全流程生成', stop: stop,
          });
        }
      });
    });
    items = genItems;
    renderItems();
    setFlowStep(2, 'done');
    await new Promise(r => setTimeout(r, 300));

    // Step 3: 多车配载求解
    runFlowStep(3);
    toast('🚀 步骤3/4：正在多车配载...');
    // 保证车队有车
    if (!fleet.length) loadDemoFleet();
    const containers = fleetToContainerList();
    // stop-aware：按路线站点顺序装车
    const flowRouteStops = {};
    routes.forEach(rt => { if (rt.stops.length) flowRouteStops[rt.vehicle_name] = rt.stops; });
    const result = PackingSolver.solveFleet(containers, items, {
      strategy: 'volume',
      routeStops: flowRouteStops,
    });
    result.solve_ms = 0;
    lastFleetResult = result;
    currentVehicleIdx = 0;
    renderFleetResult(result);
    setFlowStep(3, 'done');
    await new Promise(r => setTimeout(r, 300));

    // Step 4: 工单与报告就绪
    runFlowStep(4);
    setFlowStep(4, 'done');
    toast(`✅ 全流程完成：${schedRes.routes.length} 条路线 → ${result.stats.packed_items}/${result.stats.total_items} 件装入 ${result.stats.used_vehicles} 辆车，可打印工单/报告`, 'ok');
  } catch (e) {
    toast('❌ 全流程失败: ' + e.message, 'err');
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.style.opacity = 1;
  }
}

// ============================================================
// 初始化
// ============================================================
function init() {
  $('#addItemBtn').addEventListener('click', addItem);
  $('#loadDemoItems').addEventListener('click', loadDemoItems);
  $('#loadFromStoreBtn').addEventListener('click', () => loadRoutesFromStore(false));
  $('#clearItemsBtn').addEventListener('click', () => {
    items = [];
    renderItems();
    toast('已清空货物清单');
  });
  $('#importExcelBtn').addEventListener('click', () => $('#excelFile').click());
  $('#excelFile').addEventListener('change', (e) => {
    if (e.target.files[0]) handleExcel(e.target.files[0]);
    e.target.value = '';
  });
  $('#addVehicleBtn').addEventListener('click', addVehicle);
  $('#packBtn').addEventListener('click', doPack);
  $('#exportCsvBtn').addEventListener('click', doExportCsv);
  $('#exportJsonBtn').addEventListener('click', doExportJson);
  $('#tab3d').addEventListener('click', () => setView('3d'));
  $('#tabList').addEventListener('click', () => setView('list'));
  $('#tabOrder').addEventListener('click', () => setView('order'));
  // 路线联动
  $('#importRouteBtn').addEventListener('click', () => $('#routeFile').click());
  $('#routeFile').addEventListener('change', (e) => {
    if (e.target.files[0]) handleRouteFile(e.target.files[0]);
    e.target.value = '';
  });
  // 工单打印与合规报告
  $('#printWorkBtn').addEventListener('click', doPrintWorkOrder);
  $('#complianceBtn').addEventListener('click', doComplianceReport);
  // 一键全流程
  $('#fullFlowBtn').addEventListener('click', doFullFlow);

  // 默认示例
  loadDemoItems();
  loadDemoFleet();
  // 启动时若调度页已保存路线 → 静默直读（免手动导入）
  loadRoutesFromStore(true);
}

document.addEventListener('DOMContentLoaded', init);

})();
