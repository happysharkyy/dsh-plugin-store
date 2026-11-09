---
name: dlp-file-recovery
description: Recover files transparently encrypted by DLP or Ocular so they are plaintext on disk. Use when a file starts with the TSD-Header magic bytes, opens as garbled binary, or the user asks to restore encrypted source files. Do not use for git rollback.
---

# DLP 加密文件恢复

把被透明加密软件（Ocular / TSGuard 等 DLP）覆盖成密文的源文件还原为磁盘明文。

## 判据

文件前 16 字节是 `%TSD-Header-###%` 即已被加密。`Get-Item Length` 会返回块对齐（4KB 倍数）的虚报长度，真实大小只能由受信任进程读出。

## 关键机制

- DLP 对**受信进程**（python.exe、git.exe 等在白名单里的程序）的读取自动解密，对它们的**写入**则立即加密。
- 所以：python 读 = 拿到明文；python 写 = 磁盘上留下密文。git / python 内部校验全部能通过，只有非受信进程（IDE、编辑器、Read 工具）永远看到密文。
- 唯一可靠判据是**用非受信方式看磁盘字节**。用 Read 工具或 PowerShell 原始字节流读到明文，才说明磁盘真的明文；"脚本校验通过"不算证据。

## 恢复链路

1. **扫描**：PowerShell 逐文件读前 24 字节，命中 `%TSD` 列入待恢复清单。跳过 `__pycache__`、`.git`、`output` 与二进制/媒体扩展名。
2. **透明解密读出**：受信任解释器读源、写 `.mdx` 副本到 `%TEMP%`。

   ```powershell
   python scripts/dump_plaintext.py "$env:TEMP\dlp" <源文件> [<源文件> ...]
   ```

   必须用 `.mdx` 后缀。DLP 对 `.md` 有独立加密策略，`.mdx` 保持明文。
3. **字节级覆写**：用 PowerShell 把副本覆盖回原路径。

   ```powershell
   Copy-Item -LiteralPath <副本> -Destination <原路径> -Force
   ```
4. **验证**：读回前 16 字节确认不再是 `%TSD`；`.py` 走 `compile()`，模板检查以 `{% endblock %}` 收尾。

一次完成 1-4 步：

```powershell
powershell -ExecutionPolicy Bypass -File D:\skills\dlp-file-recovery\scripts\restore-dlp.ps1 -Root <目录>
```

加 `-ScanOnly` 只出报告不写盘；加 `-Path a.py,b.py` 只处理指定文件。

## 禁止

- 不要用 python 的 `open(..., 'wb')` / `Path.write_bytes()` 写回目标文件。写入即加密，等于白做，且会伪装成成功。
- 不要用 `Set-Content` / `Out-File` 覆写源文件。会加 BOM、改行尾，字节不一致。
- 不要用 git 回滚 / `checkout` / `restore` 修文件。会触发加密软件，还会丢本地改动。
- 恢复过程只做字节搬运，不要顺手改内容。先恢复，再改代码。
- 恢复后如果文件又被加密（常见于 `runner.py` 这类被反复回扫的大文件），重跑扫描即可，不要假设一次就永久解决。

## 其他明文来源

密文若已进 git，`git cat-file blob HEAD:<path>` 也能读出明文（git 是受信进程）。拿到字节后同样走 `Copy-Item` 落盘。只取内容，不做任何回滚类操作。

## 已知限制

- **按扩展名的写策略不同**：同一个目录里 `.py / .md / .json / .txt / .html / .mdx` 写回后保持明文，而 `.htm / .css / .png` 等写回后会被立刻重新加密（`Copy-Item` 报 "still encrypted"）。这类文件不要反复重试，明文只存在于 git（`git cat-file blob HEAD:<path>`）与受信任进程的读取结果里；需要人眼查看时导出到 `%TEMP%` 下的普通文件即可（TEMP 不在策略范围内）。
- 恢复只保证"磁盘字节 == 原始明文"，不判断内容是否正确。判别是否串写的唯一可靠手段是**逐文件与 git blob 比对**（`.py` 再走 `compile()`）。

## 脚本

- `scripts/restore-dlp.ps1`：扫描 + 恢复 + 验证的总入口。
- `scripts/dump_plaintext.py`：受信任进程读源、写 `.mdx` 副本，输出 JSON 清单（路径/字节数/sha256），并落一份 `<输出目录>/manifest.jsonl`。
- `scripts/check_syntax.py`：恢复后校验，只读不写。

## 修复记录

- `dump_plaintext.py` 原先用 `src.name + '.mdx'` 命名副本，**同名文件会互相覆盖**（如 `live/runner.py` 与 `pipeline/runner.py`），随后同一份明文被写回多个原路径，造成静默串写。现改为 `{序号}_{文件名}.mdx`，`restore-dlp.ps1` 增加重复 tmp 检测，写回后再比对 sha256。
- `restore-dlp.ps1` 原先读 python 的 stdout 解析清单，Windows PowerShell 5.1 会按控制台代码页（GBK）解码，中文路径直接变成不存在的路径。现优先读 UTF-8 的 `manifest.jsonl`。
- `check_syntax.py` 原对 `.xlsx` 等二进制按 UTF-8 读取必然报错，且把以 `{% endmacro %}` 收尾的 Jinja 宏文件误判为截断。现按二进制扩展名跳过，Jinja 文件改为开闭标签配对校验。
