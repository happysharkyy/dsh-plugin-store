"""用受信任解释器读取（透明解密）源文件，把明文字节写到 TEMP 下的 .mdx 副本。

用法:
    python dump_plaintext.py <输出目录> <源文件> [<源文件> ...]

每个源文件输出一行 JSON：src / tmp / bytes / sha256，同时写入
<输出目录>/manifest.jsonl（UTF-8，调用方应优先读这个文件，避免控制台
代码页把非 ASCII 路径解码成乱码）。

注意：本脚本只允许写 <输出目录> 下的 .mdx 副本。绝不能写回目标文件——
受信进程写入会被 DLP 立即加密，磁盘上留下的是密文而不是明文。
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    out_dir = pathlib.Path(argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = out_dir / "manifest.jsonl"
    with manifest.open("w", encoding="utf-8", newline="\n") as mf:
        for index, raw in enumerate(argv[2:]):
            src = pathlib.Path(raw)
            if not src.is_file():
                rec = {"src": str(src), "error": "missing"}
                mf.write(json.dumps(rec, ensure_ascii=False) + "\n")
                print(json.dumps(rec, ensure_ascii=False))
                continue
            data = src.read_bytes()
            # Index prefix: two sources can share a basename (e.g. a/README.md and
            # b/README.md). Naming by basename alone makes them overwrite each other,
            # and the later copy then gets written back to BOTH original paths.
            dst = out_dir / f"{index:04d}_{src.name}.mdx"
            dst.write_bytes(data)
            rec = {
                "src": str(src.resolve()),
                "tmp": str(dst),
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            mf.write(json.dumps(rec, ensure_ascii=False) + "\n")
            mf.flush()
            print(json.dumps(rec, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
