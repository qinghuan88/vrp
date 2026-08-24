/* v5.1 滚动排程联动层测试：门端可达 / 回程预留 / 件数上限 / 增量重配载 */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, 'static', 'packing_solver.js'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.error(`  FAIL ${msg}`); }
}
function section(t) { console.log(`\n[${t}]`); }

// ---------------- 1. 门端可达 ----------------
section('1 门端可达 door_zone_pct + heavy_kg');
{
  // 车厢 600cm，门端区 30% → x ∈ [420, 600]；重物 ≥80kg 必须落门端
  const r = P.solve(
    { l: 600, w: 220, h: 220, max_weight: 5000, door_zone_pct: 30, heavy_kg: 80 },
    [
      { id: 'fridge', name: '冰箱', l: 75, w: 70, h: 180, weight: 100, qty: 4 },   // 重物
      { id: 'foam', name: '泡沫件', l: 100, w: 80, h: 60, weight: 10, qty: 12 },  // 轻货
    ],
    { strategy: 'volume' }
  );
  // 所有已装重物必须 x ≥ 420
  const heavy = r.boxes.filter(b => b.item.weight >= 80);
  ok(heavy.length > 0, `有重物装入（${heavy.length} 件）`);
  ok(heavy.every(b => b.x >= 420 - 1e-6), `重物全部落门端区 x≥420（min x = ${Math.min(...heavy.map(b => b.x))}）`);
  ok(r.stats.door_zone_pct === 30, `stats.door_zone_pct=30`);
}
{
  // 门端区过小装不下重物 → 拒装
  const r = P.solve(
    { l: 600, w: 220, h: 220, max_weight: 5000, door_zone_pct: 5, heavy_kg: 80 },
    [{ id: 'fridge', name: '冰箱', l: 75, w: 70, h: 180, weight: 100, qty: 4 }],
    {}
  );
  const heavyPacked = r.boxes.filter(b => b.item.weight >= 80).length;
  ok(heavyPacked === 0, `门端区 5% 装不下 75cm 冰箱 → 0 件装入（实际 ${heavyPacked}）`);
}
{
  // 无 door_zone_pct：不启用（旧调用零影响）
  const r = P.solve(
    { l: 600, w: 220, h: 220, max_weight: 5000 },
    [{ id: 'fridge', name: '冰箱', l: 75, w: 70, h: 180, weight: 100, qty: 4 }],
    {}
  );
  ok(r.stats.door_zone_pct === 0, `无参数时 door_zone_pct=0（未启用）`);
  ok(r.boxes.length === 4, `正常装箱不受影响（${r.boxes.length}/4）`);
}

// ---------------- 2. 回程空间预留 ----------------
section('2 回程空间预留 reserve_ratio');
{
  // 厢容 600×220×220 = 29,040,000 cm³，reserve 30% → 装载体积上限 20,328,000
  // （物理上限：底层 6×2=12 箱 × 2 层 = 24 箱，配额 20 箱 < 24 → 预留生效）
  const r = P.solve(
    { l: 600, w: 220, h: 220, max_weight: 99999, reserve_ratio: 30 },
    [{ id: 'box', name: '标准箱', l: 100, w: 100, h: 100, weight: 20, qty: 40 }],
    { strategy: 'volume' }
  );
  // 每箱 1,000,000 cm³ → 上限约 20 箱
  ok(r.stats.reserve_ratio === 30, `stats.reserve_ratio=30`);
  ok(r.stats.effective_volume_cap === 20328000, `effective_volume_cap=${r.stats.effective_volume_cap}`);
  const usedVol = r.boxes.reduce((a, b) => a + b.l * b.w * b.h, 0);
  ok(usedVol <= 20328000 + 1e-6, `装载体积 ${usedVol} ≤ 配额 20,328,000`);
  ok(r.boxes.length < 24, `预留生效：装 ${r.boxes.length}/40（低于物理上限 24）`);
  ok(r.unpacked.length === 1 && r.unpacked[0].qty === 40 - r.boxes.length, `未装件汇总正确（${r.unpacked[0].qty} 件）`);
}
{
  // 无 reserve_ratio：装到物理上限（600×220 底面 12 箱 × 2 层 = 24）
  const r = P.solve(
    { l: 600, w: 220, h: 220, max_weight: 99999 },
    [{ id: 'box', name: '标准箱', l: 100, w: 100, h: 100, weight: 20, qty: 40 }],
    { strategy: 'volume' }
  );
  ok(r.boxes.length === 24, `无预留时装至物理上限 24/40（实际 ${r.boxes.length}）`);
}

