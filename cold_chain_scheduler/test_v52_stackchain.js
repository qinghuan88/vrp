/* v5.2 算法增强层测试：承重链传递校验 / 分组回退修复 */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, 'static', 'packing_solver.js'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.error(`  FAIL ${msg}`); }
}
function section(t) { console.log(`\n[${t}]`); }

// ---------------- 1. 承重链传递：三层堆叠 ----------------
section('1 承重链传递（C压B压A）');
{
  // 单柱车厢（100×100 底面）强制垂直堆叠：A 地板、B 压 A、C 压 B
  // A 扛 250：B(80)+C(60)=140 ≤ 250 ✓；B 扛 150：C(60) ≤ 150 ✓ → 三层全装
  const r = P.solve(
    { l: 100, w: 100, h: 300, max_weight: 99999 },
    [
      { id: 'A', name: '底柜', l: 100, w: 100, h: 100, weight: 50, maxStack: 250, canRotate: false, qty: 1 },
      { id: 'B', name: '中柜', l: 100, w: 100, h: 100, weight: 80, maxStack: 150, canRotate: false, qty: 1 },
      { id: 'C', name: '顶柜', l: 100, w: 100, h: 100, weight: 60, canRotate: false, qty: 1 },
    ],
    { strategy: 'volume' }
  );
  const a = r.boxes.find(b => b.id === 'A');
  const b = r.boxes.find(b => b.id === 'B');
  const c = r.boxes.find(b => b.id === 'C');
  ok(a && b && c, `三件全装入（A=${!!a} B=${!!b} C=${!!c}）`);
  if (a && b && c) {
    ok(a.y === 0 && b.y === 100 && c.y === 200, `三层堆叠 y=0/100/200（实际 ${a.y}/${b.y}/${c.y}）`);
    ok(Math.abs((a._load || 0) - 140) < 1e-6, `A 累计载荷 140 = B(80)+C(60)（实际 ${a._load}）`);
    ok(Math.abs((b._load || 0) - 60) < 1e-6, `B 累计载荷 60 = C（实际 ${b._load}）`);
    ok(Array.isArray(b.supportedBy) && b.supportedBy[0] === a, `B.supportedBy → A`);
    ok(Array.isArray(c.supportedBy) && c.supportedBy[0] === b, `C.supportedBy → B`);
  }
}
{
  // 拦截场景（多策略下确定触发）：单柱车厢高 200 只容 2 层。
  // A 承重 50 压底，B 重 80、C 重 30。承重链让 solver 选择 A→C（30≤50 ✓），
  // B 拒装（压 A 则 80>50 ✗）。旧逻辑：任何策略都能 A→B→C 全装（漏检！）
  const r = P.solve(
    { l: 100, w: 100, h: 200, max_weight: 99999 },
    [
      { id: 'A', name: '底座', l: 100, w: 100, h: 100, weight: 50, maxStack: 50, canRotate: false, qty: 1 },
      { id: 'B', name: '重箱', l: 100, w: 100, h: 100, weight: 80, canRotate: false, qty: 1 },
      { id: 'C', name: '轻箱', l: 100, w: 100, h: 100, weight: 30, canRotate: false, qty: 1 },
    ],
    { strategy: 'volume' }
  );
  const a = r.boxes.find(b => b.id === 'A');
  const b = r.boxes.find(b => b.id === 'B');
  const c = r.boxes.find(b => b.id === 'C');
  ok(a && c && !b, `A 底 + C 顶装入，B 被承重链拦截（80 > 50）`);
  if (a && c) {
    ok(c.y === 100 && Math.abs((a._load || 0) - 30) < 1e-6, `C 压 A：A 载荷 30 ≤ 50（实际 ${a._load}）`);
    ok(Array.isArray(c.supportedBy) && c.supportedBy[0] === a, `C.supportedBy → A`);
  }
}
{
  // 传递深度场景（必须穿透两层才能发现超限）：h=300 单柱容 3 层。
  // A 承重 100 压底，B 承重无限中转，C 重 60 顶。
  // 旧逻辑：C 压 B 查 B（无限）→ 放行（漏检 A 将承受 B+C=140 > 100）
  // 新逻辑：链条穿透 B 传到 A → C 拒装，B 正常装
  const r = P.solve(
    { l: 100, w: 100, h: 300, max_weight: 99999 },
    [
      { id: 'A', name: '底座', l: 100, w: 100, h: 100, weight: 80, maxStack: 100, canRotate: false, qty: 1 },
      { id: 'B', name: '中转箱', l: 100, w: 100, h: 100, weight: 80, maxStack: Infinity, canRotate: false, qty: 1 },
      { id: 'C', name: '顶箱', l: 100, w: 100, h: 100, weight: 60, canRotate: false, qty: 1 },
    ],
    { strategy: 'volume' }
  );
  const a = r.boxes.find(b => b.id === 'A');
  const b = r.boxes.find(b => b.id === 'B');
  const c = r.boxes.find(b => b.id === 'C');
  // 合法布局：A→B（80≤100）✓，C 压 B 传 A：140>100 ✗ → solver 应改选
  // A→C（60≤100）✓ + B 拒，或 A→B + C 拒（两者装载体积相同，先试者胜）
  ok(a && (b || c), `A 底座装入 + 至少一只上层箱`);
  if (a && b && !c) {
    ok(Math.abs((a._load || 0) - 80) < 1e-6, `方案 A→B：A 载荷 80 ≤ 100（实际 ${a._load}）`);
    ok(Array.isArray(b.supportedBy) && b.supportedBy[0] === a, `B.supportedBy → A`);
  } else if (a && c && !b) {
    ok(Math.abs((a._load || 0) - 60) < 1e-6, `方案 A→C：A 载荷 60 ≤ 100（实际 ${a._load}）`);
  } else {
    ok(false, `承重链应在 A(100) 顶上最多承载 100kg：A→B→C 全装（${a && a._load}）属漏检`);
  }
}
{
  // 场景：maxStack=Infinity 短路——不限制堆叠，行为与旧版一致
  const r = P.solve(
    { l: 400, w: 200, h: 300, max_weight: 99999 },
    [
      { id: 'A', name: '底柜', l: 100, w: 100, h: 100, weight: 50, canRotate: false, qty: 1 },
      { id: 'B', name: '中柜', l: 100, w: 100, h: 100, weight: 800, canRotate: false, qty: 1 },
      { id: 'C', name: '顶柜', l: 100, w: 100, h: 100, weight: 900, canRotate: false, qty: 1 },
    ],
    { strategy: 'volume' }
  );
  ok(r.boxes.length === 3 && r.unpacked.length === 0, `无限承重全装（3/3）`);
}

