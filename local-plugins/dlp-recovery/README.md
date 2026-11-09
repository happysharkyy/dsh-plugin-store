# dsh-dlp-recovery

把被**企业透明加密软件**（DLP / Ocular / TSGuard 等）覆盖成密文的源文件还原为磁盘明文。

打包成 DSH 插件后，模型可以直接识别并处理这类问题——不用每次都手工跑脚本。

## 什么时候会用到

典型症状：

- 文件前 16 字节是 `%TSD-Header-###%`
- 同一个文件，Node / Python 读出来是正常文本，编辑器 / `tar` / `git diff` 读出来是乱码
- `Get-Item Length` 返回 4 KB 的整数倍（虚报长度）
- 打出来的压缩包全坏，但表面看不出问题

成因：DLP 对**受信进程**（python.exe、git.exe 等白名单程序）的读取自动解密，对它们的**写入**则立即加密。所以受信进程自己读写都对，换一个进程看就是密文。

## 装了什么

```
skills/dlp-file-recovery/
├── SKILL.md                 判断依据与恢复链路
└── scripts/
    ├── restore-dlp.ps1      扫描 + 恢复 + 校验（总入口）
    ├── dump_plaintext.py    受信进程读出明文，落到 %TEMP% 的 .mdx 副本
    └── check_syntax.py      恢复后校验（只读）
```

一条命令恢复整个目录：

```powershell
powershell -ExecutionPolicy Bypass -File \
  <skills>/dlp-file-recovery/scripts/restore-dlp.ps1 -Root <目录>
```

加 `-ScanOnly` 只出报告不写盘；加 `-Path a.py,b.py` 只处理指定文件。

## 平台

恢复流程依赖 PowerShell 与 Windows 上的 DLP 行为，**只在 Windows 上有效**。插件本身是纯 JS 包，任何平台都能装，但在 Linux/macOS 上跑没有意义。

## 注意

- 恢复只保证「磁盘字节 == 原始明文」，不判断内容是否正确。要确认没串写，逐文件和 git blob 比对。
- 恢复后文件可能被再次加密（大文件会被回扫），重跑一次扫描即可。
- 不要用 git 回滚 / `checkout` 修文件，会触发加密软件，还会丢本地改动。
