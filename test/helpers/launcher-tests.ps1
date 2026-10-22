param([string]$Launcher)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Load only function definitions. No real startup or control request is executed.
$ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object {
  Invoke-Expression $_.Extent.Text
}
$source = Get-Content -LiteralPath $Launcher -Raw -Encoding UTF8
$realTestPort = (Get-Item Function:Test-Port).ScriptBlock
. (Join-Path (Split-Path $Launcher -Parent) 'windows-processes.ps1')
$main = $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] } | Select-Object -Last 1
# The fixture must not contend with a real user launcher during tests.
$mainText = $main.Extent.Text.Replace('Local\DshQqBridgeNapCatStart', ('Local\DshQqBridgeLauncherTest-' + $PID))
$Uin = '3667925015'
$NapCatDir = 'X:\fake-napcat'
$Bridge = 'http://127.0.0.1:19387/qq/onebot'
$OneBot = 'http://127.0.0.1:3000'
$Token = ''
$BridgeToken = ''
$Backend = 'NapCat'
$SnowLumaDir = 'X:\fake-snowluma'
$script:passed = 0
function Assert($value, $message) { if (-not $value) { throw $message } }
function Reset-Mocks {
  $script:port = $true
  $script:injected = $false
  $script:qq = $false
  $script:account = '3667925015'
  $script:online = $true
  $script:retcode = 0
  $script:protocol = 'ok'
  $script:httpError = $false
  $script:bridgeUp = $true
  $script:launches = 0
  $script:sleeps = 0
  $script:calls = @()
  $script:controls = @()
  $script:tokenHeaders = @()
  $script:files = $true
  $script:afterSleep = $false
  $script:snowLaunches = 0
  $script:snowStops = 0
  $script:snowExisting = $false
  $script:snowStarted = [DateTime]::UtcNow.AddMinutes(-10)
  $script:configWritten = [DateTime]::UtcNow
  $script:good = $true
  $Backend = 'NapCat'
}
# Override OS and network adapters, retaining all production decisions.
function Test-Port([int]$Port) { $script:calls += "port:$Port"; return $script:port }
function Get-Process {
  param($Name, $Id, $ErrorAction)
  if ($Id) { return @{ Id = $Id; StartTime = $script:snowStarted } }
  if (($Name -contains 'NapCatWinBootMain' -or $Name -eq 'NapCatWinBootMain') -and $script:injected) { return @{ Id = 1 } }
  if (($Name -contains 'QQ' -or $Name -eq 'QQ') -and $script:qq) { return @{ Id = 2 } }
}
function Stop-Process { param($Id) $script:calls += "stop:$Id"; $script:snowStops++; $script:port = $false; $script:online = $false }
function Get-Item { param($LiteralPath) return @{ LastWriteTimeUtc = $script:configWritten } }
function Test-Path { param($LiteralPath) return $script:files }
function Join-Path { param($Path, $ChildPath) return "$Path\$ChildPath" }
function Get-Content {
  param($LiteralPath, [switch]$Raw, $Encoding)
  if ($LiteralPath -match 'webui') { return '{"autoLoginAccount":"3667925015"}' }
  if ($LiteralPath -match 'onebot_') { return '{"networks":{"httpServers":[{"port":3000,"accessToken":"snow-token"}]}}' }
  if ($LiteralPath -match 'onebot11_') { return '{"network":{"httpServers":[{"enable":true,"port":3000,"token":"account-token"}]}}' }
  return '{"network":{"httpServers":[{"enable":true,"port":3000,"token":"common-token"}]}}'
}
function Invoke-RestMethod {
  param($Uri, $Method, $Headers, $ContentType, $Body, $TimeoutSec, $ErrorAction)
  $script:calls += $Uri
  if ($Uri -eq $Bridge) { if ($script:bridgeUp) { return @{ agentEnabled = $true } }; throw 'bridge offline' }
  if ($Uri -eq "$Bridge/control") {
    $next = ($Body | ConvertFrom-Json).enabled
    $script:controls += $next
    return @{ agentEnabled = $next }
  }
  if ($script:httpError) { throw 'HTTP 401 Unauthorized' }
  $script:tokenHeaders += $Headers.Authorization
  if ($Uri -match '/get_login_info$') { return @{ status = $script:protocol; retcode = $script:retcode; data = @{ user_id = $script:account; nickname = 'test' } } }
  if ($Uri -match '/get_status$') { return @{ status = $script:protocol; retcode = $script:retcode; data = @{ online = $script:online; good = $script:good } } }
  throw "unexpected request: $Uri"
}
function Invoke-CimMethod {
  param($ClassName, $MethodName, $Arguments)
  $script:launches++
  Assert ($Arguments.CommandLine -match '3667925015') 'quick login account missing'
  Assert ($Arguments.CommandLine -match '^cmd.exe /c ""') 'batch path quoting missing'
  return @{ ReturnValue = 0; ProcessId = 100 }
}
function Start-Sleep { param($Seconds) $script:sleeps++; if ($script:afterSleep) { $script:port = $true; $script:online = $true } }
function Get-BridgeProcesses { param($Names) if ($script:snowExisting) { return @{ Name = 'node.exe'; ProcessId = 4242; CommandLine = "$PSScriptRoot\start-snowluma.mjs $SnowLumaDir 3667925015" } } }
function Start-SnowLumaService { $script:snowLaunches++; $script:port = $true; $script:online = $true; $script:afterSleep = $true }
function Test($name, $body) {
  Reset-Mocks
  & $body
  $script:passed++
  Write-Host "  PASS $name"
}
Test 'native listener check works without CIM and distinguishes closed ports' {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  try { Assert (& $realTestPort $port) 'native listener not detected' }
  finally { $listener.Stop() }
  Assert (-not (& $realTestPort $port)) 'closed listener still detected'
}
Test 'native process inspection returns actual ancestry and command line' {
  $detail = [DshQq.NativeProcess]::Read($PID)
  Assert ([int]$detail[0] -gt 0 -and [int]$detail[0] -ne $PID) 'parent process missing'
  Assert ($detail[1] -match 'launcher-tests.ps1') 'own command line missing'
}
Test 'online start reuses QQ and performs no process launch' {
  $script:qq = $true; $script:injected = $true
  Assert (Start-All) 'start failed'
  Assert ($script:launches -eq 0) 'online client relaunched'
  Assert ($script:controls.Count -eq 1 -and $script:controls[0]) 'hosting not enabled'
}
Test 'restart only toggles hosting and does not restart logged-in QQ' {
  $Mode = 'restart'
  Invoke-Expression $mainText
  Assert ($script:launches -eq 0) 'restart launched QQ'
  Assert ($script:controls.Count -eq 2 -and -not $script:controls[0] -and $script:controls[1]) 'wrong restart controls'
}
Test 'wrong account is preserved without enabling hosting' {
  $script:account = '123456'
  Assert (-not (Start-All)) 'wrong account accepted'
  Assert ($script:launches -eq 0 -and $script:controls.Count -eq 0) 'wrong account altered'
}
Test 'open port with offline QQ is not treated as login success' {
  $script:online = $false
  Assert (-not (Start-All)) 'offline account accepted'
  Assert ($script:launches -eq 0 -and $script:controls.Count -eq 0) 'offline client relaunched'
}
Test 'HTTP authentication failure does not force login or clear processes' {
  $script:httpError = $true
  Assert (-not (Ensure-NapCat)) 'HTTP auth failure ignored'
  Assert ($script:launches -eq 0) 'auth error started another QQ'
}
Test 'failed OneBot protocol response is rejected' {
  $script:protocol = 'failed'; $script:retcode = 1400
  Assert (-not (Ensure-NapCat)) 'failed protocol accepted'
}
Test 'existing legacy adapter still starting is awaited without duplicate launch' {
  $script:port = $false; $script:injected = $true; $script:afterSleep = $true
  Assert (Ensure-NapCat) 'existing startup not awaited'
  Assert ($script:launches -eq 0 -and $script:sleeps -eq 1) 'duplicate launch'
}
Test 'naked QQ is left running and reported as an injection conflict' {
  $script:port = $false; $script:qq = $true
  Assert (-not (Ensure-NapCat)) 'naked QQ ignored'
  Assert ($script:launches -eq 0) 'naked QQ replaced'
}
Test 'cold startup launches exactly once with quick login account' {
  $script:port = $false; $script:afterSleep = $true
  Assert (Ensure-NapCat) 'cold start failed'
  Assert ($script:launches -eq 1) 'wrong launch count'
}
Test 'missing launcher does not create a process' {
  $script:port = $false; $script:files = $false
  Assert (-not (Ensure-NapCat)) 'missing launcher ignored'
  Assert ($script:launches -eq 0) 'missing launcher executed'
}
Test 'missing DSH keeps QQ untouched and skips startup' {
  $script:bridgeUp = $false
  Assert (-not (Start-All)) 'missing bridge ignored'
  Assert ($script:launches -eq 0 -and $script:controls.Count -eq 0) 'QQ changed without bridge'
}
Test 'startup timeout does not loop process creation or claim online' {
  $script:port = $false; $script:injected = $true
  Assert (-not (Ensure-NapCat)) 'timeout reported as success'
  Assert ($script:launches -eq 0 -and $script:sleeps -eq 40) 'bad startup retry'
}
Test 'account-specific OneBot token is selected' {
  Assert ((Get-OneBotHeaders).Authorization -eq 'Bearer account-token') 'wrong config token'
}
Test 'omitted account resolves persistent automatic login selection' {
  $saved = $Uin
  $Uin = ''
  Assert ((Resolve-LoginAccount) -eq '3667925015') 'persistent account ignored'
  $Uin = $saved
}
Test 'SnowLuma starts with naked QQ then enables hosting without a legacy adapter' {
  $Backend = 'SnowLuma'; $script:port = $false; $script:qq = $true
  Assert (Start-All) 'SnowLuma failed with running QQ'
  Assert ($script:snowLaunches -eq 1 -and $script:launches -eq 0) 'wrong backend launch'
  Assert ($script:controls.Count -eq 1 -and $script:controls[0]) 'hosting not enabled'
}
Test 'existing SnowLuma is awaited without duplicate launch' {
  $Backend = 'SnowLuma'; $script:port = $false; $script:qq = $true; $script:snowExisting = $true; $script:afterSleep = $true
  Assert (Ensure-SnowLuma) 'existing SnowLuma ignored'
  Assert ($script:snowLaunches -eq 0 -and $script:launches -eq 0) 'duplicate service'
}
Test 'stale SnowLuma config restarts only the hook' {
  $Backend = 'SnowLuma'; $script:port = $true; $script:online = $true; $script:snowExisting = $true
  $script:snowStarted = [DateTime]::UtcNow.AddMinutes(-10)
  $script:configWritten = [DateTime]::UtcNow
  Assert (Ensure-SnowLuma) 'stale SnowLuma was reused'
  Assert ($script:snowStops -eq 1) 'stale hook was not stopped'
  Assert ($script:snowLaunches -eq 1) 'hook was not restarted'
}
Test 'fresh SnowLuma config is reused without restart' {
  $Backend = 'SnowLuma'; $script:port = $true; $script:online = $true; $script:snowExisting = $true
  $script:snowStarted = [DateTime]::UtcNow
  $script:configWritten = [DateTime]::UtcNow.AddMinutes(-10)
  Assert (Ensure-SnowLuma) 'SnowLuma not reused'
  Assert ($script:snowStops -eq 0 -and $script:snowLaunches -eq 0) 'matching config was restarted'
}
Test 'SnowLuma account-specific credential is selected' {
  $Backend = 'SnowLuma'
  Assert ((Get-OneBotHeaders).Authorization -eq 'Bearer snow-token') 'SnowLuma credential not selected'
}
Test 'unhealthy transport does not enable hosting' {
  $Backend = 'SnowLuma'; $script:good = $false
  Assert (-not (Start-All)) 'unhealthy transport accepted'
  Assert ($script:controls.Count -eq 0 -and $script:snowLaunches -eq 0) 'unhealthy transport changed'
}
$restartHelper = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Restart-SnowLumaService' }, $false) | Select-Object -First 1
Assert ($restartHelper) 'controlled SnowLuma restart helper missing'
$outsideRestart = $source.Replace($restartHelper.Extent.Text, '')
Assert (-not ($outsideRestart -match '(?m)^\s*Stop-Process\b')) 'process killing escaped the controlled SnowLuma restart'
Assert (-not ($source -match '(?m)^\s*taskkill\b')) 'taskkill remains in launcher'
Write-Host "$script:passed passed, 0 failed"
