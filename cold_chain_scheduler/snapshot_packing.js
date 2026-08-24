/* 回归快照：捕获当前求解器输出作为向后兼容基线
 * 用法: node snapshot_packing.js
 * 输出: packing_snapshot.json（改动前后各跑一次，diff 必须一致）*/
'use strict';
const path = require('path');
const PackingSolver = require(path.join(__dirname, 'static', 'packing_solver.js'));

const SCENARIOS = {
  basic: () => PackingSolver.solve(
    { l: 600, w: 240, h: 220, max_weight: 3000 },
    [
      { id: 'A', name: '药品箱A', l: 60, w: 40, h: 50, weight: 25, qty: 30 },
      { id: 'B', name: '药品箱B', l: 50, w: 50, h: 40, weight: 20, qty: 20 },
      { id: 'C', name: '大箱', l: 120, w: 100, h: 90, weight: 150, qty: 5 },
    ],
    { strategy: 'volume' }
  ),
  temp_stop: () => PackingSolver.solve(
    { l: 500, w: 220, h: 200, max_weight: 2500, temp_zones: ['cold'] },
    [
      { id: 'F', name: '冷冻品', l: 60, w: 40, h: 50, weight: 25, qty: 10, tempClass: 'frozen' },
      { id: 'R', name: '冷藏品', l: 50, w: 50, h: 40, weight: 20, qty: 30, stop: '甲店' },
      { id: 'S', name: '常温品', l: 40, w: 30, h: 35, weight: 12, qty: 20, stop: '乙店', tempClass: 'normal' },
    ],
    { strategy: 'weight', stopOrder: ['甲店', '乙店'] }
  ),
  fleet: () => PackingSolver.solveFleet(
    [
      { id: 'v1', name: '冷藏车1', l: 500, w: 220, h: 200, max_weight: 2500, qty: 2, temp_zones: ['cold'] },
      { id: 'v2', name: '常温车', l: 450, w: 200, h: 190, max_weight: 2000, qty: 1, temp_zones: ['normal'] },
    ],
    [
      { id: 'F', name: '冷冻品', l: 60, w: 40, h: 50, weight: 25, qty: 12, tempClass: 'frozen' },
      { id: 'R', name: '冷藏品', l: 50, w: 50, h: 40, weight: 20, qty: 40, stop: '甲店' },
      { id: 'S', name: '常温品', l: 40,  w: 30, h: 60, weight: 15, qty: 30, stop: '乙店', tempClass: 'normal' },
    ],
    { strategy: 'volume', routeStops: { '冷藏车1': ['甲店'], '常温车': ['乙店'] } }
  ),
};

const out = {};
for (const [name, fn] of Object.entries(SCENARIOS)) {
  const t0 = Date.now();
  const r = fn();
  out[name] = {
    strategy_used: r.stats ? r.stats.strategy_used : null,
    packed_count: r.stats ? r.stats.packed_count : null,
    unpacked: r.unpacked || [],
    boxes: (r.boxes || []).map(b => ({
      x: b.x, y: b.y, z: b.z, l: b.l, w: b.w, h: b.h, id: b.id, name: b.name,
    })),
    fleet: r.vehicles ? r.vehicles.map(v => ({
      name: v.vehicle.name, reason: v.reason,
      packed: v.result ? v.result.stats.packed_count : 0,
      stopMatched: !!v.stopMatched,
      boxes: v.result ? v.result.boxes.map(b => ({ x: b.x, y: b.y, z: b.z, l: b.l, w: b.w, h: b.h, id: b.id })) : [],
    })) : undefined,
    stopReport: r.stopReport ? { violations: r.stopReport.violations, stops: r.stopReport.stops.map(s => ({ stop: s.stop, count: s.count, depth_pct: s.depth_pct })) } : undefined,
    ms: Date.now() - t0,
  };
}
require('fs').writeFileSync(path.join(__dirname, 'packing_snapshot.json'), JSON.stringify(out, null, 2));
console.log('snapshot written, scenarios:', Object.keys(out).join(', '));
for (const [k, v] of Object.entries(out)) {
  console.log(`  ${k}: packed=${v.packed_count ?? v.fleet?.map(f => f.packed).join('/') ?? '?'} unpacked=${v.unpacked.length} ms=${v.ms}`);
}
