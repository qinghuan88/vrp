/* v5 大件约束层测试：订单完整性 / 轴荷 / 品类隔离+防护增量 / 尾悬 */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, 'static', 'packing_solver.js'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.error(`  FAIL ${msg}`); }
}
function section(t) { console.log(`\n[${t}]`); }

// ---------------- 1. 订单完整性 ----------------
section('1 订单完整性 groupId');
{
  // 贵妃位 410cm 超过 400cm 车厢长必然装不下 → 整组回退，电视柜正常装入
  const r = P.solve(
    { l: 400, w: 200, h: 200, max_weight: 2000 },
    [
      { id: 'sofa1', name: '沙发座', l: 220, w: 90, h: 80, weight: 60, groupId: 'ORDER-1' },
      { id: 'sofa2', name: '沙发背', l: 220, w: 40, h: 70, weight: 35, groupId: 'ORDER-1' },
      { id: 'sofa3', name: '贵妃位', l: 410, w: 95, h: 85, weight: 70, groupId: 'ORDER-1' },
      { id: 'tv', name: '电视柜', l: 180, w: 45, h: 50, weight: 40 },
    ],
    { strategy: 'volume' }
  );
  const sofaPacked = r.boxes.filter(b => b.item.groupId === 'ORDER-1').length;
  ok(sofaPacked === 0, `整组回退：0/3 装入（实际 ${sofaPacked}/3）`);
  const groupUnpacked = r.unpacked.filter(u => u.groupId === 'ORDER-1');
  ok(groupUnpacked.length === 3 && groupUnpacked.every(u => u.reason === 'group_incomplete'),
    `3 件全回退且标 reason=group_incomplete（实际 ${groupUnpacked.length} 件）`);
  const tvPacked = r.boxes.filter(b => b.id === 'tv').length;
  ok(tvPacked === 1, `无组物品正常装入（电视柜 ${tvPacked}/1）`);
}
{
  // 空间足够：整组应全部装入
  const r = P.solve(
    { l: 600, w: 240, h: 220, max_weight: 3000 },
    [
      { id: 'sofa1', name: '沙发座', l: 220, w: 90, h: 80, weight: 60, groupId: 'ORDER-1' },
      { id: 'sofa2', name: '沙发背', l: 220, w: 40, h: 70, weight: 35, groupId: 'ORDER-1' },
    ],
    {}
  );
  const sofaPacked = r.boxes.filter(b => b.item.groupId === 'ORDER-1').length;
  ok(sofaPacked === 2, `空间足够时整组装入（${sofaPacked}/2）`);
  ok(r.stats.group_count === 1, `stats.group_count=1（实际 ${r.stats.group_count}）`);
}
{
  // groupMode off：退回旧语义——sofa3 超长被拒但 sofa1/sofa2 独立装箱
  const r = P.solve(
    { l: 400, w: 200, h: 200, max_weight: 2000 },
    [
      { id: 'sofa1', name: '沙发座', l: 220, w: 90, h: 80, weight: 60, groupId: 'ORDER-1' },
      { id: 'sofa2', name: '沙发背', l: 220, w: 40, h: 70, weight: 35, groupId: 'ORDER-1' },
      { id: 'sofa3', name: '贵妃位', l: 410, w: 95, h: 85, weight: 70, groupId: 'ORDER-1' },
    ],
    { groupMode: 'off' }
  );
  const sofaPacked = r.boxes.filter(b => b.item.groupId === 'ORDER-1').length;
  ok(sofaPacked === 2, `groupMode=off 时按件独立装箱（${sofaPacked}/3，允许破组）`);
}

