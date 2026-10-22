# QQ / SnowLuma 启动与托管控制。旧接入端分支仅保留兼容回退，不是当前方案。MCP stdio 进程由 DSH 管理。
# start / restart 均复用在线账号；restart 仅重置桥接托管，不结束 QQ。
param(
  [ValidateSet('start', 'status', 'stop', 'restart')]
  [string]$Mode = 'start',
  [ValidatePattern('^$|^[1-9][0-9]{4,19}$')]
  [string]$Uin = '3667925015',
  [string]$NapCatDir = 'D:\NapCat',
  [ValidateSet('SnowLuma', 'NapCat')]
  [string]$Backend = 'SnowLuma',
  [string]$SnowLumaDir = (Join-Path $PSScriptRoot '..\..\SnowLuma-validation\runtime'),
  [string]$QQPath = 'C:\Program Files\Tencent\QQNT\QQ.exe',
  # 桥接地址**留空 = 自动发现**。桥接挂在 DSH 自己的 HTTP 服务上，DSH 端口每次启动
  # 都可能变（实测 19387 → 5250），写死一个值会变成"桥接未响应，保留当前 QQ 状态"。
  [string]$Bridge = '',
  [string]$OneBot = 'http://127.0.0.1:16000',
  [string]$Token = '',
  [string]$BridgeToken = ''
)
$ErrorActionPreference = 'Stop'
$SnowLumaDir = [System.IO.Path]::GetFullPath($SnowLumaDir)

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text) { Say "  [OK] $text" 'Green' }
function Bad($text) { Say "  [!!] $text" 'Red' }
function Info($text) { Say "  $text" }

function Test-Port([int]$Port) {
  # Get-NetTCPConnection uses CIM/WMI and can hang before the first message.
  return [bool](@([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $Port }).Count)
}

function Resolve-LoginAccount {
  if ($Uin) { return $Uin }
  $file = Join-Path $NapCatDir 'config\webui.json'
  if (Test-Path -LiteralPath $file) {
    $config = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    $account = [string]$config.autoLoginAccount
    if ($account -match '^[1-9][0-9]{4,19}$') { return $account }
  }
  throw '未指定登录账号。请设置 Uin 或接入端的账号配置；不会默认重启到扫码登录。'
}

function Get-OneBotHeaders {
  $resolvedToken = $Token
  if (-not $resolvedToken) {
    if ($Backend -eq 'SnowLuma') {
      $file = Join-Path $SnowLumaDir "config\onebot_$Uin.json"
      if (Test-Path -LiteralPath $file) {
        $config = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        $server = @($config.networks.httpServers) | Where-Object {
          $_.enabled -ne $false -and [int]$_.port -eq ([uri]$OneBot).Port
        } | Select-Object -First 1
        if ($server) { $resolvedToken = [string]$server.accessToken }
      }
    } else {
    # 已登录时使用账号配置；首次启动允许回退公共配置。
    $files = @("config\onebot11_$Uin.json", 'config\onebot11.json')
    foreach ($relative in $files) {
      $file = Join-Path $NapCatDir $relative
      if (-not (Test-Path -LiteralPath $file)) { continue }
      $config = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
      $server = @($config.network.httpServers) | Where-Object {
        $_.enable -ne $false -and [int]$_.port -eq ([uri]$OneBot).Port
      } | Select-Object -First 1
      if ($server) { $resolvedToken = [string]$server.token; break }
    }
    }
  }
  $headers = @{}
  if ($resolvedToken) { $headers.Authorization = "Bearer $resolvedToken" }
  return $headers
}