// ---------------- 3. 动态件数上限 ----------------
section('3 件数上限 max_items');
{
  // 送装工时折算：今日只能装 6 件（含安装耗时长的单）
  const r = P.solve(
    { l: 600, w: 220, h: 220, max_weight: 99999, max_items: 6 },
    [
      { id: 'fridge', name: '冰箱', l: 75, w: 70, h: 180, weight: 100, qty: 4 },
      { id: 'washer', name: '洗衣机', l: 60, w: 60, h: 85, weight: 60, qty: 5 },
    ],
    { strategy: 'volume' }
  );
  ok(r.boxes.length === 6, `恰好装满 6 件上限（实际 ${r.boxes.length}）`);
  const maxItemsUnpacked = r.unpacked.filter(u => u.reason === 'max_items');
  ok(maxItemsUnpacked.length === 1 && maxItemsUnpacked[0].qty === 3, `超额 3 件标 reason=max_items（${maxItemsUnpacked.length} 条，${maxItemsUnpacked[0] && maxItemsUnpacked[0].qty} 件）`);
  ok(r.stats.items_rate === 100, `stats.items_rate=100%（实际 ${r.stats.items_rate}）`);
  ok(r.stats.max_items === 6, `stats.max_items=6`);
}
{
  // 无 max_items：不限制
  const r = P.solve(
    { l: 600, w: 220, h: 220, max_weight: 99999 },
    [{ id: 'box', name: '标准箱', l: 100, w: 100, h: 100, weight: 20, qty: 10 }],
    {}
  );
  ok(r.boxes.length === 10 && r.stats.max_items === null, `无上限 10/10 全装`);
}