// ---------------- 2. 轴荷校验 ----------------
section('2 轴荷校验 axle');
{
  // 4.2m 货箱：轴距 380cm，前轴限 3000kg、后轴限 5000kg，空车前 1500 后 2000
  // 把重物全部推到车厢前端（x=0），前轴载荷=空车+全部货重
  const axle = {
    wheelbase_cm: 380, front_limit_kg: 3000, rear_limit_kg: 5000,
    curb_front_kg: 1500, curb_rear_kg: 2000, front_axle_at_cm: 0,
  };
  // 3 吨重物：前轴将达 1500+3000×(大份额) → 超 3000 限 → 部分件应被拒
  const r = P.solve(
    { l: 420, w: 200, h: 200, max_weight: 8000, axle },
    [
      { id: 'fridge', name: '冰箱', l: 70, w: 70, h: 180, weight: 300, qty: 8, category: '冰箱' },
      { id: 'washer', name: '洗衣机', l: 60, w: 60, h: 85, weight: 200, qty: 8, category: '洗衣机' },
    ],
    { strategy: 'weight' }
  );
  ok(r.axleReport && r.axleReport.enabled, 'axleReport 已输出');
  ok(r.axleReport.level === 'ok', `最终方案轴荷合规（level=${r.axleReport.level}）`);
  ok(r.axleReport.front_axle_kg <= 3000, `前轴 ${r.axleReport.front_axle_kg}kg ≤ 3000`);
  ok(r.axleReport.rear_axle_kg <= 5000, `后轴 ${r.axleReport.rear_axle_kg}kg ≤ 5000`);
  // 无 axle 参数：报告应为 null（旧调用零影响）
  const r2 = P.solve(
    { l: 420, w: 200, h: 200, max_weight: 8000 },
    [{ id: 'fridge', name: '冰箱', l: 70, w: 70, h: 180, weight: 300, qty: 8 }]
  );
  ok(r2.axleReport === null && r2.stats.axle_mode === false, '无 axle 参数时 axleReport=null');
}

// ---------------- 3. 品类隔离 + 防护增量 ----------------
section('3 品类隔离 incompat + 防护增量 padding');
{
  // 木架家具 与 玻璃面板 冲突：只能装其一
  const r = P.solve(
    { l: 500, w: 220, h: 210, max_weight: 3000, incompat: { '木架家具': ['玻璃面板'] } },
    [
      { id: 'table', name: '实木餐桌', l: 160, w: 90, h: 75, weight: 60, qty: 2, category: '木架家具', padding: { each_l: 10, each_w: 10, each_h: 10 } },
      { id: 'glass', name: '玻璃茶几', l: 110, w: 60, h: 45, weight: 25, qty: 2, category: '玻璃面板' },
    ],
    { strategy: 'volume' }
  );
  const cats = new Set(r.boxes.map(b => b.item.category));
  const hasBoth = cats.has('木架家具') && cats.has('玻璃面板');
  ok(!hasBoth, `冲突品类未同车（实际装车品类：${[...cats].join(',')}）`);
  const catRejected = r.unpacked.filter(u => u.reason === 'category');
  ok(catRejected.length === 1, `被拒品类整组进 unpacked（reason=category，实际 ${catRejected.length}）`);
  // 防护增量：餐桌 160+20=180 装箱尺寸
  const tableBox = r.boxes.find(b => b.item.category === '木架家具');
  if (tableBox) {
    ok(Math.abs(tableBox.l - 180) < 1e-6 || Math.abs(tableBox.w - 110) < 1e-6 || Math.abs(tableBox.h - 95) < 1e-6,
      `装箱尺寸含 padding（l=${tableBox.l} w=${tableBox.w} h=${tableBox.h}，原始 160/90/75 +10/边）`);
  } else {
    ok(false, '木架家具应至少装入一件');
  }
  // stats 输出
  ok(r.stats.category_conflict_rejected >= 2, `stats.category_conflict_rejected=${r.stats.category_conflict_rejected}（玻璃茶几 2 件全拒）`);
}
{
  // 无冲突品类：全部正常装
  const r = P.solve(
    { l: 500, w: 220, h: 210, max_weight: 3000, incompat: { '木架家具': ['玻璃面板'] } },
    [
      { id: 'table', name: '实木餐桌', l: 160, w: 90, h: 75, weight: 60, qty: 2, category: '木架家具' },
      { id: 'chair', name: '餐椅', l: 45, w: 45, h: 90, weight: 8, qty: 6, category: '软包' },
    ],
    {}
  );
  ok(r.unpacked.length === 0, `无冲突品类全部装入（unpacked=${r.unpacked.length}）`);
}

