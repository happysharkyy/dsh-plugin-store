"""校验恢复后的文件可读可解析。只读，不写盘。

用法:
    python check_syntax.py <文件> [<文件> ...]

.py 走 compile()；.html/.htm 判是否完整收尾（整页看 </html>，Jinja 模板按
宏/块/if/for 的开闭配对判断）；二进制扩展名只报大小；其余按 UTF-8 文本读取。
任一文件失败时退出码为 1。
"""

from __future__ import annotations

import pathlib
import sys

BINARY_SUFFIX = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
    ".xlsx", ".xlsm", ".docx", ".pptx", ".pdf", ".zip", ".7z",
    ".gz", ".tar", ".pcap", ".pcapng", ".sqlite", ".sqlite3", ".db",
    ".woff", ".woff2", ".ttf", ".eot", ".exe", ".dll", ".pyc",
}

# 开标签 -> 闭标签。'{% block' 不会命中 '{% endblock'，因为前缀要求 '{% ' 后紧跟 block。
JINJA_PAIRS = (
    ("{% macro", "{% endmacro"),
    ("{% block", "{% endblock"),
    ("{% if", "{% endif"),
    ("{% for", "{% endfor"),
    ("{% call", "{% endcall"),
    ("{% filter", "{% endfilter"),
    ("{% with", "{% endwith"),
)


def check(path: pathlib.Path) -> str:
    suffix = path.suffix.lower()
    if suffix in BINARY_SUFFIX:
        return f"OK binary {path.stat().st_size} bytes"
    text = path.read_text(encoding="utf-8")
    if suffix == ".py":
        compile(text, str(path), "exec")
        return f"OK py {len(text.splitlines())} lines"
    if suffix in (".html", ".htm"):
        if "</html>" in text.lower():
            return f"OK html {len(text.splitlines())} lines"
        if "{%" not in text:
            raise ValueError("既无 </html> 也不是 Jinja 模板")
        for opener, closer in JINJA_PAIRS:
            if text.count(opener) != text.count(closer):
                tail = text.rstrip()[-60:].replace("\n", " ")
                raise ValueError(
                    f"Jinja 标签不配对: {opener} x{text.count(opener)} vs "
                    f"{closer} x{text.count(closer)}，尾部 {tail!r}"
                )
        return f"OK html(jinja) {len(text.splitlines())} lines"
    return f"OK text {len(text.splitlines())} lines"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    failed = 0
    for raw in argv[1:]:
        path = pathlib.Path(raw)
        try:
            print(f"{path}\t{check(path)}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"{path}\tFAIL {type(exc).__name__}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
