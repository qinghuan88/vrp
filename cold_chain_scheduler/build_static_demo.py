# -*- coding: utf-8 -*-
"""
生成"冷链智能物流调度系统 - 单文件版"（两个独立页面）
  - index.html   : 冷链药品智能调度（前端 VRP 求解）
  - packing.html : 大件货品智能配载（3D 装箱 + Three.js 可视化）
打包为 2 个自包含 HTML，双击即可使用，零后端依赖。
Three.js/OrbitControls 以 importmap 内联（避免外部路径）。
"""
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
OUT_INDEX = BASE / "冷链智能物流调度_智能调度版.html"
OUT_PACK = BASE / "冷链智能物流调度_配载版.html"


def inline_three(html):
    """把 importmap 指向的外部 three 模块内联"""
    three_js = (STATIC / "lib" / "three" / "three.module.min.js").read_text(encoding="utf-8")
    orbit_js = (STATIC / "lib" / "three" / "OrbitControls.js").read_text(encoding="utf-8")
    # OrbitControls 里 import 'three' → 替换为内联模块名
    orbit_js = orbit_js.replace("from 'three'", "from './three.module.min.js'")
    map_block = (
        '<script type="importmap">{"imports": {"three.module.min.js": "data:text/javascript;base64,'
        + encode_b64(three_js)
        + '"}}</script>'
        '<script type="module" src="data:text/javascript;base64,'
        + encode_b64(orbit_js)
        + '"></script>'
    )
    html = html.replace('<script src="packing_solver.js"></script>', "")
    return html, map_block


def encode_b64(text):
    import base64
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def build_index():
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    app_js = (STATIC / "app.js").read_text(encoding="utf-8")
    solver_js = (STATIC / "vrp_solver.js").read_text(encoding="utf-8")
    order_model_js = (STATIC / "order_model.js").read_text(encoding="utf-8")

    demo_file = STATIC / "data" / "demo_input.json"
    demo_data = json.loads(demo_file.read_text(encoding="utf-8"))

    html = html.replace('<link rel="stylesheet" href="style.css">', f'<style>\n{css}\n</style>')
    html = html.replace('<script src="order_model.js"></script>', "")
    html = html.replace('<script src="vrp_solver.js"></script>', "")
    html = html.replace('<script src="app.js"></script>', "")

    embed = (
        "<script>\nwindow.__EMBEDDED_DATA__ = "
        + json.dumps(demo_data, ensure_ascii=False)
        + ";\n</script>\n"
        + "<script>\n" + order_model_js + "\n</script>\n"
        + "<script>\n" + solver_js + "\n</script>\n"
        + "<script>\n" + app_js + "\n</script>\n"
    )
    html = html.replace("</body>", embed + "</body>")

    OUT_INDEX.write_text(html, encoding="utf-8")
    print(f"✅ 智能调度版: {OUT_INDEX} ({OUT_INDEX.stat().st_size // 1024} KB)")


def build_packing():
    html = (STATIC / "packing.html").read_text(encoding="utf-8")
    # 抽取 style
    style_m = re.search(r"<style>([\s\S]*?)</style>", html)
    css = style_m.group(1) if style_m else ""
    # 抽取 body 内容（保留 header/main/scripts 结构，剥掉独立 style 与外部 script）
    body_m = re.search(r"<body>([\s\S]*?)</body>", html)
    body = body_m.group(1) if body_m else html

    app_js = (STATIC / "packing_app.js").read_text(encoding="utf-8")
    solver_js = (STATIC / "packing_solver.js").read_text(encoding="utf-8")
    vrp_solver_js = (STATIC / "vrp_solver.js").read_text(encoding="utf-8")
    order_model_js = (STATIC / "order_model.js").read_text(encoding="utf-8")

    # 移除 body 中外部脚本引用（保留 SheetJS CDN 与 Three CDN importmap）
    body = re.sub(r'<script[^>]*src="(?!https?://)[^"]*"[^>]*></script>', "", body)
    body = re.sub(r'<script type="importmap">[\s\S]*?</script>', "", body)

    # 内嵌调度数据（一键全流程用）
    sched_data = json.loads((STATIC / "data" / "demo_input.json").read_text(encoding="utf-8"))

    importmap = (
        '<script type="importmap">{"imports": {"three": "https://unpkg.com/three@0.160.0/build/three.module.min.js", "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"}}</script>'
    )
    embed = (
        "<script>\nwindow.__EMBEDDED_SCHEDULE_DATA__ = "
        + json.dumps(sched_data, ensure_ascii=False)
        + ";\n</script>\n"
        + "<script>\n" + solver_js + "\n</script>\n"
        + "<script>\n" + order_model_js + "\n</script>\n"
        + "<script>\n" + vrp_solver_js + "\n</script>\n"
        + "<script>\n" + app_js + "\n</script>\n"
    )

    out = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📦 大件货品智能配载系统</title>
<style>
{css}
</style>
</head>
<body>
{body}
{importmap}
{embed}
</body>
</html>
"""
    OUT_PACK.write_text(out, encoding="utf-8")
    print(f"✅ 配载版: {OUT_PACK} ({OUT_PACK.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    build_index()
    build_packing()
    print("完成。")
