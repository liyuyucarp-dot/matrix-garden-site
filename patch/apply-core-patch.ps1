# 核心补丁 · 手术式应用（读 manifest.json 逐项执行；先备份，可回滚，可重复运行）
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\apply-core-patch.ps1            # 演练（只看会动什么）
#   powershell -ExecutionPolicy Bypass -File .\apply-core-patch.ps1 -AppDir "D:\QQAgent\resources\app" -Yes
# ⚠️ PowerShell 变量名大小写不敏感：根变量是 $AppRoot，循环内一律用 $dstFile，
#    绝不用 $target/$Target —— 2026-10-24 实测循环内赋值会把根路径覆盖成嵌套路径。
param(
  [string]$AppDir = "",
  [switch]$Yes,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
# ★ 2026-10-25（v2.2.3）：备份放到**被修改的那棵宿主树**里，而不是脚本所在目录。
#   旧写法 `Join-Path $Here "_backup_..."` 有两个后果：
#     ① 在包里跑一次，包目录就被塞进一堆备份文件（实测把 151 条目的包撑到 172 条）；
#     ② 脚本目录只读时备份会失败，于是一个本该"可回滚"的操作变成不可回滚。
#   ⚠️ 赋值必须在下面 Resolve-AppDir 之后（$AppRoot 那时才有值）。

function Write-Ok($t)   { Write-Host ("  [OK]   " + $t) -ForegroundColor Green }
function Write-Skip($t) { Write-Host ("  [SKIP] " + $t) -ForegroundColor DarkGray }
function Write-Warn2($t){ Write-Host ("  [!!]   " + $t) -ForegroundColor Yellow }
function Write-Err2($t) { Write-Host ("  [ERR]  " + $t) -ForegroundColor Red }

function Resolve-AppDir {
  if ($AppDir -ne "") { if (Test-Path (Join-Path $AppDir "src")) { return (Resolve-Path $AppDir).Path } }
  $candidates = @()
  foreach ($root in @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "D:\", "E:\", "F:\")) {
    if (-not (Test-Path $root)) { continue }
    try {
      Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "QQ\s*Agent|QQAgent" } |
        ForEach-Object { $p = Join-Path $_.FullName "resources\app"; if (Test-Path (Join-Path $p "src")) { $candidates += $p } }
    } catch { }
  }
  $candidates = $candidates | Select-Object -Unique
  if ($candidates.Count -ge 1) { Write-Ok ("找到：" + $candidates[0]); return $candidates[0] }
  Write-Warn2 "没自动找到。请输入 QQ Agent 的 resources\app 目录："
  $manual = Read-Host "  路径"
  if ($manual -ne "" -and (Test-Path (Join-Path $manual.Trim('"') "src"))) { return $manual.Trim('"') }
  return ""
}

$AppRoot = Resolve-AppDir
if ($AppRoot -eq "") { Write-Err2 "没有可用的目标目录，退出。"; exit 1 }
Write-Host ("  目标：" + $AppRoot) -ForegroundColor White
# 备份目录跟着目标走（见文件头 v2.2.3 说明）：放在宿主 resources\app 下，和这次改动的范围同生共死。
$BackupDir = Join-Path $AppRoot ("_core_patch_backup_" + $Stamp)

$manifest = Get-Content (Join-Path $Here "manifest.json") -Encoding UTF8 -Raw | ConvertFrom-Json
Write-Host ""
Write-Host ("== " + $manifest.name + "（" + $manifest.version + "）==") -ForegroundColor Cyan