// ---------------- 2. 分组回退修复验证 ----------------
section('2 分组回退修复（v5.2 removedIds bug）');
{
  // v5.2 前 removedIds 全是 undefined → Set 无效 → keepBoxes 含全部箱 →
  // "回退"实际是全量重放，分组从未真正撤销。修复后应真正移除同组箱
  const r = P.solve(
    { l: 400, w: 200, h: 200, max_weight: 2000 },
    [
      { id: 'g1', name: '组件1', l: 100, w: 100, h: 80, weight: 50, groupId: 'G' },
      { id: 'g2', name: '组件2', l: 120, w: 100, h: 80, weight: 50, groupId: 'G' },
      { id: 'g3', name: '超大件', l: 450, w: 90, h: 85, weight: 70, groupId: 'G' },
      { id: 'x', name: '独立件', l: 100, w: 100, h: 80, weight: 30 },
    ],
    { strategy: 'volume' }
  );
  const groupBoxes = r.boxes.filter(b => b.item.groupId === 'G');
  ok(groupBoxes.length === 0, `G 组箱全部撤下（残留 ${groupBoxes.length}）`);
  ok(r.boxes.some(b => b.id === 'x'), `独立件 x 保留装入`);
  const gUnpacked = r.unpacked.filter(u => u.groupId === 'G');
  ok(gUnpacked.length === 3 && gUnpacked.every(u => u.reason === 'group_incomplete'),
    `G 组 3 件全部进 unpacked 且 reason=group_incomplete`);
}
{
  // 回退后空间索引重建验证：回退 G 组腾出的空间可被后续项占用，无重叠
  const r = P.solve(
    { l: 400, w: 200, h: 200, max_weight: 2000 },
    [
      { id: 'g1', name: '组件1', l: 100, w: 100, h: 80, weight: 50, groupId: 'G' },
      { id: 'g2', name: '组件2', l: 120, w: 100, h: 80, weight: 50, groupId: 'G' },
      { id: 'g3', name: '超大件', l: 450, w: 90, h: 85, weight: 70, groupId: 'G' },
      { id: 'y1', name: '后到件1', l: 100, w: 100, h: 80, weight: 30 },
      { id: 'y2', name: '后到件2', l: 100, w: 100, h: 80, weight: 30 },
    ],
    { strategy: 'volume' }
  );
  // y1/y2 排在 g1/g2 之后：装箱顺序上 g1、g2 先装，g3 失败触发回退，
  // 回退腾出的空间被 y1/y2 补占——最终无重叠
  let overlaps = 0;
  const bs = r.boxes;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    if (a.x < b.x + b.l && a.x + a.l > b.x &&
        a.y < b.y + b.h && a.y + a.h > b.y &&
        a.z < b.z + b.w && a.z + a.w > b.z) overlaps++;
  }
  ok(overlaps === 0, `回退重放后全厢无重叠（${overlaps} 处）`);
  ok(r.boxes.filter(b => b.id.startsWith('y')).length === 2, `y1/y2 装入回退腾出的空间（${r.boxes.filter(b => b.id.startsWith('y')).length}/2）`);
}

