<#
.SYNOPSIS
    Scan for and restore files that a DLP product transparently encrypted
    (file header %TSD-Header-###%).

.DESCRIPTION
    Steps:
      1) PowerShell reads the first 24 bytes of each file to find the cipher marker
      2) A trusted python interpreter reads the source (gets transparent plaintext)
         and writes a .mdx copy under %TEMP%\dlp_restore_<timestamp>\
      3) Copy-Item overwrites the original path with the copy, byte for byte
      4) Re-read the header to confirm it is no longer ciphertext, then compile .py

    Disk writes are only allowed through Copy-Item / [IO.File]::WriteAllBytes.
    Do NOT switch to python write_bytes (the write itself gets encrypted by the
    DLP driver) and do NOT use Set-Content (adds a BOM and rewrites line endings).

    This script is ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1
    files without a BOM as ANSI, so non-ASCII literals would be corrupted.

.PARAMETER Root
    Root directory to scan. Also used to locate .venv_eval\Scripts\python.exe.

.PARAMETER Path
    Restrict the work to these files. When omitted the whole Root is scanned.

.PARAMETER ScanOnly
    Report the ciphertext list only, write nothing.

.PARAMETER Python
    Trusted interpreter path. Defaults to <Root>\.venv_eval, then <Root>\.venv,
    then the python found on PATH.

.PARAMETER SkipPattern
    Regex of directories to skip while scanning. Defaults to __pycache__, .git,
    node_modules, output and virtual environments.

.EXAMPLE
    .\restore-dlp.ps1 -Root D:\repo\service_discovery_v2 -ScanOnly

.EXAMPLE
    .\restore-dlp.ps1 -Root D:\repo -Path service_discovery_v2\web\app.py
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string[]]$Path = @(),
    [switch]$ScanOnly,
    [string]$Python = "",
    [string]$SkipPattern = '[\\/](__pycache__|\.git|node_modules|output|\.venv[^\\/]*)([\\/]|$)'
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$excludeExt = @(
    '.sqlite', '.sqlite3', '.db', '.jsol', '.pcap', '.pcapng', '.bak',
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.pdf',
    '.zip', '.7z', '.gz', '.tar', '.exe', '.dll', '.pyc'
)

function Test-Encrypted {
    param([string]$File)
    $fs = $null
    try {
        $fs = [IO.File]::Open($File, 'Open', 'Read', 'ReadWrite')
        $buf = New-Object byte[] 24
        $n = $fs.Read($buf, 0, 24)
        if ($n -lt 8) { return $false }
        return ([Text.Encoding]::ASCII.GetString($buf, 0, $n)).StartsWith('%TSD')
    }
    catch { return $false }
    finally { if ($fs) { $fs.Dispose() } }
}

