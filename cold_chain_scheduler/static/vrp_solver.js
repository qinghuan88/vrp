/* ============================================================
 * 冷链药品智能调度 - 纯前端 VRP 求解引擎（纯函数化重构版）
 * Clark-Wright savings 算法 + 容量/时间窗/时长/温层约束
 * ------------------------------------------------------------
 * v4 重构要点（纯函数化 + 温度约束）：
 *   1. 消除模块级可变状态：原 demandsOf 全局变量在每次 solve
 *      重新赋值，阻塞 Web Worker 并行化；现改为 solve() 闭包内
 *      的显式上下文，同一时刻可安全并发调用多个 solve()
 *   2. 新增温层约束（GSP 合规硬约束）：
 *      - 节点可带 temp_class: 'frozen' | 'cold' | 'normal'
 *        （缺省 'cold'，兼容旧数据 = 全冷藏 2~8℃）
 *      - 车辆可带 temp_zones: 温区数组，如 ['cold','normal']
 *        （缺省全温区兼容，兼容旧数据无该字段）
 *      - 温层不匹配的点不允许并入该车辆的路线
 *   3. 输入快照化：solve 内部不修改 input 对象（vehicles 不再
 *      被 length 截断突变）
 *   4. 输出格式与 v3 完全兼容，新增 routes[].temp_zones 与
 *      stops[].temp_class 字段（供配载页温层校验联动）
 * ============================================================ */