function Get-OneBotState {
  try {
    $headers = Get-OneBotHeaders
    $login = Invoke-RestMethod -Uri "$OneBot/get_login_info" -Method Post -Headers $headers `
      -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -ErrorAction Stop
    $status = Invoke-RestMethod -Uri "$OneBot/get_status" -Method Post -Headers $headers `
      -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -ErrorAction Stop
    if ($login.status -ne 'ok' -or ($null -ne $login.retcode -and $login.retcode -ne 0) -or
        $status.status -ne 'ok' -or ($null -ne $status.retcode -and $status.retcode -ne 0)) {
      throw 'OneBot 未返回成功状态，请检查账号状态与接口配置。'
    }
    if (-not $login.data.user_id -or $status.data.online -ne $true) {
      throw 'QQ 尚未在线或登录已失效。请检查当前 QQ 登录状态。'
    }
    if ($Uin -and [string]$login.data.user_id -ne $Uin) {
      throw "OneBot 当前登录账号 $($login.data.user_id) 与目标 $Uin 不同；不会强制切换账号。"
    }
    if ($status.data.good -eq $false) { throw 'QQ 在线，但 OneBot 收发尚未健康，请查看接入端日志。' }
    return @{ online = $true; account = $login.data; error = '' }
  } catch {
    return @{ online = $false; account = $null; error = $_.Exception.Message }
  }
}

function Get-BridgeStatus {
  try {
    $headers = @{}
    if ($BridgeToken) { $headers.Authorization = "Bearer $BridgeToken" }
    return Invoke-RestMethod -Uri $Bridge -Headers $headers -TimeoutSec 5 -ErrorAction Stop
  }
  catch { return $null }
}

# 桥接探测：返回带 ok / agentEnabled 的 JSON 才算真的接上了。
# 只要求"端口能连"不够 —— 其它服务也会回 200。
function Test-BridgeUrl([string]$url) {
  try {
    $headers = @{}
    if ($BridgeToken) { $headers.Authorization = "Bearer $BridgeToken" }
    $res = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 2 -ErrorAction Stop
    if ($res -and ($null -ne $res.ok -or $null -ne $res.agentEnabled)) { return $res }
  } catch { }
  return $null
}

# 自动发现桥接地址。
#
# 桥接不是独立端口，而是挂在 DSH 的 HTTP 服务上（path: /qq/onebot），
# 所以 DSH 换端口它就跟着换。这里按「显式参数 → 环境变量 → 常见端口 → 全部本机监听端口」
# 的顺序探测，找到第一个真的回桥接 JSON 的地址。
function Resolve-BridgeUrl {
  if ($Bridge) {
    if (Test-BridgeUrl $Bridge) { return $Bridge }
    Bad "指定的桥接地址无响应：$Bridge（继续自动发现）"
  }
  $candidates = @()
  if ($env:QQ_BRIDGE) { $candidates += $env:QQ_BRIDGE }
  $candidates += 'http://127.0.0.1:19387/qq/onebot', 'http://127.0.0.1:5250/qq/onebot'
  $ports = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -ge 1024 } |
    Select-Object -ExpandProperty Port -Unique | Sort-Object)
  foreach ($port in $ports) { $candidates += "http://127.0.0.1:$port/qq/onebot" }
  foreach ($url in ($candidates | Select-Object -Unique)) {
    if (Test-BridgeUrl $url) { return $url }
  }
  return ''
}

# 把 SnowLuma 的 OneBot 上报地址同步成当前桥接地址。
#
# SnowLuma 的 httpClients 是写死在配置文件里的，没法自己发现 DSH 端口；
# 不同步的后果是「QQ 消息收不到」——桥接在线、QQ 在线，但事件发去了旧端口。
# 只改 url 那一行，保留文件其余内容；写回必须是**无 BOM** 的 UTF-8。
function Sync-SnowLumaBridgeUrl([string]$url) {
  $file = Join-Path $SnowLumaDir "config\onebot_$Uin.json"
  if (-not (Test-Path -LiteralPath $file)) { return }
  $raw = Get-Content -LiteralPath $file -Raw -Encoding UTF8
  $updated = [regex]::Replace($raw, '"url"\s*:\s*"[^"]*?/qq/onebot"', '"url": "' + $url + '"')
  if ($updated -ne $raw) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($file, $updated, $utf8NoBom)
    Info "已把 SnowLuma 上报地址同步为 $url"
  }
}

