# -*- coding: utf-8 -*-
"""使用说明 Markdown -> 精排 HTML -> PDF（Chrome headless 打印）"""
import html as htmllib
import re
import subprocess
from pathlib import Path

BASE = Path(__file__).resolve().parent
MD = BASE / "使用说明_大件货品配载平台.md"
HTML = BASE / "使用说明_大件货品配载平台.html"
PDF = BASE / "使用说明_大件货品配载平台.pdf"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

md = MD.read_text(encoding="utf-8")


# ---------- Markdown -> HTML（覆盖本文档用到的语法子集） ----------
def inline(s):
    s = htmllib.escape(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)          # 行内代码
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)  # 粗体
    return s


lines = md.split("\n")
out = []
i = 0
in_code = False
code_buf = []
table_buf = []
in_table = False


def flush_table():
    global table_buf
    if not table_buf:
        return
    rows = []
    for ri, row in enumerate(table_buf):
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        if ri == 1 and all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
            continue  # 分隔行
        tag = "th" if ri == 0 else "td"
        rows.append("<tr>" + "".join(f"<{tag}>{inline(c)}</{tag}>" for c in cells) + "</tr>")
    print("<table>" + "".join(rows) + "</table>", file=buf)
    table_buf = []


class Buf:
    def __init__(self):
        self.parts = []

    def write(self, s):
        self.parts.append(s if s.endswith("\n") else s + "\n")


buf = Buf()

while i < len(lines):
    line = lines[i]

    # 代码块
    if line.strip().startswith("```"):
        if in_code:
            buf.write('<pre class="code">' + htmllib.escape("\n".join(code_buf)) + "</pre>")
            code_buf = []
            in_code = False
        else:
            flush_table()
            in_code = True
        i += 1
        continue
    if in_code:
        code_buf.append(line)
        i += 1
        continue

    # 表格
    if line.strip().startswith("|"):
        in_table = True
        table_buf.append(line)
        i += 1
        continue
    elif in_table:
        in_table = False
        flush_table()

    stripped = line.strip()

    if not stripped:
        i += 1
        continue

    # 标题
    m = re.match(r"^(#{1,4})\s+(.*)", stripped)
    if m:
        lvl = len(m.group(1))
        buf.write(f"<h{lvl}>{inline(m.group(2))}</h{lvl}>")
        i += 1
        continue

    # 分隔线
    if re.fullmatch(r"-{3,}", stripped):
        buf.write("<hr>")
        i += 1
        continue

    # 引用块
    if stripped.startswith(">"):
        quote_lines = []
        while i < len(lines) and lines[i].strip().startswith(">"):
            quote_lines.append(lines[i].strip().lstrip(">").strip())
            i += 1
        buf.write("<blockquote>" + inline(" ".join(quote_lines)) + "</blockquote>")
        continue

    # 有序列表
    if re.match(r"^\d+\.\s", stripped):
        items = []
        while i < len(lines) and re.match(r"^\s*\d+\.\s", lines[i]):
            items.append(re.sub(r"^\s*\d+\.\s+", "", lines[i].strip()))
            i += 1
        buf.write("<ol>" + "".join(f"<li>{inline(it)}</li>" for it in items) + "</ol>")
        continue

    # 无序列表
    if stripped.startswith("- ") or stripped.startswith("* "):
        items = []
        while i < len(lines) and re.match(r"^\s*[-*]\s", lines[i]):
            items.append(re.sub(r"^\s*[-*]\s+", "", lines[i].strip()))
            i += 1
        buf.write("<ul>" + "".join(f"<li>{inline(it)}</li>" for it in items) + "</ul>")
        continue

    # 普通段落（合并连续行）
    para = [stripped]
    i += 1
    while i < len(lines):
        nxt = lines[i].strip()
        if (not nxt or nxt.startswith(("#", ">", "- ", "* ", "|", "```"))
                or re.match(r"^\d+\.\s", nxt) or re.fullmatch(r"-{3,}", nxt)):
            break
        para.append(nxt)
        i += 1
    buf.write("<p>" + inline(" ".join(para)) + "</p>")

flush_table()

CSS = """
@page { size: A4; margin: 16mm 15mm; }
* { box-sizing: border-box; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
  font-size: 10.5pt; line-height: 1.75; color: #1f2d3d; margin: 0;
}
h1 {
  font-size: 19pt; color: #0e7fd4; border-bottom: 3px solid #0e7fd4;
  padding-bottom: 8px; margin: 0 0 6px 0;
}
h2 {
  font-size: 14pt; color: #8e44ad; margin: 22px 0 8px;
  padding-left: 10px; border-left: 5px solid #8e44ad;
  page-break-after: avoid;
}
h3 { font-size: 12pt; color: #0e7fd4; margin: 16px 0 6px; page-break-after: avoid; }
h4 { font-size: 11pt; margin: 12px 0 4px; page-break-after: avoid; }
p { margin: 6px 0; }
blockquote {
  margin: 8px 0; padding: 8px 14px; background: #f0f7ff;
  border-left: 4px solid #0e7fd4; border-radius: 4px; color: #4a5b6e; font-size: 9.5pt;
}
blockquote p { margin: 2px 0; }
table {
  border-collapse: collapse; width: 100%; margin: 10px 0;
  font-size: 9.5pt; page-break-inside: avoid;
}
th {
  background: #eef4fa; color: #35506b; text-align: left;
  padding: 6px 9px; border: 1px solid #cdd9e6; white-space: nowrap;
}
td { padding: 5px 9px; border: 1px solid #dde5ee; vertical-align: top; }
tr:nth-child(even) td { background: #f8fafc; }
pre.code {
  background: #22303f; color: #d8e4f0; border-radius: 8px;
  padding: 12px 16px; font-family: Consolas, "Courier New", monospace;
  font-size: 8.8pt; line-height: 1.5; overflow: hidden;
  white-space: pre; page-break-inside: avoid; margin: 10px 0;
}
code {
  background: #eef2f7; border-radius: 3px; padding: 1px 5px;
  font-family: Consolas, "Courier New", monospace; font-size: 9pt; color: #c0392b;
}
pre.code code { background: none; padding: 0; color: inherit; }
ul, ol { margin: 6px 0; padding-left: 22px; }
li { margin: 3px 0; }
hr { border: none; border-top: 1px dashed #c3d0dd; margin: 14px 0; }
strong { color: #14406b; }
footer { margin-top: 26px; color: #8ba0b5; font-size: 8.5pt; text-align: center; }
"""

doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8">
<title>大件货品智能配载平台 · 使用说明</title>
<style>{CSS}</style>
</head>
<body>
{"".join(buf.parts)}
<footer>大件货品智能配载平台 v5.2 · 使用说明 · 2026-08</footer>
</body>
</html>"""

HTML.write_text(doc, encoding="utf-8")
print(f"HTML OK: {HTML.name} ({HTML.stat().st_size // 1024} KB)")

# ---------- Chrome headless 打印 PDF ----------
cmd = [
    CHROME,
    "--headless", "--disable-gpu", "--no-sandbox",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=10000",
    "--no-pdf-header-footer",
    f"--print-to-pdf={PDF}",
    HTML.as_uri(),
]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
if PDF.exists():
    print(f"PDF OK: {PDF.name} ({PDF.stat().st_size // 1024} KB)")
else:
    print("PDF FAILED:", r.stdout[-500:], r.stderr[-500:])
    raise SystemExit(1)
