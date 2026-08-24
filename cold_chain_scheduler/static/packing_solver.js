/* ============================================================
 * 大件货品智能配载引擎（3D Bin Packing）v5
 * 算法：Guillotine 空间分割 + BLB(左下后)放置 + 约束检查
 * 支持：任意尺寸货品、旋转、堆叠承重、车辆载重/体积约束
 * ------------------------------------------------------------
 * v4（stop-aware 装箱 + 温度约束）：
 *   1. 温区约束：container.temp_zones = ['cold','normal',...]，
 *      温层不符的货品不装入该车（进入 unpacked，reason='temp_zone'）
 *   2. stop-aware 装箱：货品带 stop（站点名）时，按站点访问
 *      逆序装车——后到站点的货装车厢深处（低x），先到站点靠
 *      车门（高x，车门在 x=L 端），减少卸货时翻箱
 *   3. 车队级站点感知分配：solveFleet 支持 routeStops（车辆名→
 *      站点顺序），货品优先分配给路线包含其站点的车辆，
 *      消除旧版"同站货物散落多车"的缺陷
 *   4. stopReport：装箱后输出各站点区块分布 + 卸货顺序违规数
 *      （检测"后到站货物挡住先到站货物"的物理阻挡）
 * ------------------------------------------------------------
 * v5（大件业务约束层——全部可选参数，旧调用零影响）：
 *   5. 订单完整性：货品带 groupId（订单号）时，同组必须同车
 *      且整组装入或整组回退（unpacked 标 reason='group_incomplete'）。
 *      solveFleet 按"订单聚合"分配：组是分配的最小单位，任一
 *      件装不下则整组让位给下一辆车，杜绝"沙发送一半"
 *   6. 轴荷校验：container.axle = { wheelbase_cm, front_limit_kg,
 *      rear_limit_kg, curb_front_kg, curb_rear_kg } 时启用硬校验：
 *      按货物合重心位置反推前/后轴载荷（叠加空车轴荷），超限
 *      即拒装该件（reason='axle_overload'），并输出 axleReport
 *   7. 品类隔离：货品带 category，container.incompat = {
 *      '木架家具': ['玻璃面板'] } 声明冲突品类对；货品 padding =
 *      {l,w,h} 防护增量（木架+8~12cm/边、衬垫+2~3cm/边）计入
 *      装箱尺寸；同车不同冲突品类直接拒装（reason='category'）
 *   8. 超长件尾悬：container.overhang_max = cm 时，l 超过车厢长
 *      的货品允许"厢内+悬伸"装载（悬伸 ≤ overhang_max 且 ≤ 30%
 *      厢长），横放贴 x=L 门端，stats.overhangs 输出明细。
 *      悬伸件不参与堆叠（maxStack 视为 0）
 * ------------------------------------------------------------
 * v5.2（算法增强层一：承重链传递校验——默认启用，向后兼容）：
 *  11. 承重链：放置新箱时，压力沿支撑树向下传递——直接支撑箱
 *      及其下方整条链上的每只箱都校验 累计载荷(_load)+新箱重
 *      ≤ maxStack（旧逻辑只查直接下方箱对新箱自重，既不累计
 *      同层多箱、也不传递到更底层；maxStack=Infinity 短路剪枝）
 *  12. 分组回退修复：_rollbackGroup 的 removedIds 构造错误（取
 *      p.box 而列表存的即是箱对象）导致回退失效；_replayBox
 *      现按坐标重建空间索引（_carveSpaces 六面切割）并重建
 *      支撑关系/载荷，杜绝回退后新装箱与重放箱重叠
 *  13. stop-aware λ 自适应：options.stopPenaltyMode='adaptive' 时
 *      罚项 λ = 5e4 × (W/L) / log(2+站点数)——宽厢/长厢按厢长
 *      归一、多站场景按站点数衰减；默认 'legacy' 固定 5e4（快照兼容）
 * ------------------------------------------------------------
 * v5.1（滚动排程联动层——可选参数，全部向后兼容）：
 *   9. 门端可达：container.door_zone_pct（门端区占厢长%，如 30）+
 *      container.heavy_kg（重物阈值，缺省 80）。重量 ≥ 阈值的货品
 *      必须完全落在 x ∈ [(1-pct/100)L, L] 门端区（尾板可达），
 *      否则该位置不可选（unpacked reason 同空间不足）
 *  10. 回程空间预留：container.reserve_ratio（0~80）。装载体积
 *      硬上限 = 厢容 × (1 - ratio/100)，为以旧换新取旧/拆包垃圾
 *      预留尾部空间（unpacked reason='reserve_quota' 场景：与
 *      空间不足同路径，stats 输出 effective_volume_cap）
 *  11. 动态件数上限：container.max_items（送装工时折算的日装
 *      载上限）。超出上限的货品拒装（reason='max_items'），
 *      stats 输出 items_rate
 *  12. 滚动重配载：solveIncremental(container, lockedBoxes,
 *      newItems, options)——已装箱锚定原坐标，自由空间扣除
 *      locked 箱后重解新货；boxes 含 locked 箱（locked:true）
 * ============================================================ */
