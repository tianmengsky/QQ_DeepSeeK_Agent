# 打开 QQ 桥接控制台（tools/console.mjs）。
#
# 为什么要它：运维面板挂在桥接插件上，桥接挂了就打不开。控制台是独立的 node 进程，
# 这个脚本负责「没启动就启动、已经在跑就直接开浏览器」，并带一个 -Stop 方便收工。
#
# 用法（通过仓库根的 console.bat 调用）：
#   console.ps1                没在跑就启动，然后打开 http://127.0.0.1:7788/
#   console.ps1 -Port 7799     换端口
#   console.ps1 -NoOpen        只启动，不开浏览器
#   console.ps1 -Stop          停掉正在跑的控制台（只认它自己报出来的 pid）
#
# 注意：这里不加任何 QQ/桥接逻辑，启动接入仍然交给 start-qq-mcp.ps1。
param(
  [int]$Port = 7788,
  [switch]$NoOpen,
  [switch]$Stop
)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$entry = Join-Path $PSScriptRoot 'console.mjs'
$url = "http://127.0.0.1:$Port/"

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text) { Say "  [OK] $text" 'Green' }
function Bad($text) { Say "  [!!] $text" 'Red' }

# 端口上是不是**我们自己的**控制台：只认 /api/status 里带 console.pid 的响应，
# 免得把别的程序当成它，更不会去 kill 别人的进程。
function Get-Console {
  try {
    $state = Invoke-RestMethod -Uri "${url}api/status" -TimeoutSec 2 -ErrorAction Stop
    if ($state.ok -and $state.console.pid) { return $state }
  } catch { }
  return $null
}

$running = Get-Console

if ($Stop) {
  if (-not $running) { Say "  端口 $Port 上没有控制台在跑，无需停止。" 'Yellow'; exit 0 }
  $target = [int]$running.console.pid
  try {
    Stop-Process -Id $target -ErrorAction Stop
    Ok "已停止控制台（PID $target）。DSH、SnowLuma、桥接都没有被动过。"
    exit 0
  } catch {
    Bad "停止失败：$($_.Exception.Message)"
    exit 1
  }
}

if ($running) {
  Ok "控制台已经在跑（PID $($running.console.pid)，端口 $Port）"
} else {
  if (-not (Test-Path -LiteralPath $entry)) { Bad "找不到 $entry"; exit 1 }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Bad '命令行里找不到 node，请先装 Node.js 或把它加进 PATH。'; exit 1 }
  Say "  启动控制台（端口 $Port）…"
  # 用 WMI 建进程，而不是 Start-Process：这样它不挂在当前窗口/父进程下面，
  # 关掉这个窗口、或者父进程被杀，控制台都还在跑（start-qq-mcp.ps1 起 NapCat 同理）。
  #
  # 输出重定向到日志：WMI 起的进程没有可写的控制台句柄，不重定向的话
  # 它第一次 console.log 就可能 EPIPE 崩掉，而崩在哪里没人看得见。
  $log = Join-Path $env:TEMP 'qq-console.log'
  $command = 'cmd.exe /c ""' + $node + '" "' + $entry + '" --port ' + $Port + ' > "' + $log + '" 2>&1"'
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $command
    CurrentDirectory = $root
  }
  if ($created.ReturnValue -ne 0) {
    Bad "启动失败（WMI 返回 $($created.ReturnValue)）。手动跑一次看报错：node `"$entry`" --port $Port"
    exit 1
  }
  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $running = Get-Console
    if ($running) { break }
  }
  if (-not $running) {
    Bad "控制台没能起来。日志（$log）："
    if (Test-Path $log) { Get-Content $log -Tail 20 | ForEach-Object { Say "    $_" 'DarkGray' } }
    exit 1
  }
  Ok "控制台已启动（PID $($running.console.pid)，日志 $log）"
}

if (-not $NoOpen) {
  Start-Process $url | Out-Null
  Ok "已打开 $url"
} else {
  Say "  $url" 'Cyan'
}

$state = Get-Console
if ($state) {
  $dsh = if ($state.dsh.running) { "运行中（端口 $($state.dsh.ports -join '、')）" } else { '没有在跑' }
  $snow = if ($state.snow.online) { "在线（$($state.snow.nickname)）" } else { '未就绪' }
  $bridge = if ($state.bridge.up) { "在线（build $($state.bridge.build)）" } else { '未响应' }
  Say "  DSH：$dsh"
  Say "  接入：$snow"
  Say "  桥接：$bridge"
}
exit 0