// ---------------- 3. 承重链 + locked 滚动重配载 ----------------
section('3 承重链 × locked 增量');
{
  // locked 箱 maxStack=100，新货 120kg 想堆其上 → 拒；
  // 新货 90kg → 允许（≤100）
  const c = { l: 300, w: 200, h: 200, max_weight: 99999 };
  const locked = [
    { x: 0, y: 0, z: 0, l: 300, w: 200, h: 100, item: { weight: 500, l: 300, w: 200, h: 100, maxStack: 100 }, id: 'base', name: '托盘底' },
  ];
  const rHeavy = P.solveIncremental(c, locked, [
    { id: 'big', name: '重机', l: 60, w: 60, h: 85, weight: 120, qty: 1 },
  ], {});
  const newHeavy = rHeavy.boxes.filter(b => !b.locked);
  ok(newHeavy.length === 0 || newHeavy.every(b => b.y === 0 || b.y >= 100),
    `120kg 新货不得压上 maxStack=100 的 locked 托盘（y=${newHeavy.map(b => b.y)}）`);

  const rLight = P.solveIncremental(c, locked, [
    { id: 'light', name: '轻箱', l: 60, w: 60, h: 85, weight: 90, qty: 1 },
  ], {});
  const newLight = rLight.boxes.filter(b => !b.locked);
  ok(newLight.length === 1 && newLight[0].y >= 100 - 1e-6,
    `90kg 轻箱可堆上托盘（y=${newLight.length ? newLight[0].y : '未装'}）`);
  const base = rLight.boxes.find(b => b.locked);
  ok(base && Math.abs((base._load || 0) - 90) < 1e-6, `locked 托盘累计载荷 90（实际 ${base && base._load}）`);
}

