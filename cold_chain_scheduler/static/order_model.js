/* ============================================================
 * Order 统一数据模型 + OrderStore 跨页面共享存储
 * ------------------------------------------------------------
 * 职责：
 *   1. Order 领域对象：收货方/坐标/温层/时间窗/货品/执行状态，
 *      贯穿「调度 → 配载 → 执行跟踪」全生命周期的统一数据源
 *   2. OrderStore：localStorage 持久化 + storage 事件跨页面同步，
 *      取代调度页→配载页的 JSON 文件搬运
 *
 * 温层枚举 tempClass：
 *   frozen  = 冷冻 (-18℃)
 *   cold    = 冷藏 (2~8℃)
 *   normal  = 常温
 * 车辆温区 temp_zones = ['frozen','cold','normal'] 的子集，
 * 兼容旧字符串 "2~8℃"。
 *
 * 工单状态 status（执行跟踪闭环）：
 *   planned → dispatched → arrived → unloaded → done
 *   (计划)    (已发车)     (已到达)   (已卸货)   (完成)
 * ============================================================ */
const OrderModel = (() => {
'use strict';

// ---------- 常量 ----------
const TEMP_CLASSES = {
  frozen: { key: 'frozen', label: '冷冻', temp: '-18℃', color: '#5b8def', rank: 0 },
  cold:   { key: 'cold',   label: '冷藏', temp: '2~8℃', color: '#16a085', rank: 1 },
  normal: { key: 'normal', label: '常温', temp: '常温',  color: '#8ba0b5', rank: 2 },
};

const ORDER_STATUS = {
  planned:    { key: 'planned',    label: '计划',   color: '#8ba0b5', next: ['dispatched'] },
  dispatched: { key: 'dispatched', label: '已发车', color: '#0e7fd4', next: ['arrived'] },
  arrived:    { key: 'arrived',    label: '已到达', color: '#e6a23c', next: ['unloaded'] },
  unloaded:   { key: 'unloaded',   label: '已卸货', color: '#9b59b6', next: ['done'] },
  done:       { key: 'done',       label: '完成',   color: '#2eb872', next: [] },
};

const STORAGE_KEY = 'ccs.orders.v1';
const SCHEMA_VERSION = 1;

// ---------- 工具 ----------
function uid(prefix) {
  return (prefix || 'o') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeTempClass(v) {
  if (!v) return 'normal';
  const s = String(v).trim().toLowerCase();
  if (s in TEMP_CLASSES) return s;
  if (s.includes('冻') || s.includes('-18') || s.includes('frozen')) return 'frozen';
  if (s.includes('冷') || s.includes('2~8') || s.includes('2-8') || s.includes('cold') || s.includes('chill')) return 'cold';
  return 'normal';
}

// 旧数据兼容：nodes 数组（调度页 Excel/演示数据）→ Order 数组
function fromSolverNodes(nodes) {
  const list = [];
  (nodes || []).forEach(n => {
    if (!n || n.type === 'depot') return;
    list.push(create({
      refId: n.node_id,
      customer: n.name,
      address: n.address || '',
      lng: n.lng,
      lat: n.lat,
      demandKg: n.demand || 0,
      serviceMin: Math.round((n.service_h || 0.01) * 60),
      twStart: n.tw_start || '08:00',
      twEnd: n.tw_end || '23:00',
      tempClass: normalizeTempClass(n.temp_class || n.tempClass),
      goods: (n.demand || 0) ? [{ name: '药品', qty: 1, weightKg: n.demand || 0 }] : [],
    }));
  });
  return list;
}

// 车辆温区归一化：兼容 undefined / "2~8℃" / ['cold','normal']
function normalizeTempZones(v) {
  if (!v || v === '*') return ['frozen', 'cold', 'normal'];
  if (Array.isArray(v)) {
    const zs = v.map(normalizeTempClass);
    return zs.length ? [...new Set(zs)] : ['frozen', 'cold', 'normal'];
  }
  const s = String(v);
  return [...new Set([normalizeTempClass(s)])];
}

// ---------- Order 工厂 ----------
function create(partial) {
  const p = partial || {};
  const now = new Date().toISOString();
  return {
    id: p.id || uid('ord'),
    refId: p.refId != null ? p.refId : null,      // 源节点 ID（调度数据回溯）
    customer: p.customer || '未命名收货方',
    address: p.address || '',
    lng: Number(p.lng) || 0,
    lat: Number(p.lat) || 0,
    demandKg: Number(p.demandKg) || 0,
    serviceMin: Number(p.serviceMin) || 30,
    twStart: p.twStart || '08:00',
    twEnd: p.twEnd || '23:00',
    tempClass: normalizeTempClass(p.tempClass),
    goods: Array.isArray(p.goods) ? p.goods : [],   // [{name,qty,weightKg,l,w,h,...}]
    stopSeq: p.stopSeq != null ? p.stopSeq : null,  // 路线内站点序号（求解后回填）
    routeId: p.routeId != null ? p.routeId : null,  // 所属路线（求解后回填）
    // ---- 执行跟踪 ----
    status: ORDER_STATUS[p.status] ? p.status : 'planned',
    planArrive: p.planArrive || '',                 // 计划到达 HH:MM
    actual: p.actual || {},                         // {dispatched, arrived, unloaded, done} 实际时间戳
    createdAt: p.createdAt || now,
    updatedAt: now,
  };
}

// ============================================================
// OrderStore：localStorage 持久化 + 跨页面同步
// ============================================================
const OrderStore = {
  _cache: null,
  _listeners: [],

  _read() {
    if (this._cache) return this._cache;
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORAGE_KEY);
      this._cache = raw ? JSON.parse(raw) : { version: SCHEMA_VERSION, orders: [], routes: null };
      if (!this._cache.orders) this._cache.orders = [];
      if (typeof this._cache.version !== 'number') this._cache.version = SCHEMA_VERSION;
    } catch (e) {
      this._cache = { version: SCHEMA_VERSION, orders: [], routes: null };
    }
    return this._cache;
  },

  _write(data) {
    this._cache = data;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      }
    } catch (e) { /* 存储满/隐私模式：降级为内存态 */ }
    return data;
  },

  // 订阅变更（跨页面 storage 事件 + 本页写操作都会触发）
  subscribe(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter(f => f !== fn);
    };
  },

  _emit() {
    this._listeners.forEach(fn => {
      try { fn(this._read()); } catch (e) { /* listener 异常不阻断 */ }
    });
  },

  // ---- Order CRUD ----
  listOrders() { return this._read().orders.slice(); },
  getOrder(id) { return this._read().orders.find(o => o.id === id) || null; },
  count() { return this._read().orders.length; },

  putOrder(order) {
    const o = create(order && order.id ? order : order); // 补全缺省字段
    const data = this._read();
    const idx = data.orders.findIndex(x => x.id === o.id);
    o.updatedAt = new Date().toISOString();
    if (idx >= 0) data.orders[idx] = o; else data.orders.push(o);
    this._write(data);
    this._emit();
    return o;
  },

  putOrders(orderList, opts) {
    const replace = opts && opts.replace;
    const data = this._read();
    data.orders = replace ? [] : data.orders;
    (orderList || []).forEach(p => {
      const o = create(p);
      const idx = replace ? -1 : data.orders.findIndex(x => x.id === o.id);
      if (idx >= 0) data.orders[idx] = o; else data.orders.push(o);
    });
    this._write(data);
    this._emit();
    return data.orders.length;
  },

  removeOrder(id) {
    const data = this._read();
    const before = data.orders.length;
    data.orders = data.orders.filter(o => o.id !== id);
    if (data.orders.length !== before) { this._write(data); this._emit(); }
    return before - data.orders.length;
  },

  clear() {
    this._write({ version: SCHEMA_VERSION, orders: [], routes: null });
    this._emit();
  },

  // ---- 路线快照（调度页写入 → 配载页直读，免 JSON 搬运）----
  // routesData: VrpSolver 结果（含 summary/routes/nodes/params）
  setRoutes(routesData) {
    const data = this._read();
    data.routes = routesData ? JSON.parse(JSON.stringify(routesData)) : null;
    data.savedAt = new Date().toISOString();
    this._write(data);
    this._emit();
  },

  getRoutes() { return this._read().routes || null; },
  savedAt() { return this._read().savedAt || null; },

  // ---- 执行状态流转 ----
  // allowed: {ok, order} / {ok:false, reason}
  // 校验：目标状态必须在「当前状态」的 next 列表中（planned→dispatched→arrived→unloaded→done）
  setStatus(orderId, status, timestampIso) {
    const data = this._read();
    const o = data.orders.find(x => x.id === orderId);
    if (!o) return { ok: false, reason: '工单不存在' };
    const st = ORDER_STATUS[status];
    if (!st) return { ok: false, reason: `未知状态: ${status}` };
    const cur = ORDER_STATUS[o.status] || ORDER_STATUS.planned;
    if (!cur.next.includes(status)) {
      return { ok: false, reason: `不允许从 ${cur.label} 跳转到 ${st.label}` };
    }
    o.status = status;
    o.actual = o.actual || {};
    o.actual[status] = timestampIso || new Date().toISOString();
    o.updatedAt = new Date().toISOString();
    this._write(data);
    this._emit();
    return { ok: true, order: o };
  },

  // 计划 vs 实际对比统计（准点率等）
  stats() {
    const orders = this._read().orders;
    const byStatus = { planned: 0, dispatched: 0, arrived: 0, unloaded: 0, done: 0 };
    let onTime = 0, late = 0, pending = 0;
    orders.forEach(o => {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      if (o.status === 'done' && o.actual && o.actual.arrived && o.planArrive) {
        const plan = hhmmToMin(o.planArrive);
        const act = new Date(o.actual.arrived);
        if (!isNaN(act) && plan != null) {
          const actMin = act.getHours() * 60 + act.getMinutes();
          const diff = (actMin - plan + 1440) % 1440;
          if (diff <= 30) onTime++; else late++;
        }
      } else if (o.status !== 'done') {
        pending++;
      }
    });
    const total = orders.length;
    return {
      total, byStatus, onTime, late, pending,
      onTimeRate: (onTime + late) ? Math.round(onTime / (onTime + late) * 1000) / 10 : null,
    };
  },

  // ---- 导入导出（备份/跨设备）----
  exportJSON() {
    return JSON.stringify(this._read(), null, 2);
  },

  importJSON(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    if (!data || !Array.isArray(data.orders)) throw new Error('无效的 OrderStore 数据（缺少 orders）');
    data.orders = data.orders.map(o => create(o)); // 补全字段 + 版本迁移
    data.version = SCHEMA_VERSION;
    this._write(data);
    this._emit();
    return data.orders.length;
  },
};

function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// 跨页面同步：其他页面写入 → 本页刷新缓存并通知
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    OrderStore._cache = null;          // 失效缓存，下次读取重新拉
    OrderStore._emit();
  });
}

return {
  TEMP_CLASSES, ORDER_STATUS, STORAGE_KEY, SCHEMA_VERSION,
  create, fromSolverNodes, normalizeTempClass, normalizeTempZones,
  OrderStore,
};

})();

// CommonJS 导出（Node 测试；浏览器端此分支不生效）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OrderModel;
}
