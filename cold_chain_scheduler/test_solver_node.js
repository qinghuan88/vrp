const fs = require('fs');
const VrpSolver = require('./static/vrp_solver.js');
const input = JSON.parse(fs.readFileSync('output/frontend_input.json', 'utf-8'));
const t0 = Date.now();
const result = VrpSolver.solve(input);
const ms = Date.now() - t0;
const s = result.summary;
console.log('✅ 前端求解器运行成功 | 耗时', ms + 'ms');
console.log('  车辆:', s.used_vehicles, '| 配送:', s.total_delivered_kg, 'kg | 里程:', s.total_distance_km, 'km');
console.log('  成本: ¥' + s.total_cost_yuan, '| 装载率:', s.avg_load_rate + '%');
console.log('  路线数:', result.routes.length);
let ok = true;
result.routes.forEach(r => {
  if (r.peak_load_kg > s.capacity_kg) { console.log('  ❌ 载重超限:', r.vehicle_id); ok = false; }
  if (r.total_time_h > 24) { console.log('  ❌ 时长超限:', r.vehicle_id); ok = false; }
});
console.log(ok ? '  ✅ 全部约束校验通过' : '  ❌ 存在约束违规');
console.log('  首条路线:', result.routes[0].node_names.slice(0,4).join(' → '));
console.log('  coords 长度:', result.routes[0].coords.length);
console.log('  nodes in_solution:', result.nodes.filter(n=>n.in_solution).length);
