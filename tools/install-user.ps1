# 矩阵庭院 · 一键安装（外发版）
# 用法：双击同目录的「一键安装.bat」即可；也可以右键「使用 PowerShell 运行」。
#   参数（一般不用）：
#     -AppDir "D:\QQAgent\resources\app"   手动指定宿主目录
#     -DryRun                              只看会做什么，不改文件
param(
  [string]$AppDir = "",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"

$PkgVersion = "3.0.0"
$Skills = @("travel-whale", "courtyard-map", "courtyard-doctor", "qzone")
$Plugins = @("autobiography", "bili-whale", "courtyard-bus", "favor-core", "knowledge-base",
             "learning-loop", "life-system", "mind-wish", "silence-ping", "sleep-mood", "think-gate")

function Line { Write-Host ("-" * 60) -ForegroundColor DarkGray }
function Head($t) { Write-Host ""; Line; Write-Host " $t" -ForegroundColor Cyan; Line }
function Ok($t)   { Write-Host "  [完成] $t" -ForegroundColor Green }
function Skip($t) { Write-Host "  [跳过] $t" -ForegroundColor DarkGray }
function Warn2($t){ Write-Host "  [注意] $t" -ForegroundColor Yellow }
function Err2($t) { Write-Host "  [失败] $t" -ForegroundColor Red }

function Resolve-App([string]$given) {
  if ($given -ne "") {
    $g = $given.Trim().Trim('"').TrimEnd('\')
    if (Test-Path (Join-Path $g "resources\app\src\plugin-loader.js")) { return (Join-Path $g "resources\app") }
    if (Test-Path (Join-Path $g "src\plugin-loader.js")) { return $g }
    if (Test-Path (Join-Path $g "resources\app")) { return (Join-Path $g "resources\app") }
    return ""
  }
  $roots = @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}", "D:\", "E:\", "F:\", "C:\")
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    $dirs = @(Get-ChildItem $r -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "QQ\s*Agent|QQAgent" })
    foreach ($d in $dirs) {
      $c1 = Join-Path $d.FullName "resources\app"
      if (Test-Path (Join-Path $c1 "src\plugin-loader.js")) { return $c1 }
      if (Test-Path (Join-Path $d.FullName "src\plugin-loader.js")) { return $d.FullName }
    }
  }
  return ""
}

Head "矩阵庭院 v$PkgVersion · 一键安装"
if ($DryRun) { Warn2 "演练模式：只看会动哪些文件，不会真的改" }

# ── 1. 找宿主 ───────────────────────────────────────────────────────
$App = Resolve-App $AppDir
if ($App -eq "") {
  Warn2 "没自动找到 QQ Agent。"
  Write-Host "  请把 QQ Agent 的安装目录粘进来（例如 D:\QQAgent 或 D:\QQAgent\resources\app）："
  $manual = Read-Host "  路径"
  $App = Resolve-App $manual
}
if ($App -eq "") { Err2 "找不到宿主目录，安装中止。确认 QQ Agent 已安装后再试。"; Read-Host "按回车关闭"; exit 1 }
Ok "宿主目录：$App"

# ── 2. 判断版本形态 ─────────────────────────────────────────────────
$parent = Split-Path -Parent $App
$isPackaged = Test-Path (Join-Path $parent "resources")
if ($isPackaged) {
  Ok "识别为「安装版」（QQ Agent 0.4.8.x 一类）→ 用核心补丁"
  $PatchDir = Join-Path $Here "核心补丁"
} else {
  Ok "识别为「源码版 / 官方 0.4 preview」→ 用官方 0.4 适配"
  $PatchDir = Join-Path $Here "官方0.4适配"
}