// ---------------- 4. 超长件尾悬 ----------------
section('4 超长件尾悬 overhang');
{
  // 床垫 220cm 长 vs 车厢 420cm：不需要悬伸（可平放）
  // 板材 450cm：厢内 420 + 悬伸 30 ≤ overhang_max 50 → 允许
  const r = P.solve(
    { l: 420, w: 200, h: 200, max_weight: 3000, overhang_max: 50 },
    [
      { id: 'board', name: '实木板材', l: 450, w: 60, h: 6, weight: 120, overhang: true, canRotate: false },
      { id: 'mattress', name: '床垫', l: 200, w: 150, h: 25, weight: 40 },
    ],
    {}
  );
  ok(r.overhangs.length === 1, `尾悬件 1 件（实际 ${r.overhangs.length}）`);
  const ov = r.overhangs[0];
  ok(ov && ov.out_cm === 30 && ov.inside_cm === 420, `厢内 420 + 悬伸 30（实际 ${ov && ov.inside_cm}/${ov && ov.out_cm}）`);
  ok(r.stats.overhang_count === 1, `stats.overhang_count=1`);
  const boardBox = r.boxes.find(b => b.id === 'board');
  ok(boardBox && Math.abs(boardBox.x - 0) < 1e-6 && Math.abs(boardBox.l - 420) < 1e-6,
    `板材厢内段贴 x=0~420（实际 x=${boardBox && boardBox.x} l=${boardBox && boardBox.l}）`);
}
{
  // 悬伸超限：板材 500cm，厢内 420 + 悬 80 > 50 → 不允许 → unpacked
  const r = P.solve(
    { l: 420, w: 200, h: 200, max_weight: 3000, overhang_max: 50 },
    [{ id: 'board2', name: '超长板材', l: 500, w: 60, h: 6, weight: 120, overhang: true, canRotate: false }],
    {}
  );
  ok(r.overhangs.length === 0 && r.unpacked.length === 1, `悬伸超限不装（overhangs=${r.overhangs.length} unpacked=${r.unpacked.length}）`);
}
{
  // 未声明 overhang:true 的超长件：不启用悬伸（向后兼容）
  const r = P.solve(
    { l: 420, w: 200, h: 200, max_weight: 3000, overhang_max: 50 },
    [{ id: 'board3', name: '普通超长件', l: 450, w: 60, h: 6, weight: 120, canRotate: false }],
    {}
  );
  ok(r.overhangs.length === 0, `未声明 overhang 的超长件不悬伸（${r.overhangs.length}）`);
}

// ---------------- 5. 组合场景 ----------------
section('5 组合：分组 + 品类 + 轴荷同车');
{
  const r = P.solve(
    {
      l: 420, w: 200, h: 200, max_weight: 4000,
      incompat: { '大家电': ['玻璃面板'] },
      axle: { wheelbase_cm: 380, front_limit_kg: 3000, rear_limit_kg: 5000, curb_front_kg: 1500, curb_rear_kg: 2000, front_axle_at_cm: 0 },
    },
    [
      { id: 'fridge', name: '冰箱', l: 70, w: 70, h: 180, weight: 300, qty: 3, category: '大家电', groupId: 'ORDER-A' },
      { id: 'tv', name: '电视', l: 130, w: 20, h: 80, weight: 25, qty: 2, category: '大家电', groupId: 'ORDER-A' },
      { id: 'glass', name: '玻璃展柜', l: 100, w: 45, h: 180, weight: 50, category: '玻璃面板' },
    ],
    { strategy: 'weight' }
  );
  const cats = new Set(r.boxes.map(b => b.item.category));
  ok(!(cats.has('大家电') && cats.has('玻璃面板')), '组合场景：冲突品类未同车');
  const groupACount = r.boxes.filter(b => b.item.groupId === 'ORDER-A').length;
  ok(groupACount === 0 || groupACount === 5, `组合场景：ORDER-A 整组一致（${groupACount}/5）`);
  if (r.axleReport) ok(r.axleReport.level === 'ok', '组合场景：轴荷合规');
}

console.log(`\n========== 结果: ${pass} pass, ${fail} fail ==========`);
process.exit(fail ? 1 : 0);
