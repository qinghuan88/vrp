# -*- coding: utf-8 -*-
"""上传前敏感信息扫描：绝对路径 / 密钥 / 手机号 / 邮箱"""
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent
FILES = [
    'static/packing_solver.js', 'static/packing_app.js', 'static/vrp_solver.js',
    'static/order_model.js', 'static/app.js',
    'static/index.html', 'static/packing.html', 'static/style.css',
    'static/data/demo_input.json',
    'test_v5_constraints.js', 'test_v51_incremental.js', 'test_v52_stackchain.js',
    'test_solver_node.js', 'snapshot_packing.js', 'packing_snapshot.json',
    'packing_snapshot_baseline.json', 'build_static_demo.py',
    'README.md', '使用说明_大件货品配载平台.md',
]

PATTERNS = [
    (re.compile(r'[A-Z]:\\\\?Users\\\\?\d|G:\\\\?WORKBUDDY', re.I), '本机绝对路径'),
    (re.compile(r'(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["\'][^"\']{6,}', re.I), '疑似密钥'),
    (re.compile(r'\b1[3-9]\d{9}\b'), '手机号'),
    (re.compile(r'\b[\w.]+@[\w.]+\.(?:com|cn|net|org)\b'), '邮箱'),
]

issues = 0
for f in FILES:
    p = BASE / f
    if not p.exists():
        print(f'MISSING {f}')
        issues += 1
        continue
    content = p.read_text(encoding='utf-8', errors='ignore')
    for pat, name in PATTERNS:
        for m in pat.finditer(content):
            print(f'WARN {f} [{name}]: {m.group(0)[:60]}')
            issues += 1

print('安全扫描通过：无敏感信息' if issues == 0 else f'发现 {issues} 处待确认')
raise SystemExit(0 if issues == 0 else 1)