# ── 3. 检查是否在运行 ───────────────────────────────────────────────
$running = @(Get-Process -Name "QQ Agent" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Warn2 ("检测到 QQ Agent 正在运行（" + $running.Count + " 个进程）。")
  Write-Host "  建议先退出再安装，否则可能出现新旧文件混用。"
  if (-not $DryRun) {
    $ans = Read-Host "  现在继续安装吗？(y/N)"
    if ($ans -notmatch "^(y|Y)") { Write-Host "已取消。"; Read-Host "按回车关闭"; exit 0 }
  }
}

# ── 4. 备份 + 复制组件 ──────────────────────────────────────────────
$Backup = Join-Path $App ("_backup_" + $Stamp)
Head "复制组件（15 个）"
$copied = 0
foreach ($k in @("skills", "plugins")) {
  $src = Join-Path $Here $k
  if (-not (Test-Path $src)) { continue }
  $dstRoot = Join-Path $App $k
  if (-not (Test-Path $dstRoot)) { New-Item -ItemType Directory -Path $dstRoot -Force | Out-Null }
  $list = @(Get-ChildItem $src -Directory)
  foreach ($d in $list) {
    $dst = Join-Path $dstRoot $d.Name
    if (Test-Path $dst) {
      if ($DryRun) { Skip ("会备份并覆盖：" + $k + "\" + $d.Name) }
      else {
        $bk = Join-Path $Backup ($k + "\" + $d.Name)
        New-Item -ItemType Directory -Path (Split-Path -Parent $bk) -Force | Out-Null
        Copy-Item $dst $bk -Recurse -Force
      }
    }
    if ($DryRun) { Skip ("会复制：" + $k + "\" + $d.Name) }
    else {
      if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
      Copy-Item $d.FullName $dst -Recurse -Force
      Ok ($k + "\" + $d.Name)
    }
    $copied = $copied + 1
  }
}
Ok ("共处理 " + $copied + " 个组件")

# ── 5. 旧版 qqzone 处理（v3.0.0 变更）────────────────────────────────
$oldQq = Join-Path $App "skills\qqzone"
if (Test-Path $oldQq) {
  if ($DryRun) { Skip "会把旧技能 skills\qqzone 移进备份（v3 已并入 qzone）" }
  else {
    $bk = Join-Path $Backup "skills\qqzone"
    New-Item -ItemType Directory -Path (Split-Path -Parent $bk) -Force | Out-Null
    Move-Item $oldQq $bk -Force
    Warn2 "旧技能 skills\qqzone 已并入 qzone，原目录已移进备份（不删）"
  }
}

# ── 6. 打补丁 ───────────────────────────────────────────────────────
Head "打补丁（自动选对应的一套）"
$apply = Join-Path $PatchDir "apply-core-patch.ps1"
if (-not (Test-Path $apply)) {
  Warn2 "没找到补丁脚本（" + $apply + "），跳过。组件仍可用，但少部分修复不会生效。"
} elseif ($DryRun) {
  & powershell -ExecutionPolicy Bypass -NoProfile -File $apply -AppDir $App -DryRun
} else {
  & powershell -ExecutionPolicy Bypass -NoProfile -File $apply -AppDir $App -Yes
}

# ── 7. 收尾 ─────────────────────────────────────────────────────────
Head "安装完成"
Write-Host "  下一步（必须做）：" -ForegroundColor Yellow
Write-Host "    1) 重新启动 QQ Agent"
Write-Host "    2) 设置 → 技能 → 矩阵庭院，填 homeChatKey（哪个群是家）和 cardTargets（明信片寄给谁）"
Write-Host "    3) 设置 → 技能 → 庭院与旅程 →「打开庭院与旅程」，能开出 5 个页签就装好了"
Write-Host ""
Write-Host "  角色图不随包附带（版权原因），要更统一可放自己的图到：" -ForegroundColor DarkGray
Write-Host ("    " + (Join-Path (Split-Path -Parent $App) "data\skills\travel-whale\refs")) -ForegroundColor DarkGray
if (Test-Path $Backup) { Write-Host ("  本次备份：" + $Backup) -ForegroundColor DarkGray }
Write-Host ""
Read-Host "按回车关闭"
