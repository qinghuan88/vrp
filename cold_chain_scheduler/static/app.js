/* ============================================================
   冷链药品智能调度系统 - 前端逻辑
   ============================================================ */
(() => {
'use strict';

const API = {
  health: '/api/health',
  overview: '/api/overview',
  upload: '/api/upload',
  solve: '/api/solve',
  export: '/api/export',
};

const ROUTE_COLORS = [
  '#0e7fd4', '#00a8a8', '#e67e22', '#9b59b6', '#e74c3c', '#27ae60',
  '#f39c12', '#2980b9', '#8e44ad', '#16a085', '#d35400', '#2c3e50',
  '#c0392b', '#7f8c8d', '#1abc9c', '#e84393', '#00b894', '#6c5ce7',
  '#fd79a8', '#0984e3', '#00cec9', '#fdcb6e', '#e17055', '#74b9ff',
  '#a29bfe', '#55efc4', '#fab1a0', '#81ecec', '#ff7675', '#636e72',
];

let currentResult = null;   // 最近一次求解结果
let overview = null;        // 数据概览
let solving = false;

// ============================================================
// 工具
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Leaflet 兜底加载（多 CDN 轮询，国内网络兼容）----
let _leafletPromise = null;
function ensureLeaflet() {
  if (window.L && typeof window.L.map === 'function') return Promise.resolve(window.L);
  if (_leafletPromise) return _leafletPromise;
  const cdnList = [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
    'https://cdn.bootcdn.net/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  ];
  _leafletPromise = new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= cdnList.length) { resolve(null); return; }
      const s = document.createElement('script');
      s.src = cdnList[i++];
      s.onload = () => resolve(window.L || null);
      s.onerror = tryNext;
      document.head.appendChild(s);
    };
    tryNext();
  });
  return _leafletPromise;
}

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.detail || data.message || `请求失败 (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function fmt(n, digits = 0) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  const today = new Date();
  $('#p_date').value = today.toISOString().slice(0, 10);
  $('#solveBtn').addEventListener('click', doSolve);
  $('#exportCsvBtn').addEventListener('click', doExportCsv);
  $('#exportRouteBtn').addEventListener('click', doExportRouteJson);
  $('#fileInput').addEventListener('change', handleFileLoad);
  $('#loadDemoBtn').addEventListener('click', loadDemoData);
  $('#tabReal').addEventListener('click', () => {
    if (!_currentResult) return;
    ensureLeaflet().then((L) => {
      if (!L) {
        renderSvgMap(_currentResult);
        setMapView('svg');
        $('#mapHint').textContent = '真实地图引擎加载失败（需联网），已显示示意图';
        return;
      }
      renderRealMap(_currentResult);
      setMapView('real');
    });
  });
  $('#tabSvg').addEventListener('click', () => {
    if (_currentResult) {
      renderSvgMap(_currentResult);
      setMapView('svg');
    }
  });
  $('#tileSource').addEventListener('change', () => {
    if (_currentResult) {
      ensureLeaflet().then((L) => {
        if (L) { renderRealMap(_currentResult); setMapView('real'); }
      });
    }
  });

  // 内嵌数据模式（静态演示页）：无需后端，直接渲染
  if (window.__EMBEDDED_RESULT__) {
    currentResult = window.__EMBEDDED_RESULT__;
    overview = window.__EMBEDDED_OVERVIEW__ || null;
    if (overview) {
      $('#dataSource').textContent = '📄 ' + (overview.source || '静态演示数据');
      $('#ovDepot').textContent = 1;
      $('#ovDemand').textContent = (overview.node_count || 207) - 1;
      $('#ovTotalKg').textContent = fmt(overview.total_demand_kg || 0);
      $('#ovVehicles').textContent = overview.vehicle_count || 100;
      const warn = $('#warnBox');
      if (overview.warnings && overview.warnings.length) {
        warn.innerHTML = overview.warnings.map(w => '⚠️ ' + w).join('<br>');
        warn.hidden = false;
      }
    }
    setStatus(true);
    renderResult(currentResult);
    return;
  }

  // 纯前端模式：内置示例数据自动加载（无需后端服务）
  setStatus(true);
  try {
    await loadDemoData();
  } catch (e) {
    toast('初始化失败: ' + e.message, 'err');
  }
  // 恢复执行跟踪面板（OrderStore 持久化数据，刷新页面不丢）
  renderTracking();
  // 配载页写入的变更 → 本页自动刷新（跨页面同步）
  if (typeof OrderModel !== 'undefined') {
    OrderStore.subscribe(() => renderTracking());
  }
}

function setStatus(ok) {
  const pill = $('#statusPill');
  pill.className = 'status-pill ' + (ok ? 'ok' : 'err');
  pill.innerHTML = `<span class="dot"></span>${ok ? (window.__EMBEDDED_RESULT__ ? '静态演示' : '前端引擎就绪') : '服务离线'}`;
}

// ============================================================
// 数据加载（纯前端：SheetJS 解析 Excel）
// ============================================================
let _workbookData = null; // { nodes, vehicles, params, warnings }

// 内置示例数据（与 input_data.xlsx 相同，转成 JSON 内嵌）
// 由 build 时从 output/frontend_input.json 注入；开发时用 fetch 兜底
let DEMO_DATA = null;

async function loadDemoData() {
  // 内嵌数据模式（单文件静态版）：数据直接注入 window.__EMBEDDED_DATA__
  if (window.__EMBEDDED_DATA__) {
    DEMO_DATA = window.__EMBEDDED_DATA__;
    DEMO_DATA.source = DEMO_DATA.source || '内置示例';
    _workbookData = DEMO_DATA;
    applyDataToUI();
    toast('✅ 已加载内置示例数据（' + (_workbookData.nodes.length - 1) + ' 需求点）', 'ok');
    return;
  }
  if (DEMO_DATA) {
    _workbookData = DEMO_DATA;
    applyDataToUI();
    toast('✅ 已加载内置示例数据（' + (_workbookData.nodes.length - 1) + ' 需求点）', 'ok');
    return;
  }
  // 尝试从静态 JSON 加载（打包时提供 data/demo_input.json）
  try {
    const res = await fetch('data/demo_input.json');
    if (res.ok) {
      DEMO_DATA = await res.json();
      DEMO_DATA.source = DEMO_DATA.source || '内置示例';
      _workbookData = DEMO_DATA;
      applyDataToUI();
      toast('✅ 已加载内置示例数据（' + (_workbookData.nodes.length - 1) + ' 需求点）', 'ok');
      return;
    }
  } catch (e) { /* fallthrough */ }
  throw new Error('内置示例数据不可用，请点击「加载 Excel」选择数据文件');
}

function parseExcelFile(arrayBuffer) {
  if (typeof XLSX === 'undefined') throw new Error('Excel 解析库未加载（需联网加载 SheetJS CDN）');
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const readSheet = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });

  const paramsSheet = readSheet('基础参数');
  const nodesSheet = readSheet('网点信息');
  const vehSheet = readSheet('车辆信息');
  if (!nodesSheet || !nodesSheet.length) throw new Error('缺少「网点信息」工作表');
  if (!vehSheet || !vehSheet.length) throw new Error('缺少「车辆信息」工作表');

  // 参数
  const params = {
    c0: 300, c1: 2.5, c2: 8.0, Q_max: 500, v_avg: 100, T_max: 24, time_window_buffer: 0,
  };
  if (paramsSheet && paramsSheet.length) {
    paramsSheet.forEach(r => {
      const k = r['参数符号'] || r['参数名称'];
      const v = parseFloat(r['参数值']);
      if (k && !isNaN(v) && k in params) params[k] = v;
    });
  }

  // 节点
  const warnings = [];
  const nodes = nodesSheet.map(r => ({
    node_id: parseInt(r['节点ID'], 10),
    name: String(r['网点名称'] || ''),
    type: parseInt(r['节点ID'], 10) === 0 ? 'depot' : 'demand',
    lng: parseFloat(r['经度']),
    lat: parseFloat(r['纬度']),
    demand: parseInt(r['需求量(kg)'] || 0, 10),
    service_h: parseFloat(r['服务时长(小时)'] || 0.01),
    tw_start: r['时间窗开始'] != null ? String(r['时间窗开始']).trim() : '08:00:00',
    tw_end: r['时间窗结束'] != null ? String(r['时间窗结束']).trim() : '23:00:00',
    excluded: false,
  }));

  // 异常坐标识别（距配送中心 >200km）
  const depot = nodes.find(n => n.type === 'depot');
  const R = 6371.0;
  function haversineKm(a, b) {
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const aa = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  }
  let anomalyCount = 0;
  nodes.forEach(n => {
    if (n.type === 'demand') {
      const d = haversineKm(depot, n);
      n.dist_to_depot_km = Math.round(d * 10) / 10;
      if (d > 200) { n.excluded = true; anomalyCount++; }
    }
  });
  if (anomalyCount > 0) {
    warnings.push(`检测到 ${anomalyCount} 个距配送中心超过 200km 的疑似异常坐标点，默认已自动排除（可在调度设置中调整阈值）`);
  }

  // 车辆
  const vehicles = vehSheet
    .filter(v => !v['状态'] || String(v['状态']) === '可用')
    .map(v => ({
      vehicle_id: parseInt(v['车辆ID'] || v['车辆编号'], 10),
      plate: String(v['车牌号'] || ''),
    }));

  return { nodes, vehicles, params, warnings };
}

function applyDataToUI() {
  const d = _workbookData;
  if (!d) return;
  overview = {
    source: '已加载数据',
    node_count: d.nodes.length,
    total_demand_kg: d.nodes.filter(n => n.type === 'demand').reduce((a, n) => a + n.demand, 0),
    vehicle_count: d.vehicles.length,
    warnings: d.warnings,
    params: d.params,
  };
  $('#dataSource').textContent = '📄 ' + overview.source;
  $('#ovDepot').textContent = 1;
  $('#ovDemand').textContent = overview.node_count - 1;
  $('#ovTotalKg').textContent = fmt(overview.total_demand_kg);
  $('#ovVehicles').textContent = overview.vehicle_count;

  // 同步参数
  const p = d.params;
  $('#p_c0').value = p.c0;
  $('#p_c1').value = p.c1;
  $('#p_c2').value = p.c2;
  $('#p_Qmax').value = p.Q_max;
  $('#p_vavg').value = p.v_avg;
  $('#p_Tmax').value = p.T_max;
  $('#p_buffer').value = p.time_window_buffer;

  const warn = $('#warnBox');
  if (d.warnings && d.warnings.length) {
    warn.innerHTML = d.warnings.map(w => '⚠️ ' + w).join('<br>');
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  $('#fileHint').textContent = d.source === '内置示例' ? '📦 当前使用内置示例数据' : '📥 数据已加载，可点击「一键智能调度」';
}

async function handleFileLoad(e) {
  const file = e.target.files[0];
  if (!file) return;
  toast('正在解析 Excel...');
  try {
    const buf = await file.arrayBuffer();
    const data = parseExcelFile(buf);
    data.source = file.name;
    _workbookData = data;
    DEMO_DATA = data; // 缓存，便于后续使用
    applyDataToUI();
    toast(`✅ 数据加载成功：${data.nodes.length - 1} 个需求点，${data.vehicles.length} 辆可用车`, 'ok');
  } catch (err) {
    toast('数据解析失败: ' + err.message, 'err');
  }
  e.target.value = '';
}

// ============================================================
// 参数收集
// ============================================================
function collectOptions() {
  const num = (id, def) => {
    const v = $(id).value.trim();
    return v === '' ? def : Number(v);
  };
  return {
    params: {
      c0: num('#p_c0', 300),
      c1: num('#p_c1', 2.5),
      c2: num('#p_c2', 8),
      Q_max: num('#p_Qmax', 500),
      v_avg: num('#p_vavg', 100),
      T_max: num('#p_Tmax', 24),
      time_window_buffer: num('#p_buffer', 0),
    },
    time_limit_seconds: num('#p_timeLimit', 120),
    max_vehicles: num('#p_maxVehicles', 0) || null,
    max_nodes: num('#p_maxNodes', 0) || null,
    exclude_far_nodes: $('#p_excludeFar').checked,
    radius_km: num('#p_radius', 200),
    first_solution_strategy: $('#p_strategy').value,
    metaheuristic: $('#p_meta').value,
    schedule_date: $('#p_date').value,
  };
}

// ============================================================
// 求解
// ============================================================
async function doSolve() {
  if (solving) return;
  solving = true;
  $('#solveBtn').disabled = true;
  $('#solveBtn').textContent = '⏳ 正在求解...';
  $('#progressWrap').hidden = false;
  animateProgress();

  try {
    const options = collectOptions();
    if (!_workbookData) {
      throw new Error('请先加载数据（点击「加载 Excel」或「加载内置示例数据」）');
    }
    const t0 = performance.now();
    const res = VrpSolver.solve({
      nodes: _workbookData.nodes,
      vehicles: _workbookData.vehicles,
      params: options.params,
      warnings: _workbookData.warnings || [],
      schedule_date: options.schedule_date,
      max_nodes: options.max_nodes,
      max_vehicles: options.max_vehicles,
    });
    res.solve_ms = Math.round(performance.now() - t0);
    currentResult = res;
    // 写入 OrderStore：调度页与配载页共享（免 JSON 文件搬运）
    try {
      syncOrdersFromResult(res, options.schedule_date);
      OrderStore.setRoutes(res);
    } catch (e) {
      console.warn('OrderStore 写入失败（不影响求解结果）:', e);
    }
    renderResult(res);
    renderTracking();
    toast(`✅ 调度完成！${res.summary.used_vehicles} 辆车，总成本 ¥${fmt(res.summary.total_cost_yuan, 2)}（浏览器端求解 ${res.solve_ms}ms）`, 'ok');
  } catch (err) {
    toast('❌ 求解失败: ' + err.message, 'err');
    console.error(err);
  } finally {
    solving = false;
    $('#solveBtn').disabled = false;
    $('#solveBtn').textContent = '🚀 一键智能调度';
    $('#progressWrap').hidden = true;
    $('#progressFill').style.width = '0%';
  }
}

function animateProgress() {
  let p = 0;
  const fill = $('#progressFill');
  const text = $('#progressText');
  const timer = setInterval(() => {
    p = Math.min(p + Math.random() * 9 + 2, 92);
    fill.style.width = p + '%';
    text.textContent = `正在求解 VRP 模型... ${Math.round(p)}%`;
  }, 600);
  window._solveTimer = timer;
  setTimeout(() => { if (window._solveTimer) { clearInterval(window._solveTimer); window._solveTimer = null; } }, 60000);
}

// ============================================================
// 结果渲染
// ============================================================
function renderResult(res) {
  const s = res.summary;

  // 汇总
  $('#kUsed').textContent = s.used_vehicles;
  $('#kDist').textContent = fmt(s.total_distance_km, 1);
  $('#kCost').textContent = fmt(s.total_cost_yuan, 0);
  $('#kTime').textContent = fmt(s.total_drive_time_h, 1);
  $('#kLoad').textContent = s.avg_load_rate + '%';
  $('#kSolve').textContent = fmt(s.solve_seconds, 1);

  $('#toolbar').hidden = false;
  $('#scheduleTitle').textContent =
    `📅 ${s.schedule_date} · ${s.used_vehicles}辆车 · ${s.total_delivered_kg}kg 药品 · 全程2~8℃`;

  // 地图
  $('#mapCard').hidden = false;
  renderMap(res);

  // 成本
  $('#costCard').hidden = false;
  renderCost(s);

  // 路线
  $('#routeCard').hidden = false;
  $('#routeCount').textContent = `共 ${res.routes.length} 条路线`;
  renderRoutes(res);

  // 任务单
  $('#taskCard').hidden = false;
  renderTasks(res);

  $('#emptyState').hidden = true;
  $('#routeCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ============================================================
// 地图（真实地图优先，失败自动回退示意图）
// ============================================================

// ---- 瓦片源配置 ----
const TILE_SOURCES = {
  gaode: {
    name: '高德中文底图',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: '1234', maxZoom: 18, attribution: '© 高德地图', gcj: true,
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc', maxZoom: 19, attribution: '© OpenStreetMap', gcj: false,
  },
  carto: {
    name: 'CartoDB',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap © CARTO', gcj: false,
  },
};

// ---- WGS84 ↔ GCJ02 坐标转换（高德/腾讯底图为火星坐标）----
const _A = 6378245.0;
const _EE = 0.00669342162296594323;
function _outOfChina(lng, lat) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}
function _transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}
function _transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}
function wgs84ToGcj02(lng, lat) {
  if (_outOfChina(lng, lat)) return [lng, lat];
  let dLat = _transformLat(lng - 105.0, lat - 35.0);
  let dLng = _transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - _EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}
function toMapLngLat(lng, lat, useGcj) {
  return useGcj ? wgs84ToGcj02(lng, lat) : [lng, lat];
}

// ---- 地图渲染入口 ----
let _leafletMap = null;
let _mapLayers = null;
let _currentResult = null;

function renderMap(res) {
  _currentResult = res;
  ensureLeaflet().then((L) => {
    if (!L) {
      // 所有 CDN 都失败 → 示意图
      renderSvgMap(res);
      setMapView('svg');
      $('#mapHint').textContent = '真实地图引擎加载失败（需联网），已显示示意图';
      return;
    }
    try {
      renderRealMap(res);
      setMapView('real');
    } catch (e) {
      console.error('真实地图渲染失败，回退示意图:', e);
      renderSvgMap(res);
      setMapView('svg');
      $('#mapHint').textContent = '真实地图渲染失败，已显示示意图';
    }
  });
}

function setMapView(mode) {
  const real = mode === 'real';
  $('#realMap').hidden = !real;
  $('#svgMapWrap').hidden = real;
  $('#tabReal').classList.toggle('active', real);
  $('#tabSvg').classList.toggle('active', !real);
  $('#mapHint').textContent = real
    ? '底图为在线地图服务，加载失败时自动切换到示意图'
    : '示意图模式（离线可用）';
  if (real && _leafletMap) {
    setTimeout(() => _leafletMap.invalidateSize(), 60);
  }
}

// ---- 真实地图渲染（Leaflet）----
function renderRealMap(res) {
  const L = window.L;
  const src = TILE_SOURCES[$('#tileSource').value] || TILE_SOURCES.gaode;
  const useGcj = !!src.gcj;

  // 建立或复用地图实例
  if (!_leafletMap) {
    _leafletMap = L.map('realMap', { zoomControl: true });
    _leafletMap.zoomControl.setPosition('bottomright');
  }
  if (_mapLayers) {
    _mapLayers.forEach(l => _leafletMap.removeLayer(l));
  }
  _mapLayers = [];

  const tileLayer = L.tileLayer(src.url, {
    subdomains: src.subdomains,
    maxZoom: src.maxZoom,
    attribution: src.attribution,
  });
  tileLayer.addTo(_leafletMap);
  _mapLayers.push(tileLayer);

  // 收集坐标
  const bounds = [];
  const nodes = res.nodes;

  // 需求点
  nodes.filter(n => n.type === 'demand' && n.in_solution).forEach(n => {
    const [mlng, mlat] = toMapLngLat(n.lng, n.lat, useGcj);
    const marker = L.circleMarker([mlat, mlng], {
      radius: 6, color: '#5b7a9a', weight: 1.5, fillColor: '#ffffff', fillOpacity: 1,
    });
    marker.bindTooltip(`${n.name}<br>需求量: ${n.demand}kg<br>距配送中心: ${n.dist_to_depot_km}km`);
    marker.addTo(_leafletMap);
    _mapLayers.push(marker);
    bounds.push([mlat, mlng]);
  });

  // 配送中心
  const depot = nodes.find(n => n.type === 'depot');
  if (depot) {
    const [mlng, mlat] = toMapLngLat(depot.lng, depot.lat, useGcj);
    const icon = L.divIcon({
      className: 'depot-icon',
      html: '🏥',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    const m = L.marker([mlat, mlng], { icon });
    m.bindTooltip(`<b>配送中心</b><br>${depot.name}`);
    m.addTo(_leafletMap);
    _mapLayers.push(m);
    bounds.push([mlat, mlng]);
  }

  // 路线折线
  res.routes.forEach((r, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    const latlngs = r.coords.map(c => {
      const [mlng, mlat] = toMapLngLat(c[0], c[1], useGcj);
      return [mlat, mlng];
    });
    const line = L.polyline(latlngs, {
      color, weight: 4, opacity: 0.8,
    });
    line.bindTooltip(`车辆${r.vehicle_id} ${r.plate}<br>${r.stop_count}站 · ${r.distance_km}km · ${r.peak_load_kg}kg`);
    line.addTo(_leafletMap);
    _mapLayers.push(line);
  });

  // 异常点（红色，可能在地图视野外）
  nodes.filter(n => n.excluded && n.type === 'demand').forEach(n => {
    const [mlng, mlat] = toMapLngLat(n.lng, n.lat, useGcj);
    const m = L.marker([mlat, mlng], {
      icon: L.divIcon({
        className: 'anomaly-icon',
        html: '⚠️',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    });
    m.bindTooltip(`<b style="color:#d9534f">⚠️ 疑似异常坐标</b><br>${n.name}<br>距配送中心 ${n.dist_to_depot_km}km<br>未参与调度`);
    m.addTo(_leafletMap);
    _mapLayers.push(m);
  });

  if (bounds.length) {
    _leafletMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }
}

// ---- 示意图渲染（离线兜底）----
function renderSvgMap(res) {
  const svg = $('#mapSvg');
  const legend = $('#mapLegend');
  const W = 1000, H = 720;
  svg.innerHTML = '';
  legend.innerHTML = '';

  const nodes = res.nodes;
  // 求解范围内节点（用于地图比例）
  const solNodes = nodes.filter(n => n.in_solution);
  if (!solNodes.length) return;

  const lngs = solNodes.map(n => n.lng);
  const lats = solNodes.map(n => n.lat);
  let minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  let minLat = Math.min(...lats), maxLat = Math.max(...lats);

  // 补偿经纬度比例失真（纬度方向压缩）
  const midLat = (minLat + maxLat) / 2;
  const latScale = Math.cos(midLat * Math.PI / 180);
  let spanLng = (maxLng - minLng) * latScale || 0.01;
  let spanLat = (maxLat - minLat) || 0.01;
  const pad = 0.12;
  minLng -= spanLng * pad; maxLng += spanLng * pad;
  minLat -= spanLat * pad; maxLat += spanLat * pad;
  spanLng = maxLng - minLng; spanLat = maxLat - minLat;

  // 归一化范围保持宽高比
  const targetRatio = W / H;
  const curRatio = spanLng / spanLat;
  if (curRatio < targetRatio) {
    const add = (spanLat * targetRatio - spanLng) / 2;
    minLng -= add; maxLng += add;
  } else {
    const add = (spanLng / targetRatio - spanLat) / 2;
    minLat -= add; maxLat += add;
  }
  spanLng = maxLng - minLng; spanLat = maxLat - minLat;

  const toX = (lng) => ((lng - minLng) / spanLng) * W;
  const toY = (lat) => H - ((lat - minLat) / spanLat) * H;

  // 网格背景
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <pattern id="gridP" width="50" height="50" patternUnits="userSpaceOnUse">
      <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#d9e6f4" stroke-width="1"/>
    </pattern>`;
  svg.appendChild(defs);
  svg.appendChild(createSvgEl('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#gridP)' }));

  // 收集路线
  const routes = res.routes;
  routes.forEach((r, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    // 路线折线（直接使用 route 自带坐标，兼容求解索引与原始节点ID差异）
    const pts = r.coords.map(c => `${toX(c[0])},${toY(c[1])}`).filter(Boolean);
    svg.appendChild(createSvgEl('polyline', {
      points: pts.join(' '),
      fill: 'none', stroke: color, 'stroke-width': 2.6,
      'stroke-opacity': 0.75, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  });

  // 需求点（参与求解）
  solNodes.filter(n => n.type === 'demand').forEach(n => {
    const g = createSvgEl('g');
    g.appendChild(createSvgEl('circle', {
      cx: toX(n.lng), cy: toY(n.lat), r: 5.5,
      fill: '#ffffff', stroke: '#8ba0b5', 'stroke-width': 1.5,
    }));
    g.appendChild(createSvgEl('title', null, `${n.name}\n需求量: ${n.demand}kg\n距配送中心: ${n.dist_to_depot_km}km`));
    svg.appendChild(g);
  });

  // 排除的异常点（红色小叉，绘制在地图边缘位置）
  nodes.filter(n => n.excluded && n.type === 'demand').forEach(n => {
    let x = toX(n.lng), y = toY(n.lat);
    if (x < 0 || x > W || y < 0 || y > H) {
      x = Math.max(14, Math.min(W - 14, x));
      y = Math.max(14, Math.min(H - 14, y));
    }
    const g = createSvgEl('g');
    g.appendChild(createSvgEl('circle', {
      cx: x, cy: y, r: 7, fill: '#fdecea', stroke: '#d9534f', 'stroke-width': 1.5, 'stroke-dasharray': '3,2',
    }));
    g.appendChild(createSvgEl('line', { x1: x - 3, y1: y - 3, x2: x + 3, y2: y + 3, stroke: '#d9534f', 'stroke-width': 1.6 }));
    g.appendChild(createSvgEl('line', { x1: x + 3, y1: y - 3, x2: x - 3, y2: y + 3, stroke: '#d9534f', 'stroke-width': 1.6 }));
    g.appendChild(createSvgEl('title', null, `⚠️ ${n.name}\n距配送中心 ${n.dist_to_depot_km}km（疑似异常坐标，未参与调度）`));
    svg.appendChild(g);
  });

  // 配送中心
  const depot = solNodes.find(n => n.type === 'depot');
  if (depot) {
    const g = createSvgEl('g');
    g.appendChild(createSvgEl('circle', {
      cx: toX(depot.lng), cy: toY(depot.lat), r: 16,
      fill: 'rgba(230,126,34,.18)', stroke: '#e67e22', 'stroke-width': 2,
    }));
    g.appendChild(createSvgEl('circle', {
      cx: toX(depot.lng), cy: toY(depot.lat), r: 8,
      fill: '#e67e22', stroke: '#fff', 'stroke-width': 2,
    }));
    g.appendChild(createSvgEl('text', {
      x: toX(depot.lng), y: toY(depot.lat) - 22, 'text-anchor': 'middle',
      'font-size': 15, 'font-weight': 800, fill: '#d35400',
    }, '🏥 配送中心'));
    g.appendChild(createSvgEl('title', null, depot.name));
    svg.appendChild(g);
  }

  // 图例
  const lg = document.createElement('div');
  lg.className = 'lg-item';
  lg.innerHTML = `<span class="lg-dot" style="background:#e67e22"></span>配送中心`;
  legend.appendChild(lg);
  const lg2 = document.createElement('div');
  lg2.className = 'lg-item';
  lg2.innerHTML = `<span class="lg-dot" style="background:#fff;border:1.5px solid #8ba0b5"></span>需求点`;
  legend.appendChild(lg2);
  routes.slice(0, 8).forEach((r, i) => {
    const d = document.createElement('div');
    d.className = 'lg-item';
    d.innerHTML = `<span class="lg-swatch" style="background:${ROUTE_COLORS[i % ROUTE_COLORS.length]}"></span>车辆${r.vehicle_id} ${r.plate}`;
    legend.appendChild(d);
  });

  // tooltip 交互
  const tooltip = $('#mapTooltip');
  $$('#mapSvg circle, #mapSvg text').forEach(el => {
    const title = el.querySelector ? el.querySelector('title') : null;
    if (!title) return;
    const text = title.textContent;
    el.style.cursor = 'pointer';
    el.addEventListener('mousemove', (e) => {
      const rect = $('#mapWrap').getBoundingClientRect();
      tooltip.textContent = text;
      tooltip.style.left = (e.clientX - rect.left + 14) + 'px';
      tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      tooltip.hidden = false;
    });
    el.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  });
}

function createSvgEl(tag, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text) el.textContent = text;
  return el;
}

// ============================================================
// 成本分解环形图
// ============================================================
function renderCost(s) {
  const items = [
    { name: '固定出车成本', val: s.fixed_cost_yuan, color: '#0e7fd4' },
    { name: '里程运输成本', val: s.transit_cost_yuan, color: '#00a8a8' },
    { name: '制冷成本', val: s.cooling_cost_yuan, color: '#e67e22' },
  ];
  const total = items.reduce((a, b) => a + b.val, 0) || 1;
  $('#costTotal').textContent = '¥' + fmt(total, 0);

  // 图例
  $('#costLegend').innerHTML = items.map(it =>
    `<div class="cl-item">
       <span class="cl-swatch" style="background:${it.color}"></span>
       <span class="cl-name">${it.name}</span>
       <span class="cl-val">¥${fmt(it.val, 0)}</span>
       <span class="cl-pct">${(it.val / total * 100).toFixed(1)}%</span>
     </div>`).join('');

  // 环形图
  const canvas = $('#costCanvas');
  const ctx = canvas.getContext('2d');
  const cx = 110, cy = 110, R = 88, r = 52;
  ctx.clearRect(0, 0, 220, 220);
  let start = -Math.PI / 2;
  items.forEach(it => {
    const angle = (it.val / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = it.color;
    ctx.fill();
    start += angle;
  });
  // 内圆
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = '#dbe6f2';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ============================================================
// 路线明细
// ============================================================
function renderRoutes(res) {
  const list = $('#routeList');
  list.innerHTML = '';
  res.routes.forEach((r, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    const card = document.createElement('div');
    card.className = 'route-card';
    card.innerHTML = `
      <div class="route-head">
        <div class="route-badge" style="background:${color}">${r.vehicle_id}</div>
        <div class="route-title">
          <div class="plate">🚚 车辆${r.vehicle_id} · ${r.plate}</div>
          <div class="stops">${r.stop_count} 个站点 · 出发 ${r.start_time} · ${r.node_names.join(' → ')}</div>
        </div>
        <div class="route-stats">
          <span>载重 <b>${r.peak_load_kg}kg</b> <span class="route-load-bar"><div style="width:${Math.min(100, r.load_rate)}%"></div></span> ${r.load_rate}%</span>
          <span>里程 <b>${fmt(r.distance_km, 1)}</b> km</span>
          <span>耗时 <b>${r.total_time_h}</b> h</span>
          <span>成本 <b>¥${fmt(r.cost_yuan, 0)}</b></span>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="route-body">
        <table class="stop-table">
          <thead><tr><th>#</th><th>站点</th><th>需求量</th><th>到达时间</th><th>服务时长</th><th>累计载重</th></tr></thead>
          <tbody>
            <tr>
              <td><span class="stop-idx">D</span></td>
              <td>🏥 配送中心（出发）</td>
              <td>-</td><td>-</td><td>-</td><td>0 kg</td>
            </tr>
            ${r.stops.map((s, idx) => `
              <tr>
                <td><span class="stop-idx">${idx + 1}</span></td>
                <td><b>${s.name}</b></td>
                <td>${s.load} kg</td>
                <td>${s.arrive_time}</td>
                <td>${s.service_min} 分钟</td>
                <td>${s.cum_load} kg</td>
              </tr>`).join('')}
            <tr>
              <td><span class="stop-idx">D</span></td>
              <td>🏥 配送中心（返回）</td>
              <td>-</td><td>-</td><td>-</td><td>${r.peak_load_kg} kg</td>
            </tr>
          </tbody>
        </table>
      </div>`;
    card.querySelector('.route-head').addEventListener('click', () => {
      card.classList.toggle('open');
    });
    list.appendChild(card);
  });
}

// ============================================================
// 司机任务单
// ============================================================
function renderTasks(res) {
  const s = res.summary;
  const list = $('#taskList');
  list.innerHTML = '';
  res.routes.forEach((r, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    const seq = r.node_names.map((n, idx) =>
      idx === 0 ? `【始发】${n}` : idx === r.node_names.length - 1 ? `【返回】${n}` : `${n}`).join(' → ');
    const card = document.createElement('div');
    card.className = 'task-card';
    card.innerHTML = `
      <div class="task-head">
        <span class="task-plate">🚚 ${r.plate}</span>
        <span>任务日期: ${s.schedule_date}</span>
      </div>
      <div class="task-body">
        <div>司机：<b>车辆${r.vehicle_id} 驾驶员</b> | 发车: <b>${r.start_time}</b></div>
        <div>今日任务: <b>${r.stop_count}</b> 个站点 | 预计总耗时: <b>${r.total_time_h} h</b></div>
        <div class="task-route-line">${seq}</div>
        <div>总载重: <b>${r.peak_load_kg} kg</b>（装载率 ${r.load_rate}%） | 总里程: <b>${fmt(r.distance_km, 1)} km</b></div>
      </div>
      <div class="task-foot">⚠️ 全程保持 2~8℃ 冷链运输 · 交接时核对温度记录 · 签收单据随身带回</div>`;
    list.appendChild(card);
  });
}

// ============================================================
// 导出（纯前端 CSV）
// ============================================================
async function doExportCsv() {
  if (!currentResult) { toast('请先执行调度', 'err'); return; }
  try {
    const s = currentResult.summary;
    const rows = [];
    rows.push(['车辆编号', '车牌号', '途经站点数', '总载重(kg)', '装载率(%)',
      '行驶距离(km)', '总耗时(h)', '出发时间', '路线成本(¥)', '冷链温度', '途经网点']);
    currentResult.routes.forEach(r => {
      rows.push([`车辆${r.vehicle_id}`, r.plate, r.stop_count, r.peak_load_kg,
        r.load_rate + '%', r.distance_km, r.total_time_h, r.start_time,
        r.cost_yuan, '2~8℃', r.node_names.join(' → ')]);
    });
    rows.push([]);
    rows.push(['汇总', `共${s.used_vehicles}辆车 | 日期 ${s.schedule_date}`, '',
      s.total_delivered_kg, `平均 ${s.avg_load_rate}%`, s.total_distance_km,
      s.total_drive_time_h, '', `总成本 ¥${s.total_cost_yuan.toFixed(2)}`, '全程2~8℃', '']);

    const csv = rows.map(row =>
      row.map(cell => {
        const str = String(cell ?? '');
        return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
      }).join(',')).join('\r\n');
    // BOM 支持 Excel 中文
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `冷链配送方案_${s.schedule_date}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('📄 CSV 方案已导出', 'ok');
  } catch (e) {
    toast('导出失败: ' + e.message, 'err');
  }
}

// 导出配送路线 JSON（供配载模块联动：卸货顺序按站点顺序）
async function doExportRouteJson() {
  if (!currentResult) { toast('请先执行调度', 'err'); return; }
  try {
    const routes = currentResult.routes.map(r => ({
      vehicle_name: `车辆${r.vehicle_id} ${r.plate}`,
      plate: r.plate,
      stops: r.node_names,
    }));
    const payload = {
      app: 'cold_chain_scheduler',
      version: '3.0',
      schedule_date: currentResult.summary.schedule_date,
      routes,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `配送路线_${currentResult.summary.schedule_date}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('🗺️ 路线 JSON 已导出（可在配载模块导入联动）', 'ok');
  } catch (e) {
    toast('导出失败: ' + e.message, 'err');
  }
}

// ============================================================
// OrderStore 集成：求解结果 → 工单（统一数据源）
// ============================================================
// 将求解结果转为 Order 工单写入 OrderStore（replace 模式：每次重解刷新计划，
// 保留已有执行进度 —— 已发车及之后的工单不回退状态）
function syncOrdersFromResult(res, scheduleDate) {
  if (typeof OrderModel === 'undefined') return;
  const prev = new Map(OrderStore.listOrders().map(o => [o.refId, o]));
  const newOrders = [];
  res.routes.forEach(r => {
    r.stops.forEach((s, si) => {
      const old = prev.get(s.node_id);
      const base = {
        refId: s.node_id,
        customer: s.name,
        demandKg: s.load,
        routeId: r.vehicle_id,
        routePlate: r.plate,
        stopSeq: si + 1,
        planArrive: s.arrive_time,
        serviceMin: s.service_min,
      };
      // 执行进度保留：已流转的工单不重置（可换车/换序，进度跟着收货方走）
      if (old && old.status !== 'planned') {
        newOrders.push({ ...old.toJSON ? old.toJSON() : old, ...base });
      } else {
        newOrders.push(base);
      }
    });
  });
  OrderStore.putOrders(newOrders, { replace: true });
}

// ============================================================
// 执行跟踪闭环：工单状态流转 + 计划 vs 实际
// ============================================================
function renderTracking() {
  const card = $('#trackingCard');
  if (typeof OrderModel === 'undefined') { card.hidden = true; return; }
  const orders = OrderStore.listOrders();
  if (!orders.length) { card.hidden = true; return; }
  card.hidden = false;

  const st = OrderStore.stats();
  $('#trackTotal').textContent = st.total;
  $('#trackDone').textContent = st.byStatus.done || 0;
  $('#trackPending').textContent = st.total - (st.byStatus.done || 0);
  $('#trackOnTime').textContent = st.onTimeRate == null ? '-' : st.onTimeRate + '%';

  const list = $('#trackList');
  list.innerHTML = '';
  // 按路线分组渲染
  const byRoute = new Map();
  orders.forEach(o => {
    const key = o.routeId != null ? o.routeId : 0;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(o);
  });
  [...byRoute.entries()].sort((a, b) => a[0] - b[0]).forEach(([routeId, group]) => {
    group.sort((a, b) => (a.stopSeq || 0) - (b.stopSeq || 0));
    const head = document.createElement('div');
    head.className = 'track-route-head';
    const plate = group[0].routePlate || '';
    const doneCount = group.filter(o => o.status === 'done').length;
    head.innerHTML = `🚚 车辆${routeId} ${esc(plate)} · ${doneCount}/${group.length} 完成`;
    list.appendChild(head);
    group.forEach(o => list.appendChild(renderTrackRow(o)));
  });
}

function renderTrackRow(o) {
  const ST = OrderModel.ORDER_STATUS;
  const st = ST[o.status] || ST.planned;
  const row = document.createElement('div');
  row.className = 'track-row ' + o.status;
  // 实际到达 vs 计划（准点判定 ±30min）
  let punctual = '';
  if (o.status === 'done' || (o.actual && o.actual.arrived)) {
    if (o.actual && o.actual.arrived && o.planArrive) {
      const pm = parseHM(o.planArrive);
      const ad = new Date(o.actual.arrived);
      const am = ad.getHours() * 60 + ad.getMinutes();
      const diff = Math.min(Math.abs(am - pm), 1440 - Math.abs(am - pm));
      punctual = diff <= 30 ? '<span class="punctual ok">✅ 准点</span>' : '<span class="punctual late">⏰ 迟到' + diff + '分钟</span>';
    }
  }
  const actualTime = o.actual && o.actual[o.status]
    ? new Date(o.actual[o.status]).toTimeString().slice(0, 5) : '';
  row.innerHTML = `
    <div class="track-main">
      <span class="track-seq">${o.stopSeq || '-'}</span>
      <span class="track-customer">${esc(o.customer)}</span>
      <span class="track-demand">${o.demandKg}kg</span>
      <span class="track-plan">计划到达 ${o.planArrive || '-'}${actualTime ? ' · 实际 ' + actualTime : ''}</span>
      ${punctual}
    </div>
    <div class="track-actions">
      ${st.next.map(nk => `<button class="btn-mini track-btn" data-oid="${o.id}" data-next="${nk}">${ST[nk].label}</button>`).join('')}
      <span class="track-status-badge" style="color:${st.color}">● ${st.label}</span>
    </div>`;
  row.querySelectorAll('.track-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = OrderStore.setStatus(btn.dataset.oid, btn.dataset.next);
      if (!r.ok) { toast('❌ ' + r.reason, 'err'); return; }
      renderTracking(); // 刷新面板（配载页经 storage 事件自动同步）
    });
  });
  return row;
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 启动
document.addEventListener('DOMContentLoaded', init);

})();
