# 启动 DSH（DeepSeek Harness），并等它把桥接插件挂出来。
#
# 为什么要单独一个脚本：DSH 是个 Electron 应用，端口每次启动都可能变，
# 而"桥接在不在"要等插件加载完才知道。控制台只负责顺序，探测和等待都在这里。
#
# 用法（通常由 tools/console.mjs 调用；也可以自己跑）：
#   start-dsh.ps1                      自动找 DSH 可执行文件并启动，等 /qq/onebot 就绪
#   start-dsh.ps1 -Exe "E:\...\DeepSeek Harness.exe"
#   start-dsh.ps1 -TimeoutSec 300      多等一会儿（插件多、机器慢时需要）
#   start-dsh.ps1 -NoWait              只启动，不等桥接
#
# 输出是给控制台日志用的，一行一条，尽量短。
param(
  [string]$Exe = '',
  [int]$TimeoutSec = 180,
  [switch]$NoWait
)

$ErrorActionPreference = 'Continue'

function Say($text) { Write-Host $text }

function Get-DshNamePattern {
  return 'DeepSeek*Harness*'
}

function Get-DshProcesses {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like (Get-DshNamePattern) })
}

# DSH 的 HTTP 端口：在这些 PID 名下 LISTEN 的端口。
# 找不到归属时退回"全部监听端口"，宁可多试几个也不要漏。
function Get-DshPorts {
  $ids = @(Get-DshProcesses | Select-Object -ExpandProperty Id)
  if (-not $ids.Count) { return @() }
  $list = @()
  foreach ($conn in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    if ($ids -contains $conn.OwningProcess) { $list += $conn.LocalPort }
  }
  return @($list | Select-Object -Unique | Sort-Object)
}

function Test-BridgePort([int]$port) {
  try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:$port/qq/onebot" -TimeoutSec 2 -ErrorAction Stop
    return [bool]($null -ne $res.ok -or $null -ne $res.agentEnabled)
  } catch {
    $answer = $_.Exception.Response
    if ($answer -and [int]$answer.StatusCode -eq 401) { return $true }
    return $false
  }
}

function Find-BridgePort {
  foreach ($port in (Get-DshPorts)) {
    if (Test-BridgePort $port) { return $port }
  }
  return 0
}

# 可执行文件解析顺序：参数 → 环境变量 → 正在跑的进程 → 常见安装位置。
# 最后一步只是猜，所以会把猜过的路径都打出来，猜错了用户知道该设哪个变量。
function Resolve-DshExe {
  if ($Exe -and (Test-Path -LiteralPath $Exe)) { return $Exe }
  if ($env:QQ_DSH_EXE -and (Test-Path -LiteralPath $env:QQ_DSH_EXE)) { return $env:QQ_DSH_EXE }
  $running = Get-DshProcesses | Where-Object { $_.Path } | Select-Object -First 1
  if ($running) { return $running.Path }
  $candidates = @(
    'E:\DeepseekHARNESS\DeepSeek Harness.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\DeepSeek Harness.exe'),
    'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe',
    'D:\DeepseekHARNESS\DeepSeek Harness.exe'
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return ''
}

Say '检查 DSH 进程…'
$ports = Get-DshPorts
if ($ports.Count) {
  $bridge = Find-BridgePort
  if ($bridge) {
    Say "DSH 已在运行，桥接端口 $bridge"
  } else {
    Say "DSH 已在运行（端口 $($ports -join '、')），但 /qq/onebot 没响应 —— 插件可能没加载"
  }
  exit 0
}

$target = Resolve-DshExe
if (-not $target) {
  Say '找不到 DSH 可执行文件。请设置环境变量 QQ_DSH_EXE 指向 "DeepSeek Harness.exe"。'
  exit 1
}
Say "启动：$target"
# 启动前修剪堆积的认证 cookie（2026-10-31 事故的根因）。
#
# DSH 每次启动都往 Chromium 的 cookie 库里写一个 dsh-auth-<随机>；cookie 按域名存、
# 而启动端口每次都变，旧的那些从来不删。堆到几十个之后，它自己就认领不了自己的 Host，
# 表现为 "desktop welcome: Web authentication failed" —— 而且换 profile、关第三方插件
# 全都没用，因为问题发生在插件之前。脚本走到这里就已经确认 DSH 没在跑，
# 正好是动那个库的安全时机（Chromium 跑着的时候独占它）。
$guard = Join-Path $PSScriptRoot 'dsh-guard.mjs'
if (Test-Path -LiteralPath $guard) {
  $nodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($nodeBin) {
    $pruneOutput = & $nodeBin $guard prune 2>$null
    foreach ($line in @($pruneOutput)) { if ("$line".Trim()) { Say "  $line" } }
  }
}
# 用 WMI 建进程，而不是 Start-Process。
#
# 两个理由，第二个是本机实测踩到的：
#   1. 脱离父进程的作业对象 —— 从批处理、从别的程序（比如控制台）里启动时，
#      父进程一退出，Start-Process 拉起来的子进程会被 Windows 一起收走；
#   2. 从**非交互式** shell 里调用时（远程 shell、自动化里跑），Start-Process
#      起的 GUI 程序会被立刻掐死（ExitCode 0、不留任何日志）。WMI 建的进程挂到
#      WmiPrvSE 下面，不受那层作业管制，能正常进入用户桌面。
# 同一条结论在 console.ps1（起 node）和 start-qq-mcp.ps1（起 NapCat）里各写过一次。
$created = $null
try {
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = '"' + $target + '"'
    CurrentDirectory = (Split-Path -Path $target -Parent)
  }
} catch {
  Say "WMI 启动失败：$($_.Exception.Message)（改用 Start-Process）"
}
if ($null -eq $created -or $created.ReturnValue -ne 0) {
  if ($null -ne $created) { Say "WMI 返回 $($created.ReturnValue)，改用 Start-Process" }
  try {
    Start-Process -FilePath $target | Out-Null
  } catch {
    Say "启动失败：$($_.Exception.Message)"
    exit 1
  }
}

if ($NoWait) { Say '已启动（未等桥接）'; exit 0 }

Say "等待 DSH 拉起 Web 服务（最多 $TimeoutSec 秒）…"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$reportedPort = 0
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $list = Get-DshPorts
  if (-not $list.Count) { continue }
  if ($reportedPort -ne $list[0]) {
    $reportedPort = $list[0]
    Say "DSH 端口：$($list -join '、')"
  }
  $bridge = Find-BridgePort
  if ($bridge) {
    Say "桥接就绪：http://127.0.0.1:$bridge/qq/onebot"
    exit 0
  }
}
Say 'DSH 起来了，但等不到桥接 —— 去 DSH 里确认 qq-bridge 插件是否加载（/status 应有 build）'
exit 1