const PackingSolver = (() => {
'use strict';

// ---------- 温层工具 ----------
function normalizeTempClass(v) {
  if (!v) return 'normal';
  const s = String(v).trim().toLowerCase();
  if (s === 'frozen' || s === 'cold' || s === 'normal') return s;
  if (s.includes('冻') || s.includes('-18')) return 'frozen';
  if (s.includes('冷') || s.includes('2~8') || s.includes('2-8')) return 'cold';
  if (s.includes('常')) return 'normal';
  return 'normal';
}

function normalizeTempZones(v) {
  if (!v) return ['frozen', 'cold', 'normal'];
  if (Array.isArray(v)) {
    const zs = v.map(normalizeTempClass);
    return zs.length ? [...new Set(zs)] : ['frozen', 'cold', 'normal'];
  }
  return [normalizeTempClass(v)];
}

// ---------- 基础工具 ----------
function volume(b) { return b.l * b.w * b.h; }

function fits(a, b) {
  // a 是否能放入 b（a/b: {l,w,h}）
  return (a.l <= b.l + 1e-9 && a.w <= b.w + 1e-9 && a.h <= b.h + 1e-9);
}

// 货物所有可放置朝向（6 种旋转，可倒置时全 6 种，否则 4 种不翻转）
function orientations(item) {
  const { l, w, h } = item;
  const list = [];
  const add = (x, y, z) => list.push({ l: x, w: y, h: z });
  if (item.canRotate !== false) {
    add(l, w, h); add(l, h, w); add(w, l, h); add(w, h, l); add(h, l, w); add(h, w, l);
    // 去重
    const seen = new Set();
    return list.filter(o => {
      const k = `${o.l},${o.w},${o.h}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  // 不可旋转（或仅水平旋转）
  add(l, w, h);
  if (item.horizontalRotate) { add(w, l, h); }
  return list;
}

// ---------- v5 大件约束工具 ----------
// 防护增量归一化：{l,w,h} 数字或 {each_l,...} 每边增量 → 总尺寸增量
function normalizePadding(p) {
  if (!p) return null;
  const num = (v) => (typeof v === 'number' && v > 0 ? v : 0);
  if (typeof p === 'number') return { l: p, w: p, h: p };
  return {
    l: (p.each_l || 0) * 2 + num(p.l),
    w: (p.each_w || 0) * 2 + num(p.w),
    h: (p.each_h || 0) * 2 + num(p.h),
  };
}

// 冲突品类对查找：incompat 表 → Set("a|b") 规范化键（字典序）
function buildIncompatSet(incompat) {
  if (!incompat) return null;
  const set = new Set();
  Object.entries(incompat).forEach(([a, arr]) => {
    (Array.isArray(arr) ? arr : [arr]).forEach(b => {
      set.add([String(a), String(b)].sort().join('|'));
    });
  });
  return set;
}

function categoriesConflict(set, a, b) {
  if (!set || !a || !b || a === b) return false;
  return set.has([String(a), String(b)].sort().join('|'));
}

// 轴荷计算：按货物合重心反推前/后轴载荷（cm/kg）
// x=0 为车厢前端（车头侧），轴距基准：前轴在 x=axle_ref_front（默认 0，即车厢前缘之前）
function axleLoads(boxes, totalWeight, axle, L) {
  // 合重心 x（车头侧为 0）
  let mx = 0;
  boxes.forEach(b => { mx += (b.item.weight || 0) * (b.x + b.l / 2); });
  const cx = totalWeight > 0 ? mx / totalWeight : L / 2;
  // 前轴位置：取 axle.front_axle_at_cm（默认 0 = 车厢前缘），后轴 = 前轴 + wheelbase
  const fa = (axle.front_axle_at_cm != null ? axle.front_axle_at_cm : 0);
  const ra = fa + axle.wheelbase_cm;
  // 货物载荷分配：合力点距前轴 d，前轴分担 (1 - d/wb)，后轴分担 d/wb
  // d = cx - fa（重心在后轴之后时前轴为负分担，物理上即翘头，按 0 处理）
  const d = cx - fa;
  const wb = axle.wheelbase_cm;
  const rearShare = Math.min(1, Math.max(0, d / wb));       // 后轴分担比例 [0,1]
  const frontShare = 1 - rearShare;
  const cargoFront = totalWeight * frontShare;
  const cargoRear = totalWeight * rearShare;
  return {
    cx,
    front_kg: Math.round(((axle.curb_front_kg || 0) + cargoFront) * 10) / 10,
    rear_kg: Math.round(((axle.curb_rear_kg || 0) + cargoRear) * 10) / 10,
    front_ok: cargoFront + (axle.curb_front_kg || 0) <= (axle.front_limit_kg || Infinity) + 1e-9,
    rear_ok: cargoRear + (axle.curb_rear_kg || 0) <= (axle.rear_limit_kg || Infinity) + 1e-9,
    front_pct: axle.front_limit_kg ? Math.round((cargoFront + (axle.curb_front_kg || 0)) / axle.front_limit_kg * 1000) / 10 : null,
    rear_pct: axle.rear_limit_kg ? Math.round((cargoRear + (axle.curb_rear_kg || 0)) / axle.rear_limit_kg * 1000) / 10 : null,
  };
}

// 超长件尺寸工具：返回厢内段与悬伸段（x 贴 L 端门放，悬伸朝外）
function overhangDims(item, L, W, H, overhangMax) {
  // 允许的最大悬伸 = min(overhang_max, 30% 厢长)
  const maxOv = Math.min(overhangMax, L * 0.3);
  // 尝试竖放（长边沿 x，超出部分悬伸）
  if (item.l > L && item.l - L <= maxOv + 1e-9
      && item.w <= W + 1e-9 && item.h <= H + 1e-9) {
    return { inside_l: L, overhang_l: item.l - L, orient: { l: item.l, w: item.w, h: item.h } };
  }
  return null;
}

// ---------- 求解（单车）----------
/**
 * 输入：
 *   container: { l, w, h, max_weight, temp_zones?,
 *               axle?,          // v5: { wheelbase_cm, front_limit_kg, rear_limit_kg, curb_front_kg?, curb_rear_kg?, front_axle_at_cm? }
 *               incompat?,      // v5: { '品类A': ['品类B', ...] } 冲突品类对
 *               overhang_max?,  // v5: 允许的最大尾悬 cm
 *               }
 *   items: [{ id, name, l, w, h, weight, qty, canRotate, maxStack, color,
 *             stop?, tempClass?|temp?|temp_class?,
 *             groupId?,        // v5: 订单分组（同组必须同车、整组装入）
 *             category?,       // v5: 品类（配合 container.incompat 隔离）
 *             padding?,        // v5: {l,w,h} 或 {each_l,...} 防护增量
 *             overhang?,       // v5: true 时允许该件尾悬（配合 overhang_max）
 *           }]
 *   options: {
 *     strategy: 'volume'|'weight'|'bottom'|'longest',
 *     allowStack: true,
 *     stopAware?: bool,
 *     stopOrder?: string[],
 *     groupMode?: 'strict'|'off',   // v5: 默认 strict（有 groupId 即启用）
 *   }
 * 输出：
 *   { success, packed, unpacked, boxes, stats, gravity, layers, stopReport,
 *     axleReport?, overhangs? }
 */
function solve(container, items, options = {}) {
  const L = container.l, W = container.w, H = container.h;
  const maxWeight = container.max_weight || Infinity;
  const allowStack = options.allowStack !== false;
  const strategy = options.strategy || 'volume';

  // v5 约束参数
  const axle = container.axle || null;
  const incompatSet = buildIncompatSet(container.incompat);
  const overhangMax = container.overhang_max || 0;
  const groupMode = options.groupMode !== 'off';

  // v5.1 门端可达：重物强制落门端区（x=L 端尾板可达范围）
  // door_zone_pct：门端区占厢长比例（如 30 → x ∈ [0.7L, L]）
  // heavy_kg：重量阈值，≥ 该值的货品必须落在门端区（缺省 80）
  const doorZonePct = (container.door_zone_pct > 0) ? Math.min(container.door_zone_pct, 100) : 0;
  const heavyKg = container.heavy_kg != null ? container.heavy_kg : 80;
  const doorZoneStart = doorZonePct > 0 ? L * (1 - doorZonePct / 100) : null;

  // v5.1 回程空间预留：reserve_ratio（0~100），车厢尾部预留体积配额，
  // 装载体积不得超过 (1 - reserve_ratio) × 厢容
  const reserveRatio = (container.reserve_ratio > 0) ? Math.min(container.reserve_ratio, 80) : 0;
  const reserveVol = reserveRatio > 0 ? L * W * H * reserveRatio / 100 : 0;
  const effectiveVolCap = L * W * H - reserveVol;

  // v5.1 动态件数上限：max_items（送装工时折算），超过即拒装
  const maxItems = (container.max_items > 0) ? container.max_items : 0;

  // v5.1 滚动重配载：lockedBoxes（已装箱锚定），初始化空间索引时
  // 把已装箱占用的空间从自由空间中扣除，新货只装进剩余空间
  const lockedBoxes = Array.isArray(options.lockedBoxes) ? options.lockedBoxes : null;

  // 温区：车厢支持的温层（缺省全温区，兼容旧调用）
  const containerZones = normalizeTempZones(container.temp_zones);

  // 站点访问顺序映射：stop 名 → 序号（0 = 第一站）
  const stopSeqMap = new Map();
  (options.stopOrder || []).forEach((s, i) => {
    if (s) stopSeqMap.set(String(s), i);
  });
  const stopAware = options.stopAware !== false && options.stopOrder && options.stopOrder.length > 0;
  // v5.2：stop-aware 罚项模式——'legacy'（默认，固定 5e4）| 'adaptive'（归一化）
  const stopPenaltyMode = options.stopPenaltyMode === 'adaptive' ? 'adaptive' : 'legacy';

  // 展开数量（温层不匹配的货品直接进入剔除清单）
  // v5：尺寸累加防护增量 padding；groupId/category 透传
  const units = [];
  const tempRejected = [];   // 温层不符：[{...item 摘要, reason:'temp_zone'}]
  const overhangUnits = [];  // v5：尾悬件（单独处理，最后装箱）
  items.forEach((it, idx) => {
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const tempClass = normalizeTempClass(it.tempClass ?? it.temp ?? it.temp_class);
    const zoneOk = containerZones.includes(tempClass);
    const stop = it.stop ? String(it.stop) : '';
    const stopSeq = stop && stopSeqMap.has(stop) ? stopSeqMap.get(stop) : null;
    const pad = normalizePadding(it.padding);
    const pl = pad ? pad.l : 0, pw = pad ? pad.w : 0, ph = pad ? pad.h : 0;
    const canOverhang = overhangMax > 0 && it.overhang === true;
    for (let k = 0; k < qty; k++) {
      const u = {
        id: it.id || `${it.name}_${idx}`,
        name: it.name || `货品${idx + 1}`,
        l: it.l + pl, w: it.w + pw, h: it.h + ph,   // 防护增量后的装箱尺寸
        rawL: it.l, rawW: it.w, rawH: it.h,          // 原始尺寸（报告用）
        padding: pad,
        weight: it.weight || 0,
        canRotate: it.canRotate !== false,
        horizontalRotate: !!it.horizontalRotate,
        maxStack: it.maxStack || Infinity,   // 可承受上方总重(kg)
        color: it.color,
        type: it.type || 'general',
        stop, stopSeq,
        tempClass,
        groupId: it.groupId != null ? String(it.groupId) : null,
        category: it.category != null ? String(it.category) : null,
        overhang: canOverhang,
      };
      if (!zoneOk) tempRejected.push(u); else units.push(u);
    }
  });

  // v5：拆出尾悬件（仅当允许且确实超长，否则留在普通流程——
  // 超长但不允许悬伸的会在 packOnce 中正常 unpack）
  const normalUnits = [];
  units.forEach(u => {
    if (u.overhang) {
      const od = overhangDims(u, L, W, H, overhangMax);
      if (od) { u._overhang = od; overhangUnits.push(u); return; }
    }
    normalUnits.push(u);
  });

  // v5：品类隔离预检——冲突品类对若同车（含数量>1 同品类自身无冲突）
  // 以第一件出现的品类为基准：同车只允许与"已装品类集合"无冲突的品类
  const unitCategory = (u) => u.category;

  // v5：订单分组索引
  const groupOf = new Map();  // groupId -> [units]
  units.forEach(u => {
    if (u.groupId && groupMode) {
      if (!groupOf.has(u.groupId)) groupOf.set(u.groupId, []);
      groupOf.get(u.groupId).push(u);
    }
  });

  // 空间评分：BLB 优先（越靠下、越靠后、越靠左越好）
  function scoreSpace(space) {
    return space.y * 10000 + space.z * 100 + space.x;
  }

  // v5.1：初始自由空间——locked 模式下把已装箱扣除
  // 简化实现：把每个 locked box 视为依次放入全空车厢（不分割，直接
  // 从包含它的空间块切割）。沿用 _splitSpace 的三切逻辑。
  // 门端约束启用时预切一刀：门端区 [doorZoneStart, L] 独立成块，
  // 重物可自然落入（BLB 只放块起点，不预切则重物永远够不到门端）。
  function initialSpaces() {
    let spaces;
    if (doorZoneStart != null) {
      spaces = [
        { x: 0, y: 0, z: 0, l: doorZoneStart, w: W, h: H },
        { x: doorZoneStart, y: 0, z: 0, l: L - doorZoneStart, w: W, h: H },
      ].filter(s => s.l > 0.01);
    } else {
      spaces = [{ x: 0, y: 0, z: 0, l: L, w: W, h: H }];
    }
    if (!lockedBoxes || !lockedBoxes.length) return spaces;
    // locked box: {x,y,z,l,w,h,item?}——item 仅用于重量/属性统计
    for (const lb of lockedBoxes) {
      const next = [];
      for (const sp of spaces) {
        // 与 locked box 相交的空间块：切割掉重叠部分
        if (lb.x < sp.x + sp.l && lb.x + lb.l > sp.x &&
            lb.y < sp.y + sp.h && lb.y + lb.h > sp.y &&
            lb.z < sp.z + sp.w && lb.z + lb.w > sp.z) {
          // x 向切割
          if (lb.x > sp.x) next.push({ ...sp, l: lb.x - sp.x });
          if (lb.x + lb.l < sp.x + sp.l) next.push({ ...sp, x: lb.x + lb.l, l: sp.x + sp.l - lb.x - lb.l });
          // y 向切割
          if (lb.y > sp.y) next.push({ ...sp, h: lb.y - sp.y });
          if (lb.y + lb.h < sp.y + sp.h) next.push({ ...sp, y: lb.y + lb.h, h: sp.y + sp.h - lb.y - lb.h });
          // z 向切割
          if (lb.z > sp.z) next.push({ ...sp, w: lb.z - sp.z });
          if (lb.z + lb.w < sp.z + sp.w) next.push({ ...sp, z: lb.z + lb.w, w: sp.z + sp.w - lb.z - lb.w });
        } else {
          next.push(sp);
        }
      }
      spaces = mergeSpaces(next.filter(s => s.l > 0.01 && s.w > 0.01 && s.h > 0.01));
    }
    return spaces;
  }

  // ---- 单次装箱（指定排序策略）----
  // v5：packOnce 接收 unitList（已按策略排序）。
  // 品类隔离：装箱过程中维护已装品类集合，冲突品类跳过。
  // 轴荷：每次放置后校验前后轴载荷，超限则撤销该件（视作本车装不下）。
  // 分组（strict）：某件放置失败时，回退同组已装的全部件。
  function packOnce(unitList) {
    const _packed = [];
    const _boxes = [];
    const _unpacked = [];
    let _totalWeight = 0;
    let _spaces = initialSpaces();   // v5.1：支持 lockedBoxes 锚定扣除
    const _placedCategories = new Set();   // v5 已装品类
    const _placedByGroup = new Map();      // v5 groupId -> [placedBox]
    let _axleRejected = [];                // v5 轴荷拒装件
    let _usedVol = 0;                      // v5.1 回程配额跟踪

    // v5.1：locked 箱预登记（重量/品类/分组计入，坐标不动）
    if (lockedBoxes && lockedBoxes.length) {
      for (const lb of lockedBoxes) {
        const lbBox = { ...lb, id: lb.id || 'locked', name: lb.name || '已装货', locked: true };
        _boxes.push(lbBox);
        _totalWeight += (lb.item && lb.item.weight) || lb.weight || 0;
        _usedVol += lb.l * lb.w * lb.h;
        const it = lb.item || {};
        if (it.category) _placedCategories.add(it.category);
      }
    }

    // v5.2：支撑树与承重链
    // supportedBy：直接支撑本箱的下方箱引用数组（含 locked 箱）
    // _load：本箱顶面当前已承受的累计载荷 kg（含所有传递下来的上层箱重）
    const _supportIndex = () => _boxes;   // 支撑查询源（含 locked）

    // v5.2：把新箱压力沿支撑链向下传播校验
    // addedWeight：新箱自重；directSupports：新箱直接压着的箱列表
    // 返回 false 表示链条上存在累计超限（拒装）
    // 注意：校验必须走完整链——Infinity 箱自身无需校验，但压力仍要
    // 继续传给其下方箱（否则 C→B(∞)→A 场景会漏检 A 的累计超限）
    function _stackChainOk(directSupports, addedWeight) {
      if (addedWeight <= 0) return true;
      // BFS 传播：队列元素 [箱, 该箱将承受的增量]
      const queue = directSupports.map(b => [b, addedWeight]);
      const seen = new Set();
      while (queue.length) {
        const [b, w] = queue.shift();
        if (seen.has(b)) continue;
        seen.add(b);
        const ms = (b.item && b.item.maxStack) != null ? b.item.maxStack : Infinity;
        if (ms !== Infinity && (b._load || 0) + w > ms + 1e-9) return false;  // 该箱累计超限
        // 无论自身是否 Infinity，压力都传递给其支撑链（增量继续下压）
        const subs = b.supportedBy || [];
        for (const s of subs) queue.push([s, w]);
      }
      return true;
    }

    // v5.2：落箱时把新箱重量真正加到支撑链各箱的 _load 上
    // （与 _stackChainOk 校验逻辑严格对称：Infinity 箱不加自身 _load 但继续下传）
    function _applyChainLoad(directSupports, addedWeight) {
      if (addedWeight <= 0) return;
      const queue = directSupports.map(b => [b, addedWeight]);
      const seen = new Set();
      while (queue.length) {
        const [b, w] = queue.shift();
        if (seen.has(b)) continue;
        seen.add(b);
        const ms = (b.item && b.item.maxStack) != null ? b.item.maxStack : Infinity;
        if (ms !== Infinity) b._load = (b._load || 0) + w;
        const subs = b.supportedBy || [];
        for (const s of subs) queue.push([s, w]);
      }
    }

    function _canPlace(box, space) {
      if (!fits(box, space)) return null;
      if (_totalWeight + box.weight > maxWeight) return null;
      const bottomY = space.y;
      const area = box.l * box.w;
      let supported = 0;
      if (bottomY <= 1e-9) {
        supported = area;
      } else {
        for (const b of _boxes) {
          const top = b.y + b.h;
          if (Math.abs(top - bottomY) > 1e-6) continue;
          const ix = Math.max(0, Math.min(space.x + box.l, b.x + b.l) - Math.max(space.x, b.x));
          const iz = Math.max(0, Math.min(space.z + box.w, b.z + b.w) - Math.max(space.z, b.z));
          if (ix > 0 && iz > 0) supported += ix * iz;
        }
      }
      if (supported < area * 0.5 - 1e-6) return null;
      // v5.2：承重链校验——收集直接支撑箱（顶面接触 + 底面投影重叠），
      // 压力沿支撑树向下传递：沿途每箱 累计载荷+新箱重 ≤ maxStack
      if (bottomY > 1e-9) {
        const directSupports = [];
        for (const b of _boxes) {
          const top = b.y + b.h;
          if (Math.abs(top - bottomY) > 1e-6) continue;
          const ix = Math.max(0, Math.min(space.x + box.l, b.x + b.l) - Math.max(space.x, b.x));
          const iz = Math.max(0, Math.min(space.z + box.w, b.z + b.w) - Math.max(space.z, b.z));
          if (ix > 0 && iz > 0) directSupports.push(b);
        }
        if (directSupports.length && !_stackChainOk(directSupports, box.weight)) return null;
      }
      return { x: space.x, y: space.y, z: space.z };
    }

    // v5：轴荷试探——试放置后前后轴是否仍合规
    function _axleOkAfter(box, pos) {
      if (!axle) return true;
      const trial = _boxes.concat([{ x: pos.x, y: pos.y, z: pos.z, l: box.l, w: box.w, h: box.h, item: box.item, weight: box.weight }]);
      // trial 项缺 item.weight，补齐：axleLoads 使用 item.weight
      const loads = axleLoads(trial, _totalWeight + box.weight, axle, L);
      return loads.front_ok && loads.rear_ok;
    }

    // v5.1：门端可达校验——重物必须完全落在门端区 [doorZoneStart, L]
    function _doorZoneOk(item, pos, o) {
      if (!doorZoneStart || item.weight < heavyKg) return true;
      return pos.x >= doorZoneStart - 1e-6 && (pos.x + o.l) <= L + 1e-6;
    }

    // v5.1：回程配额校验——累计装载体积不得超 effectiveVolCap
    function _reserveOk(o) {
      if (reserveVol <= 0) return true;
      return _usedVol + o.l * o.w * o.h <= effectiveVolCap + 1e-6;
    }

    // v5.1：件数上限校验（不含 locked）
    function _itemsOk() {
      if (!maxItems) return true;
      return _packed.length < maxItems;
    }

    // v5：回退一组已装箱（分组完整性失败时）
    // v5.2 修复：removedIds 原先取 p.box（列表存的即是箱对象，取值恒为
    // undefined → Set 里全是 undefined → 回退从未真正生效）；重放时按
    // 坐标重建空间索引（六面切割）与承重链，杜绝回退后新装箱与重放箱重叠
    function _rollbackGroup(groupId) {
      const placed = _placedByGroup.get(groupId);
      if (!placed || !placed.length) return;
      const removedSet = new Set(placed);              // 列表元素就是箱对象
      const keepBoxes = _boxes.filter(b => !removedSet.has(b));
      // 重新初始化再重放 keepBoxes（确定性顺序）
      _boxes.length = 0; _packed.length = 0; _spaces = initialSpaces();
      _totalWeight = 0; _usedVol = 0; _placedCategories.clear(); _placedByGroup.clear();
      _axleRejected = _axleRejected.filter(r => !removedSet.has(r.box));
      // locked 箱重新登记（v5.2：含支撑关系/承重链/空间索引重建；
      // locked 不计入 _packed——件数上限与 packed 输出均只算新装件）
      if (lockedBoxes && lockedBoxes.length) {
        for (const lb of lockedBoxes) {
          const lbBox = { ...lb, id: lb.id || 'locked', name: lb.name || '已装货', locked: true };
          _registerBox(lbBox, false);
        }
      }
      for (const kb of keepBoxes) {
        _replayBox(kb);
      }
    }
    // v5.2：登记一只箱（重量/品类/分组/承重链/空间索引全量重建）
    // countPacked=false 用于 locked 箱：只进 _boxes，不占件数上限
    function _registerBox(box, countPacked = true) {
      _boxes.push(box);
      if (countPacked) _packed.push(box);
      _totalWeight += (box.item && box.item.weight) || box.weight || 0;
      _usedVol += box.l * box.w * box.h;
      const it = box.item || {};
      if (it.category) _placedCategories.add(it.category);
      if (it.groupId) {
        if (!_placedByGroup.has(it.groupId)) _placedByGroup.set(it.groupId, []);
        _placedByGroup.get(it.groupId).push(box);
      }
      // 支撑关系与承重链
      box.supportedBy = _findSupports(box);
      _applyChainLoad(box.supportedBy, (box.item && box.item.weight) || box.weight || 0);
      // 空间索引：从自由空间中切割掉本箱占用的体积
      _carveBox(box);
    }
    // v5.2：查找直接支撑箱（顶面接触 + 底面投影重叠）
    function _findSupports(box) {
      if (box.y <= 1e-9) return [];
      const res = [];
      for (const b of _boxes) {
        const top = b.y + b.h;
        if (Math.abs(top - box.y) > 1e-6) continue;
        const ix = Math.max(0, Math.min(box.x + box.l, b.x + b.l) - Math.max(box.x, b.x));
        const iz = Math.max(0, Math.min(box.z + box.w, b.z + b.w) - Math.max(box.z, b.z));
        if (ix > 0 && iz > 0) res.push(b);
      }
      return res;
    }
    // v5.2：从自由空间中扣除箱体占用的体积（AABB 六面切割，同 initialSpaces 的 locked 切割）
    function _carveBox(box) {
      const next = [];
      for (const sp of _spaces) {
        if (box.x < sp.x + sp.l && box.x + box.l > sp.x &&
            box.y < sp.y + sp.h && box.y + box.h > sp.y &&
            box.z < sp.z + sp.w && box.z + box.w > sp.z) {
          if (box.x > sp.x) next.push({ ...sp, l: box.x - sp.x });
          if (box.x + box.l < sp.x + sp.l) next.push({ ...sp, x: box.x + box.l, l: sp.x + sp.l - box.x - box.l });
          if (box.y > sp.y) next.push({ ...sp, h: box.y - sp.y });
          if (box.y + box.h < sp.y + sp.h) next.push({ ...sp, y: box.y + box.h, h: sp.y + sp.h - box.y - box.h });
          if (box.z > sp.z) next.push({ ...sp, w: box.z - sp.z });
          if (box.z + box.w < sp.z + sp.w) next.push({ ...sp, z: box.z + box.w, w: sp.z + sp.w - box.z - box.w });
        } else {
          next.push(sp);
        }
      }
      _spaces = mergeSpaces(next.filter(s => s.l > 0.01 && s.w > 0.01 && s.h > 0.01));
    }
    // 重放一只箱子（按其原坐标直接恢复，不重新搜索——分组回退后
    // 其余箱子的相对布局保持不变；空间索引与承重链由 _registerBox 重建）
    function _replayBox(kb) {
      _registerBox(kb);
    }

    function _splitSpace(space, placed) {
      const remain = [];
      const right = {
        x: placed.x + placed.l, y: space.y, z: space.z,
        l: space.l - placed.l, w: space.w, h: space.h,
      };
      const front = {
        x: space.x, y: space.y, z: placed.z + placed.w,
        l: placed.l, w: space.w - placed.w, h: space.h,
      };
      const top = {
        x: space.x, y: placed.y + placed.h, z: space.z,
        l: placed.l, w: placed.w, h: space.h - placed.h,
      };
      [right, front, top].forEach(s => {
        if (s.l > 0.01 && s.w > 0.01 && s.h > 0.01) remain.push(s);
      });
      return remain;
    }

    for (const item of unitList) {
      // v5：品类隔离——与已装品类冲突则整类跳过（进 unpacked）
      if (incompatSet) {
        let conflict = false;
        for (const cat of _placedCategories) {
          if (categoriesConflict(incompatSet, cat, item.category)) { conflict = true; break; }
        }
        if (conflict) { _unpacked.push(Object.assign({}, item, { reason: 'category' })); continue; }
      }
      // v5.1：件数上限（送装工时折算）
      if (!_itemsOk()) {
        _unpacked.push(Object.assign({}, item, { reason: 'max_items' }));
        continue;
      }

      const orients = orientations(item);
      let best = null;
      let bestScore = Infinity;
      let bestSpaceIdx = -1;

      for (let si = 0; si < _spaces.length; si++) {
        const sp = _spaces[si];
        for (const o of orients) {
          const box = { l: o.l, w: o.w, h: o.h, weight: item.weight, item };
          const pos = _canPlace(box, sp);
          if (!pos) continue;
          if (!_axleOkAfter(box, pos)) continue;   // v5：轴荷硬校验
          if (!_doorZoneOk(item, pos, o)) continue; // v5.1：门端可达硬校验
          if (!_reserveOk(o)) continue;             // v5.1：回程配额硬校验
          let sc = scoreSpace(sp) + (o.l * o.w * o.h) * 1e-6;
          // stop-aware 引导：先到站（stopSeq 小）的货品惩罚远离车门（低x）的位置
          // 车门在 x=L 端：理想位置 x ≈ L - 期望深度。用线性罚把早到站货往高 x 推
          // v5.2：λ 自适应（options.stopPenaltyMode='adaptive' 时启用）
          //   legacy（默认）   ：固定 λ=5e4——旧版行为，快照逐字节兼容
          //   adaptive        ：λ 归一化为 λ = 5e4 × W/L × 1/log(2+stops)
          //     · W/L 项      ：宽厢/长厢的空间评分天然更大（y×1e4 + z×100 + x），
          //                     罚项按厢长缩放，长车不因绝对坐标大而失去门端引导
          //     · 1/log(2+N)  ：站点越多（长途多站配送），单站罚项越弱——避免
          //                     多站场景下早期站点被过度推挤到门端而挤压其他站点
          if (stopAware && item.stopSeq !== null) {
            const doorCloseness = (sp.x + o.l) / L;         // 越接近 1 越靠门
            const urgency = 1 - item.stopSeq / Math.max(1, stopSeqMap.size); // 越早到站越接近 1
            if (stopPenaltyMode === 'adaptive') {
              const lambda = 5e4 * (W / L) / Math.log(2 + stopSeqMap.size);
              sc -= doorCloseness * urgency * lambda;
            } else {
              sc -= doorCloseness * urgency * 5e4;           // 强引导，但不破坏 BLB 底层优先太多
            }
          }
          if (sc < bestScore) {
            bestScore = sc;
            best = { pos, box, orient: o };
            bestSpaceIdx = si;
          }
        }
      }

      if (!best) {
        // v5：轴荷拒绝的记录原因；其余为空间/载重不足
        _unpacked.push(item);
        // v5 分组 strict：本组有件失败 → 整组回退（组内已装箱全部撤下）
        if (item.groupId && groupMode) {
          const placed = _placedByGroup.get(item.groupId);
          if (placed && placed.length) _rollbackGroup(item.groupId);
          // 组内其余未尝试件也标失败
          const groupUnits = groupOf.get(item.groupId) || [];
          for (const gu of groupUnits) {
            if (gu === item) continue;
            const alreadyPacked = _packed.some(p => p.item === gu);
            if (!alreadyPacked && !_unpacked.includes(gu)) _unpacked.push(gu);
          }
        }
        continue;
      }

      const placedBox = {
        x: best.pos.x, y: best.pos.y, z: best.pos.z,
        l: best.box.l, w: best.box.w, h: best.box.h,
        item, id: item.id, name: item.name, color: item.color,
      };
      // v5.2：登记支撑关系（直接下方箱）并把新箱重量压入承重链
      if (placedBox.y > 1e-9) {
        const directSupports = [];
        for (const b of _boxes) {
          const top = b.y + b.h;
          if (Math.abs(top - placedBox.y) > 1e-6) continue;
          const ix = Math.max(0, Math.min(placedBox.x + placedBox.l, b.x + b.l) - Math.max(placedBox.x, b.x));
          const iz = Math.max(0, Math.min(placedBox.z + placedBox.w, b.z + b.w) - Math.max(placedBox.z, b.z));
          if (ix > 0 && iz > 0) directSupports.push(b);
        }
        placedBox.supportedBy = directSupports;
        _applyChainLoad(directSupports, item.weight);
      } else {
        placedBox.supportedBy = [];   // 地板承重无限
      }
      _boxes.push(placedBox);
      _packed.push(placedBox);
      _totalWeight += item.weight;
      _usedVol += item.l * item.w * item.h;   // v5.1：配额跟踪（unit 尺寸）
      if (item.category) _placedCategories.add(item.category);
      if (item.groupId) {
        if (!_placedByGroup.has(item.groupId)) _placedByGroup.set(item.groupId, []);
        _placedByGroup.get(item.groupId).push(placedBox);
      }

      const sp = _spaces[bestSpaceIdx];
      const newSpaces = _splitSpace(sp, placedBox);
      _spaces.splice(bestSpaceIdx, 1);
      newSpaces.forEach(ns => _spaces.push(ns));
      _spaces = mergeSpaces(_spaces);
    }

    return {
      packed: _packed, boxes: _boxes, unpacked: _unpacked,
      totalWeight: _totalWeight,
      stopViolations: countStopViolations(_boxes),
      axleRejected: _axleRejected,
      categoriesUsed: [..._placedCategories],
    };
  }

  // ---- 多策略择优 ----
  // stop-aware 时：所有策略列表都先按站点访问逆序（后到站先装→深处），
  // 同站点内再按策略关键字排序；未知站点视为"最后一站之后"（最先装，最深处）
  // v5：策略列表基于 normalUnits（尾悬件不参与多策略竞争，最后统一放置）
  const byStopDesc = (a, b) => {
    const sa = a.stopSeq !== null ? a.stopSeq : Number.MAX_SAFE_INTEGER;
    const sb = b.stopSeq !== null ? b.stopSeq : Number.MAX_SAFE_INTEGER;
    return sb - sa; // 大序号（后到站/未知）在前 → 先装 → 深处
  };
  const strategyLists = {
    volume: normalUnits.slice().sort((a, b) => volume(b) - volume(a)),
    weight: normalUnits.slice().sort((a, b) => b.weight - a.weight),
    bottom: normalUnits.slice().sort((a, b) => b.h - a.h),
    longest: normalUnits.slice().sort((a, b) => Math.max(b.l, b.w, b.h) - Math.max(a.l, a.w, a.h)),
  };
  if (stopAware) {
    for (const key of Object.keys(strategyLists)) {
      strategyLists[key] = normalUnits.slice().sort((a, b) => {
        const s = byStopDesc(a, b);
        if (s !== 0) return s;
        // 站内沿用原策略排序
        if (key === 'volume') return volume(b) - volume(a);
        if (key === 'weight') return b.weight - a.weight;
        if (key === 'bottom') return b.h - a.h;
        return Math.max(b.l, b.w, b.h) - Math.max(a.l, a.w, a.h);
      });
    }
  }
  let bestResult = null;
  let bestKey = null;
  const strategies = [...new Set([strategy, 'volume', 'weight', 'bottom', 'longest'])];
  for (const st of strategies) {
    const res = packOnce(strategyLists[st] || strategyLists.volume);
    const usedVol = res.packed.reduce((a, b) => a + b.l * b.w * b.h, 0);
    if (!bestResult
      || usedVol > bestResult.packed.reduce((a, b) => a + b.l * b.w * b.h, 0) + 1e-9
      || (Math.abs(usedVol - bestResult.packed.reduce((a, b) => a + b.l * b.w * b.h, 0)) <= 1e-9
          && res.stopViolations < bestResult.stopViolations)) {
      bestResult = res;
      bestKey = st;
    }
  }

  const packed = bestResult.packed;
  const boxes = bestResult.boxes;
  const unpacked = bestResult.unpacked;
  let totalWeight = bestResult.totalWeight;

  // ---- stopReport：站点区块分布 + 卸货顺序违规 ----
  const stopReport = buildStopReport(boxes, stopSeqMap, bestResult.stopViolations, L);

  // ---- v5：尾悬件放置（贴 x=L 门端，厢内段正常参与堆叠校验）----
  const overhangs = [];
  const overhangBoxes = [];
  for (const u of overhangUnits) {
    const od = u._overhang;
    // 厢内段尺寸：inside_l × (w,h)，放于地板 y=0，门端 x = L - inside_l
    const inner = { l: od.inside_l, w: u.w, h: u.h, weight: u.weight, item: u };
    // 简化放置：地板门端首位（BLB 与尾悬深度互斥：尾悬件优先占用门端）
    // 不与其他箱堆叠（悬伸件 maxStack 视为 0：不承压不上人）
    const placed = {
      x: L - od.inside_l, y: 0, z: 0,
      l: od.inside_l, w: u.w, h: u.h,
      item: u, id: u.id, name: u.name, color: u.color,
      overhang: { inside_cm: od.inside_l, out_cm: od.overhang_l, total_l: u.l },
    };
    // 载重/轴荷校验
    const wAfter = totalWeight + u.weight;
    if (wAfter > maxWeight + 1e-9) {
      unpacked.push(u); continue;
    }
    if (axle) {
      const trial = boxes.concat([placed]);
      const loads = axleLoads(trial, wAfter, axle, L);
      if (!(loads.front_ok && loads.rear_ok)) { unpacked.push(u); continue; }
    }
    boxes.push(placed);
    packed.push(placed);
    overhangBoxes.push(placed);
    totalWeight = wAfter;
    overhangs.push({
      id: u.id, name: u.name,
      inside_cm: Math.round(od.inside_l), out_cm: Math.round(od.overhang_l),
      total_l_cm: Math.round(u.l), weight_kg: u.weight,
      limit_cm: Math.round(Math.min(overhangMax, L * 0.3)),
    });
  }

  // ---- v5：分组完整性标记 ----
  // strict 模式下 packOnce 内已做组内回退；此处对最终 unpacked 中带
  // groupId 的件统一标 reason（含整组回退件）
  if (groupMode) {
    unpacked.forEach(u => {
      if (u.groupId && !u.reason) u.reason = 'group_incomplete';
    });
    // 若同组部分在 packed、部分在 unpacked（异常状态，理论上不会出现，
    // packOnce 已保证整组一致；防御性兜底再检一次）
    const packedGroups = new Set(packed.map(b => b.item.groupId).filter(Boolean));
    packed.forEach(b => { if (b.item.groupId) packedGroups.add(b.item.groupId); });
    const brokenGroups = [];
    for (const [gid, arr] of groupOf) {
      const inPacked = packed.filter(b => b.item.groupId === gid).length;
      if (inPacked > 0 && inPacked < arr.length) brokenGroups.push(gid);
    }
    // 防御性：若出现破组（不应发生），整组转 unpacked
    if (brokenGroups.length) {
      for (const gid of brokenGroups) {
        const groupBoxes = packed.filter(b => b.item.groupId === gid);
        groupBoxes.forEach(gb => {
          const pi = packed.indexOf(gb); if (pi >= 0) packed.splice(pi, 1);
          const bi = boxes.indexOf(gb); if (bi >= 0) boxes.splice(bi, 1);
          totalWeight -= gb.item.weight || 0;
        });
        (groupOf.get(gid) || []).forEach(gu => {
          if (!unpacked.includes(gu)) unpacked.push(Object.assign(gu, { reason: 'group_incomplete' }));
        });
      }
    }
  }

  // ---- v5：轴荷报告 ----
  let axleReport = null;
  if (axle) {
    const loads = axleLoads(boxes, totalWeight, axle, L);
    axleReport = {
      enabled: true,
      front_axle_kg: loads.front_kg,
      rear_axle_kg: loads.rear_kg,
      front_limit_kg: axle.front_limit_kg || null,
      rear_limit_kg: axle.rear_limit_kg || null,
      front_pct: loads.front_pct,
      rear_pct: loads.rear_pct,
      level: (loads.front_ok && loads.rear_ok) ? 'ok' : 'overload',
    };
  }

  // 未装货品按原货品汇总（数量）——移到此处（含尾悬/分组标记后再汇总）
  const unpackedSummary = {};
  unpacked.forEach(u => {
    if (!unpackedSummary[u.id]) {
      unpackedSummary[u.id] = {
        id: u.id, name: u.name, l: u.rawL != null ? u.rawL : u.l, w: u.rawW != null ? u.rawW : u.w, h: u.rawH != null ? u.rawH : u.h,
        weight: u.weight, qty: 1, color: u.color, type: u.type,
        stop: u.stop || undefined,
        reason: u.reason,
        groupId: u.groupId || undefined,
        category: u.category || undefined,
      };
    } else {
      unpackedSummary[u.id].qty += 1;
    }
  });
  // 温层不符的货品并入未装清单（带原因）
  tempRejected.forEach(u => {
    if (!unpackedSummary[u.id]) {
      unpackedSummary[u.id] = {
        id: u.id, name: u.name, l: u.rawL != null ? u.rawL : u.l, w: u.rawW != null ? u.rawW : u.w, h: u.rawH != null ? u.rawH : u.h,
        weight: u.weight, qty: 1, color: u.color, type: u.type,
        stop: u.stop || undefined, reason: 'temp_zone',
      };
    } else {
      unpackedSummary[u.id].qty += 1;
    }
  });
  const unpackedList = Object.values(unpackedSummary);

  // 计算统计（重算：含尾悬件）
  const usedVol2 = packed.reduce((a, b) => a + b.l * b.w * b.h, 0);
  const unpackedVol2 = unpacked.reduce((a, b) => a + b.l * b.w * b.h, 0);
  const containerVol = L * W * H;

  // 分层统计（按 y 高度分组）
  const layerMap = new Map();
  packed.forEach(b => {
    const key = Math.round(b.y);
    if (!layerMap.has(key)) layerMap.set(key, []);
    layerMap.get(key).push(b);
  });
  const layers = [...layerMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, items]) => ({ y, items }));

  return {
    success: unpackedList.length === 0,
    packed,
    unpacked: unpackedList,
    boxes,
    stats: {
      container: { l: L, w: W, h: H, temp_zones: containerZones },
      total_items: units.length + tempRejected.length,
      packed_count: packed.length,
      unpacked_count: unpackedList.reduce((a, u) => a + u.qty, 0),
      temp_rejected_count: tempRejected.length,
      total_weight: Math.round(totalWeight * 10) / 10,
      max_weight: maxWeight,
      used_volume: Math.round(usedVol2),
      container_volume: Math.round(containerVol),
      volume_rate: Math.round(usedVol2 / containerVol * 1000) / 10,
      weight_rate: maxWeight !== Infinity ? Math.round(totalWeight / maxWeight * 1000) / 10 : null,
      unpacked_volume: Math.round(unpackedVol2),
      layers: layers.length,
      strategy_used: bestKey,
      stop_aware: stopAware,
      // v5 新增
      group_mode: groupMode,
      group_count: groupOf.size,
      category_conflict_rejected: unpackedList.filter(u => u.reason === 'category').reduce((a, u) => a + u.qty, 0),
      axle_mode: !!axle,
      overhang_count: overhangs.length,
      // v5.1 新增
      door_zone_pct: doorZonePct,
      heavy_kg: doorZonePct ? heavyKg : null,
      reserve_ratio: reserveRatio,
      reserve_volume: Math.round(reserveVol),
      effective_volume_cap: Math.round(effectiveVolCap || containerVol),
      max_items: maxItems || null,
      items_rate: maxItems ? Math.round(packed.length / maxItems * 1000) / 10 : null,
      locked_count: lockedBoxes ? lockedBoxes.length : 0,
    },
    // 重心与偏载分析（含 locked 箱）
    gravity: computeGravity(boxes.filter(b => !b.locked || true), { l: L, w: W, h: H }, totalWeight),
    layers,
    stopReport,
    axleReport,          // v5：null 或轴荷报告
    overhangs,           // v5：尾悬件明细（空数组或列表）
    lockedBoxes,         // v5.1：锚定箱回显（无则 null）
  };
}

// ---- v5.1：滚动重配载包装 ----
// 场景：改期/插单触发重排。已装且不动的箱子（lockedBoxes）锚定原坐标，
// 新一批货品只装入剩余自由空间。返回结构与 solve 完全一致，boxes 含
// locked 箱（locked: true 标记）+ 新装箱。
function solveIncremental(container, lockedBoxes, newItems, options = {}) {
  return solve(container, newItems, { ...options, lockedBoxes });
}

// ---- stop-aware 校验：检测"后到站货物物理挡住先到站货物" ----
// 车门在 x=L 端。货品 b 可直接卸下 iff：不存在 o，
//   o 更靠门（o.x+o.l > b.x+b.l+1e-6）且 y-z 投影与 b 重叠
// 违规：b 的站点应先于 o 的站点到访，但 o 挡住了 b
function countStopViolations(boxes) {
  let violations = 0;
  const withSeq = boxes.filter(b => b.item.stopSeq !== null);
  for (const b of withSeq) {
    for (const o of withSeq) {
      if (o === b) continue;
      if (o.item.stopSeq <= b.item.stopSeq) continue; // o 后到或同站 → o 先卸是允许的
      if (o.x + o.l <= b.x + b.l + 1e-6) continue;    // o 不比 b 靠门
      // y-z 投影重叠（水平投影：z-w 平面 + 高度带重叠）
      const iz = Math.max(0, Math.min(b.z + b.w, o.z + o.w) - Math.max(b.z, o.z));
      const iy = Math.max(0, Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y));
      if (iz > 1e-6 && iy > 1e-6) { violations++; break; }
    }
  }
  return violations;
}

function buildStopReport(boxes, stopSeqMap, violations, L) {
  // 按站点聚合区块统计
  const byStop = new Map();
  boxes.forEach(b => {
    const key = b.item.stop || '__unknown__';
    if (!byStop.has(key)) {
      byStop.set(key, {
        stop: key === '__unknown__' ? null : key,
        seq: key === '__unknown__' ? null : (stopSeqMap.get(key) ?? null),
        count: 0, weight: 0,
        xMin: Infinity, xMax: -Infinity,
        doorExtentAvg: 0,
      });
    }
    const e = byStop.get(key);
    e.count++;
    e.weight += b.item.weight || 0;
    e.xMin = Math.min(e.xMin, b.x);
    e.xMax = Math.max(e.xMax, b.x + b.l);
    e.doorExtentAvg += (b.x + b.l);
  });
  const stops = [...byStop.values()].map(e => ({
    ...e,
    xMin: isFinite(e.xMin) ? Math.round(e.xMin) : null,
    xMax: isFinite(e.xMax) ? Math.round(e.xMax) : null,
    doorExtentAvg: e.count ? Math.round(e.doorExtentAvg / e.count) : null,
    depth_pct: e.count ? Math.round((1 - e.doorExtentAvg / e.count / L) * 1000) / 10 : null,
  }));
  // 站点按访问顺序排列；理想情况：seq 小 → depth_pct 小（靠门）
  stops.sort((a, b) => {
    if (a.seq === null) return 1;
    if (b.seq === null) return -1;
    return a.seq - b.seq;
  });
  return {
    enabled: stopSeqMap.size > 0,
    stops,
    violations, // 卸货顺序物理违规数（0 为理想）
  };
}

/**
 * 重心与偏载分析
 * 坐标系：x=长方向(车头→车尾)，y=高方向(底板→顶)，z=宽方向(左→右)
 * 偏载判断：重心偏离车厢中心的比例
 */
function computeGravity(boxes, container, totalWeight) {
  const defaultRes = {
    center: { x: null, y: null, z: null },
    offset: { x: 0, y: 0, z: 0 },      // 相对车厢中心的偏移(cm)
    offset_pct: { x: 0, y: 0, z: 0 },  // 偏移百分比（相对对应尺寸）
    load_shift: 'uniform',             // uniform | front | rear | left | right | top | bottom
    level: 'ok',                       // ok | warn | danger
    checks: [],
  };
  if (!boxes.length || !totalWeight) return defaultRes;

  // 加权重心：每件货品中心
  let mx = 0, my = 0, mz = 0;
  boxes.forEach(b => {
    const w = b.item.weight || 0;
    mx += w * (b.x + b.l / 2);
    my += w * (b.y + b.h / 2);
    mz += w * (b.z + b.w / 2);
  });
  const cx = mx / totalWeight, cy = my / totalWeight, cz = mz / totalWeight;

  // 车厢中心
  const ccx = container.l / 2, ccy = container.h / 2, ccz = container.w / 2;

  // 偏移
  const ox = cx - ccx, oy = cy - ccy, oz = cz - ccz;
  const opx = (ox / container.l) * 100;
  const opy = (oy / container.h) * 100;
  const opz = (oz / container.w) * 100;

  // 偏载方向判定（前后/左右/上下）
  const dirs = [];
  if (Math.abs(opx) >= 5) dirs.push(opx > 0 ? '后部偏载' : '前部偏载');
  if (Math.abs(opz) >= 5) dirs.push(opz > 0 ? '右侧偏载' : '左侧偏载');
  if (opy > 12) dirs.push('重心偏高');
  let load_shift = 'uniform';
  if (dirs.length) load_shift = dirs.join('、');

  // 等级判定：仅纵向/横向大偏载或重心过高为风险；重心低是安全的
  const maxPct = Math.max(Math.abs(opx), Math.abs(opz));
  let level = 'ok';
  if (maxPct >= 10 || opy >= 15) level = 'danger';
  else if (maxPct >= 5 || opy >= 10) level = 'warn';

  // 合规检查项
  const checks = [];
  checks.push({
    name: '纵向重心（前/后）',
    ok: Math.abs(opx) < 10,
    value: `${opx >= 0 ? '+' : ''}${opx.toFixed(1)}%`,
    detail: opx >= 0 ? '重心偏后' : '重心偏前',
  });
  checks.push({
    name: '横向重心（左/右）',
    ok: Math.abs(opz) < 10,
    value: `${opz >= 0 ? '+' : ''}${opz.toFixed(1)}%`,
    detail: opz >= 0 ? '重心偏右' : '重心偏左',
  });
  checks.push({
    name: '垂直重心（高度）',
    ok: opy < 15,
    value: `${opy >= 0 ? '+' : ''}${opy.toFixed(1)}%`,
    detail: opy >= 0 ? '重心偏高（易侧翻，需调整）' : '重心偏低（稳定）',
  });

  return {
    center: { x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10, z: Math.round(cz * 10) / 10 },
    offset: { x: Math.round(ox * 10) / 10, y: Math.round(oy * 10) / 10, z: Math.round(oz * 10) / 10 },
    offset_pct: { x: Math.round(opx * 10) / 10, y: Math.round(opy * 10) / 10, z: Math.round(opz * 10) / 10 },
    load_shift,
    level,
    checks,
  };
}

// 空间去重合并（相邻可合并的合并）
function mergeSpaces(spaces) {
  const res = [];
  for (const s of spaces) {
    let merged = false;
    for (const r of res) {
      // 尝试合并：同高同深，x 相邻
      if (Math.abs(r.y - s.y) < 1e-6 && Math.abs(r.h - s.h) < 1e-6 &&
          Math.abs(r.z - s.z) < 1e-6 && Math.abs(r.w - s.w) < 1e-6) {
        if (Math.abs(r.x + r.l - s.x) < 1e-6 || Math.abs(s.x + s.l - r.x) < 1e-6) {
          r.x = Math.min(r.x, s.x);
          r.l = Math.max(r.x + r.l, s.x + s.l) - r.x;
          merged = true;
          break;
        }
      }
    }
    if (!merged) res.push({ ...s });
  }
  return res;
}

// ---------- 3D 坐标转 Two.js/Three.js 用数据 ----------
// 每个 packed box 提供八顶点或中心点 + 尺寸
function toThree(box) {
  return {
    position: [box.x + box.l / 2, box.y + box.h / 2, box.z + box.w / 2],
    size: [box.l, box.h, box.w], // Three.js: x=l, y=h, z=w
    name: box.name,
    color: box.color,
  };
}

/**
 * 多车厢自动分配（v4：温层 + 站点感知）
 * 输入：
 *   fleet: [{ id, name, l, w, h, max_weight, qty, temp_zones? }]
 *   items: 货物清单（同 solve；可带 stop/tempClass）
 *   options: {
 *     strategy, allowStack,
 *     routeStops?: { [vehicleName]: [站点名, ...] },  // 车辆路线站点顺序
 *   }
 * 输出：
 *   {
 *     vehicles: [ { id, name, container, result, reason } ],
 *     unpacked, stats,
 *     stopAssignViolations,  // 装入"路线不含其站点"车辆的货品数
 *   }
 */
function solveFleet(fleet, items, options = {}) {
  // 展开车队（保留温区）
  const vehicles = [];
  fleet.forEach(v => {
    const qty = Math.max(1, parseInt(v.qty, 10) || 1);
    for (let k = 0; k < qty; k++) {
      vehicles.push({
        id: v.id || `v${vehicles.length + 1}`,
        name: v.name || `车辆${vehicles.length + 1}`,
        l: v.l, w: v.w, h: v.h, max_weight: v.max_weight,
        temp_zones: normalizeTempZones(v.temp_zones),
      });
    }
  });
  if (!vehicles.length) throw new Error('车队为空');

  // 车辆名 → 站点顺序（routeStops 的 key 匹配展开前或展开后的车辆名）
  const routeStopsMap = new Map();
  Object.entries(options.routeStops || {}).forEach(([k, v]) => {
    if (Array.isArray(v) && v.length) routeStopsMap.set(String(k), v.map(String));
  });
  // fleet 带 qty 展开时，展开名为 `${name}#${k+1}`（见 fleetToContainerList），
  // routeStops 用原始 name 也能匹配：尝试 name 去掉 # 后缀
  const stopsForVehicle = (vehName) => {
    if (routeStopsMap.has(vehName)) return routeStopsMap.get(vehName);
    const base = String(vehName).replace(/#\d+$/, '');
    return routeStopsMap.get(base) || null;
  };

  // 展开货品（按 qty），供多车分配
  const units = [];
  items.forEach((it, idx) => {
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const tempClass = normalizeTempClass(it.tempClass ?? it.temp ?? it.temp_class);
    for (let k = 0; k < qty; k++) {
      units.push({
        id: it.id || `${it.name}_${idx}`,
        name: it.name || `货品${idx + 1}`,
        l: it.l, w: it.w, h: it.h,
        weight: it.weight || 0,
        canRotate: it.canRotate !== false,
        horizontalRotate: !!it.horizontalRotate,
        maxStack: it.maxStack || Infinity,
        color: it.color, type: it.type || 'general',
        stop: it.stop ? String(it.stop) : '',
        tempClass,
      });
    }
  });

  const remaining = units.slice();  // 待分配
  const results = [];
  let totalPacked = 0, totalWeight = 0, totalVol = 0, totalVolCap = 0;
  let stopAssignViolations = 0;

  // 从 remaining 中移除已装入的货品（按 id 逐一移除——solve 内部会展开
  // 拷贝 unit，对象引用会失效，必须按 id 匹配；同 id 多件只移除对应数量）
  function removePacked(result) {
    for (const box of result.boxes) {
      const idx = remaining.findIndex(u => u.id === box.id);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  // 对单车执行一次装箱：只喂温层匹配 + 站点归属匹配的货品
  function packVehicle(vi, eligibleUnits) {
    const v = vehicles[vi];
    const stopOrder = stopsForVehicle(v.name) || [];
    // 站点归属过滤：路线含站点清单时，仅接收清单内站点 + 无站点货品
    let feed = eligibleUnits;
    if (stopOrder.length) {
      const stopSet = new Set(stopOrder);
      feed = eligibleUnits.filter(u => !u.stop || stopSet.has(u.stop));
    }
    if (!feed.length) return null;
    const singleItems = feed.map(u => ({ ...u, qty: 1 }));
    return solve(
      { l: v.l, w: v.w, h: v.h, max_weight: v.max_weight, temp_zones: v.temp_zones },
      singleItems,
      { ...options, stopOrder }
    );
  }

  // ---- 阶段1：站点感知分配 ----
  // 有站点信息的货品按站点分组，优先交给路线包含该站点的车辆
  const stopGroups = new Map();
  remaining.forEach(u => {
    if (!u.stop) return;
    if (!stopGroups.has(u.stop)) stopGroups.set(u.stop, []);
    stopGroups.get(u.stop).push(u);
  });

  vehicles.forEach((v, vi) => {
    const stopOrder = stopsForVehicle(v.name) || [];
    if (!stopOrder.length) return; // 无路线信息的车走阶段2
    // 该车路线专属货品 = 属于其站点的剩余货品
    // 注意：同名站点可能对应多个收货点（连锁药房多门店），
    // 或路线内同名站点出现多次 → 必须去重，防止同一货品被喂两次
    const mineSet = new Set();
    stopOrder.forEach(s => {
      const grp = stopGroups.get(s);
      if (grp) grp.forEach(u => { if (remaining.includes(u)) mineSet.add(u); });
    });
    const mine = [...mineSet];
    if (!mine.length) { results[vi] = null; return; }
    const r = packVehicle(vi, mine);
    if (!r || !r.boxes.length) { results[vi] = null; return; }
    removePacked(r);
    totalPacked += r.boxes.length;
    totalWeight += r.stats.total_weight;
    totalVol += r.stats.used_volume;
    totalVolCap += r.stats.container_volume;
    results[vi] = { vehicle: v, result: r, reason: r.unpacked.length ? 'partial' : 'full', stopMatched: true };
  });

  // ---- 阶段2：容量贪心补装（无路线车 / 阶段1没装下的）----
  vehicles.forEach((v, vi) => {
    if (results[vi]) {
      // 已分配车辆：把还能塞的同路线货品与阶段1货品合并重解一次
      // （partial→full 补装）。仅当重解结果完整保留阶段1货品且装入更多时
      // 接受；未装入的货品留在 remaining 由后续车辆尝试，不会丢失
      const stopOrder = stopsForVehicle(v.name) || [];
      const stopSet = new Set(stopOrder);
      const leftovers = remaining.filter(u => !u.stop || (stopOrder.length && stopSet.has(u.stop)));
      if (!leftovers.length) return;
      const prev = results[vi].result;
      const mergedFeed = prev.boxes.map(b => ({ ...b.item, qty: 1 }))
        .concat(leftovers.map(u => ({ ...u, qty: 1 })));
      const rMerged = solve(
        { l: v.l, w: v.w, h: v.h, max_weight: v.max_weight, temp_zones: v.temp_zones },
        mergedFeed,
        { ...options, stopOrder }
      );
      const mergedIds = new Set(rMerged.boxes.map(b => b.id));
      const keptAll = prev.boxes.every(b => mergedIds.has(b.id));
      if (keptAll && rMerged.boxes.length > prev.boxes.length) {
        removePacked(rMerged); // 阶段1货品已不在 remaining，净移除的正是本轮新装入的
        totalPacked += rMerged.boxes.length - prev.boxes.length;
        totalWeight += rMerged.stats.total_weight - prev.stats.total_weight;
        totalVol += rMerged.stats.used_volume - prev.stats.used_volume;
        results[vi] = { vehicle: v, result: rMerged, reason: rMerged.unpacked.length ? 'partial' : 'full', stopMatched: true };
      }
      return;
    }
    // 未分配车辆：贪心装载剩余货品（温层过滤在 packVehicle 内部的 solve 处理）
    if (!remaining.length) { results[vi] = { vehicle: v, result: null, reason: 'no_items' }; return; }
    const feed = remaining.filter(u => v.temp_zones.includes(u.tempClass));
    if (!feed.length) { results[vi] = { vehicle: v, result: null, reason: 'no_items' }; return; }
    const r = packVehicle(vi, feed);
    if (!r || !r.boxes.length) { results[vi] = { vehicle: v, result: null, reason: 'no_items' }; return; }
    // 散装车：路线不含这些站点 → 记录违规（仍合法装车，但卸货需现场排序）
    const stopOrder = stopsForVehicle(v.name) || [];
    if (stopOrder.length) {
      const stopSet = new Set(stopOrder);
      r.boxes.forEach(b => { if (b.item.stop && !stopSet.has(b.item.stop)) stopAssignViolations++; });
    }
    removePacked(r);
    totalPacked += r.boxes.length;
    totalWeight += r.stats.total_weight;
    totalVol += r.stats.used_volume;
    totalVolCap += r.stats.container_volume;
    results[vi] = { vehicle: v, result: r, reason: r.unpacked.length ? 'partial' : 'full', stopMatched: false };
  });

  // 空位补齐（results 中 undefined 的车辆标记未使用）
  for (let vi = 0; vi < vehicles.length; vi++) {
    if (!results[vi]) results[vi] = { vehicle: vehicles[vi], result: null, reason: 'no_items' };
  }

  // 未分配（所有车都装不下 / 温层无车匹配）
  const unpackedSummary = {};
  remaining.forEach(u => {
    if (!unpackedSummary[u.id]) {
      unpackedSummary[u.id] = {
        id: u.id, name: u.name, l: u.l, w: u.w, h: u.h,
        weight: u.weight, qty: 1, color: u.color, type: u.type,
        stop: u.stop || undefined,
      };
    } else {
      unpackedSummary[u.id].qty += 1;
    }
  });

  const usedVehicles = results.filter(r => r.result && r.result.boxes.length).length;
  return {
    vehicles: results,
    unpacked: Object.values(unpackedSummary),
    stopAssignViolations,
    stats: {
      total_items: units.length,
      packed_items: totalPacked,
      unpacked_items: remaining.length,
      fleet_size: vehicles.length,
      used_vehicles: usedVehicles,
      total_weight: Math.round(totalWeight * 10) / 10,
      total_volume: Math.round(totalVol),
      total_capacity_volume: Math.round(totalVolCap),
      volume_rate: totalVolCap ? Math.round(totalVol / totalVolCap * 1000) / 10 : 0,
      weight_rate: null, // 多车加权重量率由前端按实际载重算
    },
  };
}

return {
  solve,
  solveIncremental,   // v5.1：滚动重配载（lockedBoxes 锚定 + 新货补装）
  solveFleet,
  mergeSpaces,
  toThree,
  normalizeTempClass,
  normalizeTempZones,
};

})();

// CommonJS 导出（浏览器端此分支不生效）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PackingSolver;
}