function Backup-Item($path) {
  if (-not (Test-Path $path)) { return }
  $rel = $path.Substring($AppRoot.Length).TrimStart("\")
  $dst = Join-Path $BackupDir $rel
  $parent = Split-Path -Parent $dst
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  if ($DryRun) { Write-Skip ("会备份：" + $rel); return }
  Copy-Item $path $dst -Recurse -Force
}

$done = 0; $skipped = 0; $failed = 0
foreach ($e in $manifest.entries) {
  $dstFile = Join-Path $AppRoot ($e.path -replace '/', '\')
  $kind = $e.kind
  try {
    if ($kind -eq 'copy-new') {
      if (Test-Path $dstFile) { Write-Skip ("已存在（幂等跳过）：" + $e.path); $skipped++; continue }
      $srcFile = Join-Path $Here ("files\" + ($e.path -replace '/', '\'))
      if ($DryRun) { Write-Skip ("会新增：" + $e.path); continue }
      New-Item -ItemType Directory -Path (Split-Path -Parent $dstFile) -Force | Out-Null
      Copy-Item $srcFile $dstFile -Force
      Write-Ok ("新增 " + $e.path); $done++
    }
    elseif ($kind -eq 'copy') {
      $srcFile = Join-Path $Here ("files\" + ($e.path -replace '/', '\'))
      if (-not (Test-Path $srcFile)) { Write-Err2 ("补丁包缺文件：" + $e.path); $failed++; continue }
      New-Item -ItemType Directory -Path (Split-Path -Parent $dstFile) -Force | Out-Null
      Backup-Item $dstFile
      if ($DryRun) { Write-Skip ("会覆盖：" + $e.path); continue }
      Copy-Item $srcFile $dstFile -Force
      Write-Ok ("覆盖 " + $e.path); $done++
    }
    elseif ($kind -eq 'anchor-insert') {
      if (-not (Test-Path $dstFile)) { Write-Err2 ("目标文件不存在：" + $e.path); $failed++; continue }
      $content = Get-Content $dstFile -Encoding UTF8 -Raw
      if ($content.Contains($e.marker)) { Write-Skip ("已打过（幂等跳过）：" + $e.path); $skipped++; continue }
      $anchor = $e.anchor
      $lines = $content -split "`r?`n"
      $idx = -1
      for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Contains($anchor)) { $idx = $i; break } }
      if ($idx -lt 0) {
        Write-Err2 ("锚点未找到：" + $e.path + "（宿主版本可能不同）—— 请按《手动接线片段.md》手动接线")
        $failed++; continue
      }
      $snippet = Get-Content (Join-Path $Here $e.insertFile) -Encoding UTF8 -Raw
      if ($DryRun) { Write-Skip ("会插入 " + $e.insertFile + " @行" + ($idx + 1)); continue }
      Backup-Item $dstFile
      if ($e.insertAfterAnchor) {
        $out = $lines[0..$idx] + ($snippet -split "`r?`n") + $lines[($idx + 1)..($lines.Count - 1)]
      } else {
        $out = $lines[0..($idx - 1)] + ($snippet -split "`r?`n") + $lines[$idx..($lines.Count - 1)]
      }
      Set-Content $dstFile ($out -join "`r`n") -Encoding UTF8
      Write-Ok ("插入 " + $e.insertFile + " → " + $e.path); $done++
    }
    elseif ($kind -eq 'replace-line') {
      # 2026-10-25（v2.2.3）新增：整行替换。
      # 用途：有些改动是"改一行既有代码"，插入做不到（典型：plugin-loader 的 lint 判据）。
      # 幂等：文件里已含 marker 就跳过。
      # 安全：**必须命中且只命中一处** —— 命中 0 处说明宿主版本不同（报错让人手动改）；
      #       命中多处说明匹配太宽（宁可不动，也不猜要改哪一行）。
      if (-not (Test-Path $dstFile)) { Write-Err2 ("目标文件不存在：" + $e.path); $failed++; continue }
      $content = Get-Content $dstFile -Encoding UTF8 -Raw
      if ($content.Contains($e.marker)) { Write-Skip ("已打过（幂等跳过）：" + $e.path); $skipped++; continue }
      $lines = $content -split "`r?`n"
      $hits = @()
      for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Contains($e.from)) { $hits += $i } }
      if ($hits.Count -eq 0) {
        Write-Err2 ("待替换行未找到：" + $e.path + "（宿主版本可能不同）—— 请按《手动接线片段.md》手动改")
        $failed++; continue
      }
      if ($hits.Count -gt 1) {
        Write-Err2 ("待替换行命中 " + $hits.Count + " 处（应唯一）：" + $e.path + " —— 为避免误改已跳过，请手动处理")
        $failed++; continue
      }
      $i = $hits[0]
      if ($DryRun) { Write-Skip ("会替换第 " + ($i + 1) + " 行 → " + $e.path); continue }
      Backup-Item $dstFile
      $lines[$i] = $e.to
      Set-Content $dstFile ($lines -join "`r`n") -Encoding UTF8
      Write-Ok ("替换第 " + ($i + 1) + " 行 → " + $e.path); $done++
    }
  } catch {
    Write-Err2 ($e.path + " 失败：" + $_.Exception.Message); $failed++
  }
}

Write-Host ""
Write-Host ("  完成 " + $done + " · 跳过 " + $skipped + " · 失败 " + $failed) -ForegroundColor White
if (Test-Path $BackupDir) { Write-Host ("  备份在：" + $BackupDir) -ForegroundColor DarkGray }
Write-Warn2 "核心补丁需要【完整重启】QQ Agent 才生效。"