function Set-Hosting([bool]$Enabled) {
  try {
    $headers = @{}
    if ($BridgeToken) { $headers.Authorization = "Bearer $BridgeToken" }
    $result = Invoke-RestMethod -Uri "$Bridge/control" -Method Post -Headers $headers `
      -Body (@{ enabled = $Enabled } | ConvertTo-Json -Compress) -ContentType 'application/json' `
      -TimeoutSec 10 -ErrorAction Stop
    if ($result.agentEnabled -ne $Enabled) { throw '桥接没有确认目标托管状态。' }
    return $true
  } catch { Bad $_.Exception.Message; return $false }
}

function Show-Status {
  $login = Get-OneBotState
  if ($login.online) { Ok "QQ 在线：$($login.account.nickname) ($($login.account.user_id))" }
  else { Bad "QQ 在线状态未确认：$($login.error)" }
  $bridgeStatus = Get-BridgeStatus
  if ($bridgeStatus) { Info "桥接 build=$($bridgeStatus.build)，托管=$($bridgeStatus.agentEnabled)" }
  else { Bad '桥接未响应' }
}

function Wait-OneBot {
  Info "等待 $Backend 接入机器人账号（最多 120 秒，不重复拉起）；需要时请在普通 QQ 登录 $Uin..."
  $reportedIdentityFailure = $false
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-Port ([uri]$OneBot).Port) {
      $state = Get-OneBotState
      if ($state.online) { return $true }
      $lastError = $state.error
    }
    if ($Backend -eq 'SnowLuma' -and -not $reportedIdentityFailure) {
      $stateFile = Join-Path $SnowLumaDir 'data\dsh-launcher-state.json'
      if (Test-Path -LiteralPath $stateFile) {
        try {
          $launcherState = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($launcherState.account -eq $Uin -and $launcherState.state -eq 'identity-unavailable' -and
              [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$launcherState.at -lt 30000) {
            Bad 'QQ 进程已存在，但账号探测失败；这不等于 QQ 未登录。请在 SnowLuma 进程注入页确认机器人 PID 后加载。'
            $reportedIdentityFailure = $true
          }
        } catch { }
      }
    }
    Start-Sleep -Seconds 3
  }
  if ($lastError) { Bad $lastError }
  Bad '账号接入尚未完成。请检查 QQ 登录及接入端日志，完成后再次双击启动。'
  return $false
}

function Start-SnowLumaService {
  $entry = Join-Path $SnowLumaDir 'index.mjs'
  if (-not (Test-Path -LiteralPath $entry)) { throw "找不到 SnowLuma：$entry" }
  $node = (Get-Command node -ErrorAction Stop).Source
  $helper = Join-Path $PSScriptRoot 'start-snowluma.mjs'
  $logRoot = Split-Path $SnowLumaDir -Parent
  # 保留上一次记录；重新启动不覆盖历史，也不触碰凭据或用户配置。
  foreach ($name in @('startup.stdout.log', 'startup.stderr.log')) {
    $file = Join-Path $logRoot $name
    if (Test-Path -LiteralPath $file) {
      Move-Item -LiteralPath $file -Destination ($file + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.bak')
    }
  }
  # detached Node child has its own process group; closing the viewer does not
  # send its console signal to SnowLuma. Logs stay in files across DSH reloads.
  & $node $helper $SnowLumaDir $Uin --detach | ForEach-Object { Info $_ }
  if ($LASTEXITCODE -ne 0) { throw 'SnowLuma 后台启动失败，请查看日志。' }
  Ok 'SnowLuma 已启动，自动接入已识别的机器人账号；个人 QQ 不注入'
}

function Get-SnowLumaProcesses {
  return @(Get-BridgeProcesses -Names @('node') | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and
      $_.CommandLine.Contains((Join-Path $PSScriptRoot 'start-snowluma.mjs')) -and
      $_.CommandLine.Contains($SnowLumaDir)
  })
}