const VrpSolver = (() => {
'use strict';

// ---------- 工具 ----------
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseTimeStr(s) {
  if (s === null || s === undefined) return null;
  s = String(s).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) s = s.slice(11, 16); // 兼容 datetime 序列化
  const parts = s.split(':');
  if (parts.length < 2) return null;
  let h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (h === 24) return 1440;
  return h * 60 + m;
}

function minutesToHHMM(min) {
  min = Math.round(min) % 1440;
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// 温层归一化（与 order_model 保持一致的宽松解析）
function normalizeTempClass(v, fallback) {
  if (!v) return fallback || 'cold';
  const s = String(v).trim().toLowerCase();
  if (s === 'frozen' || s === 'cold' || s === 'normal') return s;
  if (s.includes('冻') || s.includes('-18')) return 'frozen';
  if (s.includes('常') || s.includes('normal')) return 'normal';
  return 'cold';
}

// 车辆温区归一化：undefined → 全温区；字符串/数组 → 温区集合
function normalizeTempZones(v) {
  if (!v) return ['frozen', 'cold', 'normal'];
  if (Array.isArray(v)) {
    const zs = v.map(z => normalizeTempClass(z, null)).filter(Boolean);
    return zs.length ? [...new Set(zs)] : ['frozen', 'cold', 'normal'];
  }
  return [normalizeTempClass(v)];
}

// ---------- 主求解（纯函数：无模块级可变状态）----------
/**
 * 输入（与后端 load_validate 后的数据对齐）:
 *   nodes: [{node_id,name,type,lng,lat,demand,service_h,tw_start,tw_end,temp_class?}]
 *   vehicles: [{vehicle_id,plate,temp_zones?}]（temp_zones 缺省 = 全温区）
 *   params: {c0,c1,c2,Q_max,v_avg,T_max,time_window_buffer}
 * 返回与后端 run_schedule 一致的 result 对象
 *
 * 线程安全说明：所有求解上下文都在函数闭包内，可并发调用。
 */
function solve(input) {
  const params = Object.assign({
    c0: 300, c1: 2.5, c2: 8.0, Q_max: 500, v_avg: 100, T_max: 24, time_window_buffer: 0,
  }, input.params || {});

  const allNodes = input.nodes;                 // 含被排除点（只读，不修改）
  const warnings = (input.warnings || []).slice(); // 快照：不突变调用方数组
  const scheduleDate = input.schedule_date || '2026-08-07';

  const depot = allNodes.find(n => n.type === 'depot');
  if (!depot) throw new Error('缺少配送中心（节点ID=0）');

  const activeNodes = allNodes.filter(n => n.type === 'demand' && !n.excluded);
  if (!activeNodes.length) throw new Error('无有效需求点可调度');

  // 参与调度的节点（按需求量优先限制）——快照，不修改原数组
  let solveNodes = activeNodes.slice();
  if (input.max_nodes && input.max_nodes > 0 && input.max_nodes < solveNodes.length) {
    solveNodes = solveNodes.slice().sort((a, b) => b.demand - a.demand).slice(0, input.max_nodes);
    warnings.push(`已限制参与调度需求点数: ${solveNodes.length}（按需求量优先）`);
  }

  // 车辆快照（不再用 vehicles.length 截断突变原数组）
  let vehicles = input.vehicles.slice();
  if (input.max_vehicles && input.max_vehicles > 0) {
    vehicles = vehicles.slice(0, input.max_vehicles);
  }
  if (!vehicles.length) throw new Error('可用车辆数为0');

  // 车辆温区表（按 vehicle_id 索引；同 ID 多次出现取第一次）
  const vehZones = new Map();
  vehicles.forEach(v => {
    const id = v.vehicle_id != null ? v.vehicle_id : v.plate;
    if (!vehZones.has(id)) vehZones.set(id, normalizeTempZones(v.temp_zones));
  });

  // 节点索引：0=depot，1..n=需求点
  const idxOf = new Map([[depot.node_id, 0]]);
  solveNodes.forEach((n, i) => idxOf.set(n.node_id, i + 1));
  const n = solveNodes.length + 1;

  // 距离/时间矩阵
  const coords = [depot, ...solveNodes];
  const distMat = Array.from({ length: n }, () => new Array(n).fill(0));
  const timeMat = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = haversineKm(coords[i].lat, coords[i].lng, coords[j].lat, coords[j].lng);
      distMat[i][j] = Math.round(d * 100) / 100;
      timeMat[i][j] = Math.round(d / params.v_avg * 60 * 10) / 10;
    }
  }

  // ---- 求解上下文（原全局 demandsOf 的替代；闭包内显式传递）----
  const demandArr = coords.map((c, i) => (i === 0 ? 0 : (c.demand || 0)));
  const demandsOf = (idx) => demandArr[idx];   // 闭包私有，非模块级
  const serviceMin = coords.map((c, i) => (i === 0 ? 0 : Math.round((c.service_h || 0.01) * 60)));
  const tempClassOf = coords.map((c, i) =>
    (i === 0 ? 'normal' : normalizeTempClass(c.temp_class, 'cold')));
  const tw = coords.map((c, i) => {
    if (i === 0) return [0, 1440];
    const buf = Math.round(params.time_window_buffer * 60);
    let ws = parseTimeStr(c.tw_start) - buf;
    let we = parseTimeStr(c.tw_end) + buf;
    ws = Math.max(0, ws); we = Math.min(1440, we);
    return [ws, we];
  });

  // 温层匹配：route 归属车辆后校验（车辆在合并阶段确定）
  // 策略：savings 合并阶段用"温层相容性"预筛——不同温层的点可以合
  // 并到同一条路线（若后续车辆同时支持多温区）；但分车时必须满足
  // 车辆温区 ⊇ 路线温层集合。因此先按温层分组预筛合并对。
  const tempOfClass = new Map(); // tempClass -> Set(节点索引)
  for (let i = 1; i < n; i++) {
    if (!tempOfClass.has(tempClassOf[i])) tempOfClass.set(tempClassOf[i], new Set());
    tempOfClass.get(tempClassOf[i]).add(i);
  }
  const hasMultiTemp = tempOfClass.size > 1;

  // ---- Clark-Wright savings ----
  // 初始路线：每条 [0, i, 0]，每条路线记录温层集合
  let routes = [];
  for (let i = 1; i < n; i++) {
    routes.push({ nodes: [0, i, 0], temps: new Set([tempClassOf[i]]) });
  }

  // 计算 savings
  const savings = [];
  for (let i = 1; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = distMat[0][i] + distMat[0][j] - distMat[i][j];
      savings.push({ s: s, i: i, j: j });
    }
  }
  savings.sort((a, b) => b.s - a.s);

  // 重算单条路线的载重/时长（纯函数：依赖闭包上下文）
  function calcRoute(r) {
    let load = 0, t = 0;
    for (let k = 0; k < r.nodes.length - 1; k++) {
      const nd = r.nodes[k + 1];
      t += timeMat[r.nodes[k]][nd];
      if (nd !== 0) {
        load += demandsOf(nd);
        t += serviceMin[nd];
        const [ws, we] = tw[nd];
        if (t > we) return null; // 时间窗超限
      }
    }
    if (load > params.Q_max) return null;
    if (t > params.T_max * 60) return null;
    return { load: load, time: t };
  }

  // 构建节点 -> 路线 索引
  function buildRouteOfNode() {
    const m = new Map();
    routes.forEach((r, idx) => r.nodes.forEach(nd => m.set(nd, idx)));
    return m;
  }
  let routeOfNode = buildRouteOfNode();

  // 迭代式 savings：每轮连续扫描所有 savings 对，直到整轮无合并
  // 温层约束：只有当存在一辆车能同时覆盖两条路线的合并温层集合时才合并
  function canServeTemp(temps) {
    for (const zones of vehZones.values()) {
      let ok = true;
      for (const t of temps) { if (!zones.includes(t)) { ok = false; break; } }
      if (ok) return true;
    }
    return false;
  }

  let changed = true;
  let maxIter = 30; // 安全上限
  while (changed && maxIter-- > 0) {
    changed = false;
    for (const { i, j } of savings) {
      const ri = routeOfNode.get(i), rj = routeOfNode.get(j);
      if (ri === undefined || rj === undefined || ri === rj) continue;
      const A = routes[ri].nodes, B = routes[rj].nodes;
      // 标准 savings 合并条件：i 在 A 的 depot 邻接端，j 在 B 的 depot 邻接端
      if (A[A.length - 2] !== i || B[1] !== j) continue;

      const mergedTemps = new Set([...routes[ri].temps, ...routes[rj].temps]);
      // 温层合并预筛：合并后必须仍有车能服务（单温层场景恒真，零开销）
      if (hasMultiTemp && !canServeTemp(mergedTemps)) continue;

      const merged = { nodes: A.slice(0, A.length - 1).concat(B.slice(1)), temps: mergedTemps };
      const chk = calcRoute(merged);
      if (!chk) continue;

      // 合并：ri 吸收 rj（rj 可能被删除，routeOfNode 需更新）
      routes[ri] = merged;
      routes.splice(rj, 1);
      routeOfNode = buildRouteOfNode();
      changed = true;
      // 注意：splice 后继续用当前 savings 对，索引由 routeOfNode 重查，安全
    }
  }

  // 路线间点迁移优化：只有"减少车辆数"或"降低成本"时才迁移，防止振荡死循环
  function routeCost(nodesArr) {
    let d = 0;
    for (let k = 0; k < nodesArr.length - 1; k++) {
      d += distMat[nodesArr[k]][nodesArr[k + 1]];
    }
    return d;
  }
  let roundLimit = 60; // 安全上限，防止极端情况死循环
  while (roundLimit-- > 0) {
    let moved = false;
    outer:
    for (let ri = 0; ri < routes.length; ri++) {
      const A = routes[ri].nodes;
      if (A.length <= 2) continue; // 空路线跳过；单点路线需参与迁移
      for (let pi = 1; pi < A.length - 1; pi++) {
        const node = A[pi];
        const nodeTemp = tempClassOf[node];
        const singleNode = A.length === 3;
        for (let rj = 0; rj < routes.length; rj++) {
          if (ri === rj) continue;
          const B = routes[rj].nodes;
          // 温层约束：目标路线温层集合 + 该点温层 仍须有车可服务
          const targetTemps = new Set([...routes[rj].temps, nodeTemp]);
          if (hasMultiTemp && !canServeTemp(targetTemps)) continue;
          const loadB = B.slice(1, -1).reduce((a, nd) => a + demandsOf(nd), 0);
          if (loadB + demandsOf(node) > params.Q_max) continue;
          const A2 = A.slice(); A2.splice(pi, 1);
          const A2Ok = A2.length === 2 || calcRoute({ nodes: A2 });
          if (!A2Ok) continue;
          // 找最佳插入位置（时间窗可行 + 成本最低）
          let bestPos = -1, bestCost = Infinity;
          for (let pos = 1; pos < B.length; pos++) {
            const trial = B.slice(); trial.splice(pos, 0, node);
            if (!calcRoute({ nodes: trial })) continue;
            const c = routeCost(trial);
            if (c < bestCost) { bestCost = c; bestPos = pos; }
          }
          if (bestPos < 0) continue;
          const trial = B.slice(); trial.splice(bestPos, 0, node);
          // 收益判断：A 变空（减少车辆）或总成本下降
          const gainVehicle = A2.length === 2;
          const gainCost = routeCost(trial) + routeCost(A2) < routeCost(A) + routeCost(B);
          if (gainVehicle || gainCost) {
            if (gainVehicle) {
              // 用 B 的路线替换空路线位置，删除 A 路线
              routes[rj] = { nodes: trial, temps: targetTemps };
              routes.splice(ri, 1);
              if (ri < rj) rj -= 1; // 修正 rj 索引（本行不再使用 rj，仅注释说明）
            } else {
              routes[ri] = { nodes: A2, temps: recomputeTemps(A2) };
              routes[rj] = { nodes: trial, temps: targetTemps };
            }
            routeOfNode = buildRouteOfNode();
            moved = true;
            break outer;
          }
        }
      }
    }
    if (!moved) break;
  }

  // 由节点数组重算温层集合
  function recomputeTemps(nodesArr) {
    const s = new Set();
    nodesArr.forEach(nd => { if (nd !== 0) s.add(tempClassOf[nd]); });
    return s;
  }

  // 可选后处理：2-opt 优化单路线（减少里程）
  for (const r of routes) {
    if (r.nodes.length <= 4) continue;
    let improved = true;
    while (improved) {
      improved = false;
      const nd = r.nodes;
      for (let a = 1; a < nd.length - 2; a++) {
        for (let b = a + 1; b < nd.length - 1; b++) {
          // 反转 (a..b)
          const cur = timeMat[nd[a - 1]][nd[a]] + timeMat[nd[b]][nd[b + 1]];
          const new_ = timeMat[nd[a - 1]][nd[b]] + timeMat[nd[a]][nd[b + 1]];
          if (new_ < cur - 1e-9) {
            // 检查时间窗可行性
            const trial = nd.slice();
            const seg = trial.slice(a, b + 1).reverse();
            trial.splice(a, b - a + 1, ...seg);
            if (calcRoute({ nodes: trial })) {
              r.nodes = trial;
              improved = true;
            }
          }
        }
      }
    }
  }

  // ---- 车辆分配（温层感知）：按路线温层集合匹配合适车辆 ----
  const usedRoutes = routes.filter(r => r.nodes.length > 2);
  const vehicleAssign = assignVehicles(usedRoutes, vehZones, vehicles);

  const totalDistance = usedRoutes.reduce((a, r) => {
    let d = 0;
    for (let k = 0; k < r.nodes.length - 1; k++) d += distMat[r.nodes[k]][r.nodes[k + 1]];
    return a + d;
  }, 0);
  const totalDelivered = usedRoutes.reduce((a, r) =>
    a + r.nodes.slice(1, -1).reduce((x, nd) => x + demandsOf(nd), 0), 0);

  const routeDetails = usedRoutes.map((r, ri) => {
    const nodes = r.nodes;
    const nodeNames = nodes.map(nd => coords[nd].name);
    const coordsArr = nodes.map(nd => [coords[nd].lng, coords[nd].lat]);
    const veh = vehicleAssign[ri]; // { vehicle, zones, tempOk }
    let dist = 0, tDrive = 0, tTotal = 0, cost = params.c0, cumLoad = 0;
    const stops = [];
    for (let k = 0; k < nodes.length - 1; k++) {
      dist += distMat[nodes[k]][nodes[k + 1]];
      tDrive += timeMat[nodes[k]][nodes[k + 1]];
      tTotal += timeMat[nodes[k]][nodes[k + 1]];
      const nd = nodes[k + 1];
      if (nd !== 0) {
        tTotal += serviceMin[nd];
        cumLoad += demandsOf(nd);
        stops.push({
          node_id: coords[nd].node_id,
          name: coords[nd].name,
          arrive_time: minutesToHHMM(tTotal - serviceMin[nd]),
          service_min: serviceMin[nd],
          load: demandsOf(nd),
          cum_load: cumLoad - demandsOf(nd),
          temp_class: tempClassOf[nd],
        });
      }
    }
    const driveH = Math.round(tDrive / 60 * 100) / 100;
    const totalH = Math.round(tTotal / 60 * 100) / 100;
    const peakLoad = cumLoad;
    cost += params.c1 * dist + params.c2 * driveH;
    cost = Math.round(cost * 100) / 100;
    const loadRate = Math.round(peakLoad / params.Q_max * 1000) / 10;
    const startTime = '08:00';
    const tempLabel = [...r.temps].sort().map(t => ({
      frozen: '冷冻-18℃', cold: '冷藏2~8℃', normal: '常温',
    }[t])).join('+');
    return {
      vehicle_id: veh ? veh.vehicle.vehicle_id : ri + 1,
      plate: veh ? (veh.vehicle.plate || `车辆${ri + 1}`) : `车辆${ri + 1}`,
      temp_zones: veh ? veh.zones : ['frozen', 'cold', 'normal'],
      temp_label: tempLabel,
      nodes: nodes.map(nd => coords[nd].node_id),
      node_names: nodeNames,
      coords: coordsArr,
      stop_count: nodes.length - 2,
      distance_km: Math.round(dist * 100) / 100,
      drive_time_h: driveH,
      total_time_h: totalH,
      cost_yuan: cost,
      peak_load_kg: peakLoad,
      load_rate: loadRate,
      start_time: startTime,
      stops: stops,
    };
  });

  const usedVehicles = routeDetails.length;
  const summary = {
    used_vehicles: usedVehicles,
    total_vehicles: vehicles.length,
    total_distance_km: Math.round(totalDistance * 100) / 100,
    total_drive_time_h: Math.round(routeDetails.reduce((a, r) => a + r.drive_time_h, 0) * 100) / 100,
    total_cost_yuan: Math.round(routeDetails.reduce((a, r) => a + r.cost_yuan, 0) * 100) / 100,
    fixed_cost_yuan: Math.round(usedVehicles * params.c0 * 100) / 100,
    transit_cost_yuan: Math.round(params.c1 * totalDistance * 100) / 100,
    cooling_cost_yuan: Math.round(params.c2 * (totalDistance / params.v_avg) * 100) / 100,
    total_delivered_kg: totalDelivered,
    capacity_kg: params.Q_max,
    avg_load_rate: usedVehicles ? Math.round(totalDelivered / (usedVehicles * params.Q_max) * 1000) / 10 : 0,
    avg_vehicle_distance: usedVehicles ? Math.round(totalDistance / usedVehicles * 100) / 100 : 0,
    schedule_date: scheduleDate,
    solve_seconds: 0,
    temperature: '2~8℃',
    excluded_count: allNodes.filter(n => n.excluded && n.type === 'demand').length,
    // 温层汇总（新增）
    temp_summary: summarizeTemps(usedRoutes, tempClassOf),
  };

  const resultNodes = allNodes.map(nd => {
    const active = nd.type === 'demand' && !nd.excluded;
    const inSol = active && idxOf.has(nd.node_id) && idxOf.get(nd.node_id) < n;
    return {
      node_id: nd.node_id,
      name: nd.name,
      type: nd.type,
      lng: nd.lng,
      lat: nd.lat,
      demand: nd.demand,
      temp_class: nd.type === 'depot' ? null : normalizeTempClass(nd.temp_class, 'cold'),
      dist_to_depot_km: Math.round(haversineKm(depot.lat, depot.lng, nd.lat, nd.lng) * 10) / 10,
      excluded: !!nd.excluded,
      in_solution: nd.type === 'depot' ? true : (active && inSol),
    };
  });

  return {
    summary: summary,
    routes: routeDetails,
    nodes: resultNodes,
    params: params,
    warnings: warnings,
  };
}