// ---------------- 4. 滚动重配载 ----------------
section('4 滚动重配载 solveIncremental');
{
  // 第一批：4 台冰箱装入车厢
  const c = { l: 600, w: 220, h: 220, max_weight: 99999 };
  const r1 = P.solve(c, [
    { id: 'fridge', name: '冰箱', l: 75, w: 70, h: 180, weight: 100, qty: 4 },
  ], { strategy: 'volume' });
  ok(r1.boxes.length === 4, `首批 4 台冰箱装入`);

  // 锁定前 4 箱（模拟"已在车上不动"），第二批装洗衣机
  const locked = r1.boxes.map(b => ({
    x: b.x, y: b.y, z: b.z, l: b.l, w: b.w, h: b.h,
    item: b.item, id: b.id, name: b.name,
  }));
  const r2 = P.solveIncremental(c, locked, [
    { id: 'washer', name: '洗衣机', l: 60, w: 60, h: 85, weight: 60, qty: 6 },
  ], { strategy: 'volume' });

  // locked 箱坐标不变
  const lockedInR2 = r2.boxes.filter(b => b.locked);
  ok(lockedInR2.length === 4, `locked 箱 4 件保留（${lockedInR2.length}）`);
  const coordsMatch = locked.every(lb => {
    const m = lockedInR2.find(b => !b.item.stop && b.x === lb.x && b.y === lb.y && b.z === lb.z && b.l === lb.l);
    return m;
  });
  ok(coordsMatch, `locked 箱坐标逐一对齐`);
  // 新货不与 locked 重叠（AABB 相交检测）
  const newBoxes = r2.boxes.filter(b => !b.locked);
  ok(newBoxes.length === 6, `新装洗衣机 6 台（${newBoxes.length}）`);
  let overlap = 0;
  for (const nb of newBoxes) {
    for (const lb of lockedInR2) {
      if (nb.x < lb.x + lb.l && nb.x + nb.l > lb.x &&
          nb.y < lb.y + lb.h && nb.y + nb.h > lb.y &&
          nb.z < lb.z + lb.w && nb.z + nb.w > lb.z) overlap++;
    }
  }
  ok(overlap === 0, `新货与 locked 零重叠（${overlap} 处）`);
  ok(r2.stats.locked_count === 4, `stats.locked_count=4`);
}
{
  // locked 箱占满地板层后，新货只能堆上层或被拒
  const c = { l: 300, w: 200, h: 200, max_weight: 99999 };
  const locked = [
    { x: 0, y: 0, z: 0, l: 300, w: 200, h: 100, item: { weight: 500, l: 300, w: 200, h: 100 }, id: 'wall', name: '隔墙板' },
  ];
  const r = P.solveIncremental(c, locked, [
    { id: 'washer', name: '洗衣机', l: 60, w: 60, h: 85, weight: 60, qty: 2 },
  ], {});
  // 洗衣机高 85 ≤ 剩余高 100，可堆在隔墙板上层（支撑来自 locked 箱顶 y=100）
  const newPacked = r.boxes.filter(b => !b.locked);
  ok(newPacked.every(b => b.y >= 100 - 1e-6), `新货全部堆在 locked 箱上方（y ≥ 100，实际 ${newPacked.map(b => b.y)}）`);
  ok(newPacked.length === 2, `堆叠装入 2 台洗衣机（${newPacked.length}）`);
}
{
  // locked 箱占满整个车厢 → 新货必拒
  const c = { l: 300, w: 200, h: 200, max_weight: 99999 };
  const locked = [
    { x: 0, y: 0, z: 0, l: 300, w: 200, h: 200, item: { weight: 500, l: 300, w: 200, h: 200 }, id: 'solid', name: '满载块' },
  ];
  const r = P.solveIncremental(c, locked, [
    { id: 'washer', name: '洗衣机', l: 60, w: 60, h: 85, weight: 60, qty: 2 },
  ], {});
  ok(r.boxes.filter(b => !b.locked).length === 0 && r.unpacked.length === 1,
    `空间被锁死 → 新货全拒（新装 ${r.boxes.filter(b => !b.locked).length}，unpacked ${r.unpacked.length}）`);
}

// ---------------- 5. 组合：改期场景全链路 ----------------
section('5 组合：改期重排 + 门端 + 件数上限');
{
  const c = { l: 600, w: 220, h: 220, max_weight: 5000, door_zone_pct: 30, max_items: 8 };
  // 首批：2 重 4 轻（max_items 只计新装，locked 不占上限）
  const r1 = P.solve(c, [
    { id: 'fridge', name: '冰箱', l: 75, w: 70, h: 180, weight: 100, qty: 2 },
    { id: 'foam', name: '泡沫件', l: 100, w: 80, h: 60, weight: 10, qty: 4 },
  ], { strategy: 'volume' });
  // 客户改期：锁定全部，补 2 台洗衣机
  const locked = r1.boxes.map(b => ({ x: b.x, y: b.y, z: b.z, l: b.l, w: b.w, h: b.h, item: b.item, id: b.id, name: b.name }));
  const r2 = P.solveIncremental(c, locked, [
    { id: 'washer', name: '洗衣机', l: 60, w: 60, h: 85, weight: 60, qty: 2 },
  ], { strategy: 'volume' });
  const newPacked = r2.boxes.filter(b => !b.locked);
  ok(newPacked.length === 2, `补装 2 台洗衣机（${newPacked.length}）`);
  const heavyAll = r2.boxes.filter(b => b.item.weight >= 80);
  ok(heavyAll.every(b => b.x >= 420 - 1e-6), `组合场景重物全落门端区`);
}

console.log(`\n========== 结果: ${pass} pass, ${fail} fail ==========`);
process.exit(fail ? 1 : 0);