# 配置文件比 SnowLuma 进程新，说明运行中的 hook 还没加载当前配置。
# 不能只看文件里的 url：上一次失败的启动可能已经把文件改新了，进程仍是旧的。
function Test-SnowLumaNeedsReload {
  $processes = @(Get-SnowLumaProcesses)
  if ($processes.Count -eq 0) { return $false }
  $file = Join-Path $SnowLumaDir "config\onebot_$Uin.json"
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  $written = (Get-Item -LiteralPath $file).LastWriteTimeUtc
  foreach ($process in $processes) {
    try {
      if ((Get-Process -Id $process.ProcessId).StartTime.ToUniversalTime() -lt $written) { return $true }
    } catch { }
  }
  return $false
}

# 只重启 SnowLuma 的 Node hook，不结束 QQ。hook 会重新接上同一个 QQ 进程。
function Restart-SnowLumaService {
  $processes = @(Get-SnowLumaProcesses)
  if ($processes.Count -eq 0) { return $true }
  Info 'SnowLuma 进程早于配置文件，重启 hook 以加载新上报地址（QQ 进程保持运行）...'
  foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Test-Port ([uri]$OneBot).Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-Port ([uri]$OneBot).Port) {
    Bad 'SnowLuma 已停止，但 OneBot 端口仍被占用，未继续启动。'
    return $false
  }
  Start-SnowLumaService
  if (-not (Wait-OneBot)) { return $false }
  Ok 'SnowLuma 已重启'
  return $true
}

function Ensure-SnowLuma {
  Info '检查 OneBot 接口及 SnowLuma 进程...'
  if (Test-Port ([uri]$OneBot).Port) {
    $state = Get-OneBotState
    if ($state.online) {
      # DSH 换端口后，启动器只改文件；这里把运行中的旧 hook 换成新地址。
      if (Test-SnowLumaNeedsReload) {
        if (-not (Restart-SnowLumaService)) { return $false }
      }
      Ok "复用在线账号 $($state.account.user_id)"
      return $true
    }
    Bad $state.error
    return $false
  }
  $existing = @(Get-BridgeProcesses -Names @('node') | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and (
      $_.CommandLine.Contains((Join-Path $PSScriptRoot 'start-snowluma.mjs')) -or
      $_.CommandLine.Contains((Join-Path $SnowLumaDir 'index.mjs'))
    )
  })
  if ($existing.Count -eq 0) {
    $runtimeFile = Join-Path $SnowLumaDir 'config\runtime.json'
    $webPort = 5099
    if (Test-Path -LiteralPath $runtimeFile) {
      $runtimeConfig = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($runtimeConfig.webuiPort) { $webPort = [int]$runtimeConfig.webuiPort }
    }
    if (Test-Port $webPort) { Bad "管理端口 $webPort 已被现有服务占用，请在进程注入页接入机器人账号。"; return $false }
    Start-SnowLumaService
  } else { Info 'SnowLuma 进程已存在，等待接口接入，不重复启动。' }
  $qq = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)
  if ($qq.Count -eq 0) {
    if (-not (Test-Path -LiteralPath $QQPath)) { Bad "找不到普通 QQ：$QQPath"; return $false }
    Start-Process -FilePath $QQPath -WindowStyle Hidden | Out-Null
    Info "普通 QQ 已启动，请登录机器人账号 $Uin；当前接入端使用普通 QQ 登录，不走快速登录参数。"
  }
  return Wait-OneBot
}

function Ensure-Transport {
  if ($Backend -eq 'SnowLuma') { return Ensure-SnowLuma }
  return Ensure-NapCat
}