function Resolve-TrustedPython {
    param([string]$Root, [string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "python not found: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    foreach ($rel in @('.venv_eval\Scripts\python.exe', '.venv\Scripts\python.exe')) {
        $candidate = Join-Path $Root $rel
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $cmd = Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    throw 'No python interpreter found. Pass -Python <trusted .venv_eval\Scripts\python.exe>.'
}

# ---- 1. collect candidate files ----
if ($Path.Count -gt 0) {
    $files = @()
    foreach ($p in $Path) {
        $item = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue
        if ($item -and -not $item.PSIsContainer) { $files += $item }
    }
}
else {
    $files = @(
        Get-ChildItem -LiteralPath $rootPath -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $_.FullName -notmatch $SkipPattern -and
                $excludeExt -notcontains $_.Extension.ToLower()
            }
    )
}

# ---- 2. detect ciphertext ----
$encrypted = @()
foreach ($f in $files) {
    if (Test-Encrypted -File $f.FullName) { $encrypted += $f.FullName }
}

Write-Host ("Scanned {0} files, found {1} encrypted" -f $files.Count, $encrypted.Count)
foreach ($item in $encrypted) { Write-Host ("  encrypted: " + $item) }

if ($ScanOnly -or $encrypted.Count -eq 0) {
    if ($encrypted.Count -eq 0) { Write-Host 'Nothing to restore.' }
    exit 0
}

# ---- 3. read plaintext through the trusted interpreter ----
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dumpScript = Join-Path $scriptDir 'dump_plaintext.py'
$checkScript = Join-Path $scriptDir 'check_syntax.py'
if (-not (Test-Path -LiteralPath $dumpScript)) { throw "missing $dumpScript" }

$Python = Resolve-TrustedPython -Root $rootPath -Explicit $Python
$tmpDir = Join-Path $env:TEMP ('dlp_restore_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
$env:PYTHONIOENCODING = 'utf-8'
$lines = & $Python $dumpScript $tmpDir @encrypted
if ($LASTEXITCODE -ne 0) { throw "dump_plaintext.py failed with exit code $LASTEXITCODE" }

# Preferred source of truth: the UTF-8 manifest the dump script writes. Reading
# python's stdout instead loses non-ASCII paths to the console code page
# (GBK here), which turns a Chinese filename into a path that does not exist.
$records = @()
$manifest = Join-Path $tmpDir 'manifest.jsonl'
if (Test-Path -LiteralPath $manifest) {
    foreach ($line in [IO.File]::ReadAllLines($manifest, [Text.Encoding]::UTF8)) {
        if (-not $line.Trim()) { continue }
        $rec = $line | ConvertFrom-Json
        if ($rec.error) { Write-Warning ("read failed: " + $rec.src); continue }
        $records += $rec
    }
}
else {
    foreach ($line in $lines) {
        if (-not $line) { continue }
        $rec = $line | ConvertFrom-Json
        if ($rec.error) { Write-Warning ("read failed: " + $rec.src); continue }
        $records += $rec
    }
}

# ---- 4. copy back and verify the header ----
# Guard: every record must have its own tmp copy. A shared tmp means one file's
# plaintext would be written over several originals (silent corruption).
$dupTmp = $records | Group-Object -Property tmp | Where-Object { $_.Count -gt 1 }
if ($dupTmp) {
    foreach ($d in $dupTmp) { Write-Host ("  DUPLICATE tmp: " + $d.Name + " <- " + (($d.Group | ForEach-Object { $_.src }) -join ' , ')) }
    throw 'dump_plaintext.py produced colliding temp copies; aborting before any write.'
}

$restored = @()
$writeFailed = @()
foreach ($rec in $records) {
    try {
        Copy-Item -LiteralPath $rec.tmp -Destination $rec.src -Force
    }
    catch {
        Write-Warning ("copy failed: " + $rec.src + " -> " + $_.Exception.Message)
        $writeFailed += $rec.src
        continue
    }
    if (Test-Encrypted -File $rec.src) {
        Write-Warning ("still encrypted, not restored: " + $rec.src)
        $writeFailed += $rec.src
        continue
    }
    if ($rec.sha256) {
        $actual = (Get-FileHash -LiteralPath $rec.src -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $rec.sha256) {
            Write-Warning ("hash mismatch after write (content differs from source plaintext): " + $rec.src)
            $writeFailed += $rec.src
            continue
        }
    }
    $restored += $rec.src
    Write-Host ("  restored {0} ({1} bytes)" -f $rec.src, $rec.bytes)
}

# ---- 5. syntax check ----
$failed = 0
if ($writeFailed.Count -gt 0) { $failed = 1 }
if ($restored.Count -gt 0 -and (Test-Path -LiteralPath $checkScript)) {
    $checkOut = & $Python $checkScript @restored
    $checkOut | ForEach-Object { Write-Host ("  " + $_) }
    if ($LASTEXITCODE -ne 0) { $failed = 1 }
}

Write-Host ("Done: restored {0} of {1} encrypted, {2} write failure(s), {3} check failure(s)" -f $restored.Count, $encrypted.Count, $writeFailed.Count, $failed)
exit $failed