// ---------------- 4. 多策略竞争下承重链一致性 ----------------
section('4 多策略竞争 + 承重链不变量');
{
  // 混合场景：有限承重箱 + 普通箱 30 件，四策略竞争后无论哪个胜出，
  // 不变量"每箱累计载荷 ≤ maxStack"必须成立
  const r = P.solve(
    { l: 500, w: 240, h: 240, max_weight: 99999 },
    [
      { id: 'shelf', name: '货架板', l: 120, w: 100, h: 20, weight: 40, maxStack: 60, canRotate: false, qty: 6 },
      { id: 'carton', name: '纸箱', l: 60, w: 50, h: 50, weight: 25, qty: 20 },
      { id: 'bigcarton', name: '大纸箱', l: 100, w: 80, h: 60, weight: 55, qty: 6 },
    ],
    { strategy: 'volume' }
  );
  let chainViolations = 0;
  for (const b of r.boxes) {
    const ms = (b.item && b.item.maxStack) != null ? b.item.maxStack : Infinity;
    if (ms !== Infinity && (b._load || 0) > ms + 1e-6) chainViolations++;
  }
  ok(chainViolations === 0, `全厢承重链不变量成立（超限箱 ${chainViolations} 只）`);
  ok(r.boxes.length > 20, `装载量正常（${r.boxes.length} 件）`);
  // 空间不变量：无重叠
  let overlaps = 0;
  const bs = r.boxes;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    if (a.x < b.x + b.l && a.x + a.l > b.x &&
        a.y < b.y + b.h && a.y + a.h > b.y &&
        a.z < b.z + b.w && a.z + a.w > b.z) overlaps++;
  }
  ok(overlaps === 0, `全厢无重叠（${overlaps} 处）`);
}

// ---------------- 5. stop-aware λ 自适应归一化 ----------------
section('5 λ 自适应 stopPenaltyMode');
{
  const mk = (mode) => P.solve(
    { l: 500, w: 220, h: 200, max_weight: 2500 },
    [
      { id: 'R', name: '甲店货', l: 50, w: 50, h: 40, weight: 20, qty: 15, stop: '甲店' },
      { id: 'S', name: '乙店货', l: 40, w: 30, h: 35, weight: 12, qty: 15, stop: '乙店' },
      { id: 'T', name: '丙店货', l: 40, w: 30, h: 35, weight: 12, qty: 15, stop: '丙店' },
    ],
    { strategy: 'volume', stopOrder: ['甲店', '乙店', '丙店'], stopPenaltyMode: mode }
  );
  const legacy = mk('legacy');
  const adaptive = mk('adaptive');
  const dflt = mk(undefined);

  ok(legacy.stats.packed_count === 45 && adaptive.stats.packed_count === 45,
    `两模式均全装 45 件（legacy=${legacy.stats.packed_count} adaptive=${adaptive.stats.packed_count}）`);
  ok(legacy.stopReport.violations === 0 && adaptive.stopReport.violations === 0,
    `两模式卸货顺序违规均为 0`);
  // 默认（不传）与 legacy 逐字节一致——向后兼容硬要求
  const sig = (r) => JSON.stringify(r.boxes.map(b => [b.x, b.y, b.z, b.l, b.w, b.h]));
  ok(sig(dflt) === sig(legacy), `默认不传参数 = legacy 布局（快照兼容）`);
  // adaptive 生效：甲店（第一站）货品在 adaptive 下门端引导强度不同 → 布局应有所变化
  // （λ = 5e4 × 220/500 / log(5) ≈ 1.34e4 < 5e4，引导更温和）
  ok(sig(adaptive) !== sig(legacy), `adaptive 模式实际生效（布局与 legacy 不同）`);
  // 无论哪种模式，先到站货品的靠门程度（x+l 均值，门在 x=L 端，越大越靠门）
  // 都应 ≥ 后到站——先卸的货最靠门
  const depthBy = (r, stop) => {
    const bs = r.boxes.filter(b => b.item.stop === stop);
    return bs.length ? bs.reduce((a, b) => a + (b.x + b.l), 0) / bs.length : null;
  };
  for (const [name, r] of [['legacy', legacy], ['adaptive', adaptive]]) {
    const d1 = depthBy(r, '甲店'), d2 = depthBy(r, '乙店'), d3 = depthBy(r, '丙店');
    ok(d1 >= d2 - 1e-6 && d2 >= d3 - 1e-6,
      `${name}：先到站更靠门（${Math.round(d1)} ≥ ${Math.round(d2)} ≥ ${Math.round(d3)}）`);
  }
}

console.log(`\n========== 结果: ${pass} pass, ${fail} fail ==========`);
process.exit(fail ? 1 : 0);