function Ensure-NapCat {
  if (Test-Port ([uri]$OneBot).Port) {
    $state = Get-OneBotState
    if ($state.online) { Ok "复用在线账号 $($state.account.user_id)，无需重新登录"; return $true }
    Bad $state.error
    return $false
  }
  $existing = @(Get-Process -Name 'NapCatWinBootMain', 'NapCatWinBootHook' -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) { return Wait-OneBot }
  $qq = @(Get-Process -Name 'QQ', 'QQEX' -ErrorAction SilentlyContinue)
  if ($qq.Count -gt 0) {
    Bad 'QQ 已运行，但 OneBot 未就绪。不会强制结束已登录客户端；请确认旧接入端状态。裸 QQ 需手动正常退出后再启动。'
    return $false
  }
  $bat = Join-Path $NapCatDir 'run-napcat.bat'
  if (-not (Test-Path -LiteralPath $bat)) { Bad "找不到 $bat"; return $false }
  if ($Uin -notmatch '^[1-9][0-9]{4,19}$') { Bad '没有有效的快速登录账号'; return $false }
  # 父进程脱离 DSH；MCP/DSH 重新加载不结束旧接入端。账号参数复用 QQ 本机凭据。
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = 'cmd.exe /c ""' + $bat + '" ' + $Uin + '"'
    CurrentDirectory = $NapCatDir
  }
  if ($result.ReturnValue -ne 0) { Bad "旧接入端启动失败：$($result.ReturnValue)"; return $false }
  return Wait-OneBot
}

function Start-All {
  Info '检查 DSH 桥接...'
  if (-not $Bridge) { Bad 'DSH 桥接未响应，保留当前 QQ 状态。'; return $false }
  # 发现之后还要真的验一次：桥接可能在发现与启动之间退出。
  if (-not (Get-BridgeStatus)) { Bad 'DSH 桥接未响应，保留当前 QQ 状态。'; return $false }
  Info "桥接：$Bridge"
  # 先把 SnowLuma 的上报地址对上，再起服务；否则起来了也收不到群消息。
  Sync-SnowLumaBridgeUrl $Bridge
  if (-not (Ensure-Transport)) { return $false }
  if (-not (Set-Hosting $true)) { return $false }
  Ok '托管已开启，QQ 登录进程保持独立运行'
  Show-Status
  return $true
}

$launchLock = $null
$ownsLock = $false
. (Join-Path $PSScriptRoot 'windows-processes.ps1')
try {
  Info "启动控制：$Mode / $Backend"
  if ($Mode -in @('start', 'restart')) {
    $launchLock = New-Object System.Threading.Mutex($false, 'Local\DshQqBridgeNapCatStart')
    try { $ownsLock = $launchLock.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
    if (-not $ownsLock) { throw '已有启动操作正在执行，请等待它完成；不会重复启动 QQ。' }
  }
  $Uin = Resolve-LoginAccount
  # DSH 的端口每次启动可能不同（桥接跟着它走），所以先发现再动手；
  # 找不到就明确说出来，不要拿旧端口去猜。
  $resolvedBridge = Resolve-BridgeUrl
  if ($resolvedBridge) {
    $script:Bridge = $resolvedBridge
    Info "桥接：$Bridge"
  } else {
    Bad '未找到 DSH 桥接（DSH 没启动时正常）：没有可用的 /qq/onebot'
  }
  $success = $true
  switch ($Mode) {
    'status' { Show-Status }
    'stop' { $success = Set-Hosting $false }
    'restart' {
      # 先确认桥接和账号都在，再重置托管；服务故障不破坏已有 QQ 会话。
      if (-not $Bridge -or -not (Get-BridgeStatus)) {
        Bad 'DSH 桥接未响应，不做任何改动。'; $success = $false; break
      }
      Sync-SnowLumaBridgeUrl $Bridge
      if (-not (Ensure-Transport)) { $success = $false; break }
      if (-not (Set-Hosting $false)) { $success = $false; break }
      $success = Set-Hosting $true
      if ($success) { Ok '桥接托管已重置；QQ 保持在线。MCP 进程由 DSH 管理。' }
    }
    'start' { $success = Start-All }
  }
  if (-not $success) { exit 1 }
} catch { Bad $_.Exception.Message; exit 1 }
finally {
  if ($ownsLock) { $launchLock.ReleaseMutex() }
  if ($launchLock) { $launchLock.Dispose() }
}