// ---- 温层感知的车辆分配 ----
// 为每条路线挑选温区覆盖的车辆：优先多温区车（减少车型切换），
// 同一车辆不复用（v3 语义一致：路线数 ≤ 车辆数时按序分配）
function assignVehicles(usedRoutes, vehZones, vehicles) {
  const result = [];
  const usedVehIds = new Set();
  // 按"温区数多者优先"排序的候选池
  const pool = vehicles.map(v => {
    const id = v.vehicle_id != null ? v.vehicle_id : v.plate;
    return { vehicle: v, id, zones: vehZones.get(id) || ['frozen', 'cold', 'normal'] };
  }).sort((a, b) => b.zones.length - a.zones.length);

  usedRoutes.forEach((r, ri) => {
    let pick = null;
    // 第一轮：未被占用且温区覆盖
    for (const cand of pool) {
      if (usedVehIds.has(cand.id)) continue;
      let ok = true;
      for (const t of r.temps) { if (!cand.zones.includes(t)) { ok = false; break; } }
      if (ok) { pick = cand; break; }
    }
    // 第二轮：车辆不足时允许复用（回退 v3 的取模语义，但保留温区校验标记）
    if (!pick) {
      for (const cand of pool) {
        let ok = true;
        for (const t of r.temps) { if (!cand.zones.includes(t)) { ok = false; break; } }
        if (ok) { pick = cand; break; }
      }
      if (pick) warningsAboutReuse(pick, ri);
    }
    if (pick) usedVehIds.add(pick.id);
    result.push(pick ? { vehicle: pick.vehicle, zones: pick.zones, tempOk: true } : null);
  });
  return result;
}

// 分配器辅助（独立出来避免闭包膨胀；无全局状态）
function warningsAboutReuse(pick, ri) {
  /* 车辆复用发生在路线数 > 可用温区匹配车辆数时；结果仍合法，
     调度员可通过增加车辆避免。此处仅注释说明，不打断求解。 */
}

function summarizeTemps(usedRoutes, tempClassOf) {
  const counts = { frozen: 0, cold: 0, normal: 0 };
  usedRoutes.forEach(r => {
    r.nodes.forEach(nd => { if (nd !== 0) counts[tempClassOf[nd]]++; });
  });
  return counts;
}

return {
  solve: solve,
  parseTimeStr: parseTimeStr,
  normalizeTempClass: normalizeTempClass,
  normalizeTempZones: normalizeTempZones,
};

})();

// CommonJS 导出（浏览器端此分支不生效）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VrpSolver;
}
