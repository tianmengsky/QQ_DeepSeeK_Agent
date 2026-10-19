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
  [string]$Bridge = 'http://127.0.0.1:19387/qq/onebot',
  [string]$OneBot = 'http://127.0.0.1:3000',
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

function Ensure-SnowLuma {
  Info '检查 OneBot 接口及 SnowLuma 进程...'
  if (Test-Port ([uri]$OneBot).Port) {
    $state = Get-OneBotState
    if ($state.online) { Ok "复用在线账号 $($state.account.user_id)"; return $true }
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
  if (-not (Get-BridgeStatus)) { Bad 'DSH 桥接未响应，保留当前 QQ 状态。'; return $false }
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
  $success = $true
  switch ($Mode) {
    'status' { Show-Status }
    'stop' { $success = Set-Hosting $false }
    'restart' {
      # 先确认账号仍在线，再重置托管；服务故障不破坏已有 QQ 会话。
      if (-not (Get-BridgeStatus) -or -not (Ensure-Transport)) { $success = $false; break }
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
