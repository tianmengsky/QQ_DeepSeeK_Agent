# 打开桥接运维面板（/qq/onebot/panel）
#
# 为什么不能把端口写死：面板挂在 DSH 自己的 webServer 上（桥接不另起服务），
# 而 DSH Web GUI 的端口每次重启都可能变（实测 10620 → 10692）。所以这里先
# 把端口找出来，再拼 URL 交给默认浏览器。
#
# 怎么找：只看本机处于 LISTEN 的端口，先试 DSH 进程（进程名含 Harness / DeepSeek）
# 名下的，再试其余；命中条件是页面里带 id="verdicts"。比"状态码 200"严格，
# 免得把别的服务碰巧占用的同名路径误认成面板。
#
# 用法（通过同目录的 open-panel.bat 调用）：
#   open-panel.bat                 找端口并打开
#   open-panel.bat night           打开夜间主题（day / night 可省略）
#   open-panel.bat -Port 10692     跳过探测，直接用这个端口
#   open-panel.bat -Token xxxx     配置里带了 token 时用（也可设环境变量 QQ_PANEL_TOKEN）
#   open-panel.bat -NoOpen         只打印 URL，不弹浏览器

param(
  [string]$Theme = '',
  [int]$Port = 0,
  [string]$Token = '',
  [string]$Path = '/qq/onebot',
  [switch]$NoOpen
)

$ErrorActionPreference = 'Continue'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

# ---- 参数清理 -------------------------------------------------------------

$Theme = "$Theme".Trim().ToLowerInvariant()
if ($Theme -and $Theme -notin @('day', 'night')) {
  Say "主题只能是 day 或 night，忽略：$Theme" 'Yellow'
  $Theme = ''
}
$Path = '/' + "$Path".Trim().Trim('/')
if (-not $Token) { $Token = "$env:QQ_PANEL_TOKEN".Trim() }

# ---- 探测 -----------------------------------------------------------------

# 返回 ok / auth / no。auth = 端口对但页面要 token，也算找到了。
function Probe-Panel([int]$port) {
  $url = "http://127.0.0.1:$port$Path/panel"
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($resp.StatusCode -eq 200 -and $resp.Content -match 'id="verdicts"') { return 'ok' }
    return 'no'
  } catch {
    $answer = $_.Exception.Response
    if ($answer -and [int]$answer.StatusCode -eq 401) { return 'auth' }
    return 'no'
  }
}

function Get-CandidatePorts {
  $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge 1024 } |
    Select-Object -ExpandProperty LocalPort -Unique
  if (-not $listening) { return @() }

  # 把「像是 DSH」的端口排前面，命中得早一点。
  $owned = @{}
  foreach ($conn in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    if ($owned.ContainsKey($conn.OwningProcess)) { continue }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    $owned[$conn.OwningProcess] = if ($proc) { $proc.ProcessName } else { '' }
  }
  $preferred = @()
  foreach ($conn in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    $name = $owned[$conn.OwningProcess]
    if ($name -and ($name -like '*Harness*' -or $name -like 'DeepSeek*')) { $preferred += $conn.LocalPort }
  }

  $ordered = @()
  foreach ($port in $preferred) { if ($ordered -notcontains $port) { $ordered += $port } }
  foreach ($port in $listening) { if ($ordered -notcontains $port) { $ordered += $port } }
  return $ordered
}

$found = 0
$needsToken = $false

if ($Port -gt 0) {
  $verdict = Probe-Panel $Port
  if ($verdict -eq 'no') {
    Say "端口 $Port 上没有面板（$Path/panel 没响应或是别的服务）。" 'Red'
    exit 2
  }
  $found = $Port
  $needsToken = ($verdict -eq 'auth')
} else {
  Say '正在找面板端口…' 'DarkGray'
  $candidates = Get-CandidatePorts
  foreach ($candidate in $candidates) {
    $verdict = Probe-Panel $candidate
    if ($verdict -eq 'no') { continue }
    $found = $candidate
    $needsToken = ($verdict -eq 'auth')
    break
  }
  if (-not $found) {
    Say '没找到面板。' 'Red'
    Say '  1) DSH 起来了吗？（它是 DSH 的 webServer，插件没加载就没有这个地址）' 'Yellow'
    Say '  2) 端口变过了？可以指定：open-panel.bat -Port 10692' 'Yellow'
    Say "  3) 路径改过？默认 $Path，可以指定：open-panel.bat -Path /qq/onebot" 'Yellow'
    # 面板挂不上时最有用的动作就是去看控制台：它不依赖桥接，还能把 DSH 拉起来。
    Say '  4) 想看"到底是哪一层没起来"，用独立控制台：双击 console.bat（http://127.0.0.1:7788/）' 'Cyan'
    exit 1
  }
}

# ---- 拼 URL 并打开 --------------------------------------------------------

$query = @()
if ($Theme) { $query += "theme=$Theme" }
if ($Token -and $needsToken) { $query += 'token=' + [uri]::EscapeDataString($Token) }
$url = "http://127.0.0.1:$found$Path/panel"
if ($query.Count -gt 0) { $url += '?' + ($query -join '&') }

$shown = $url
if ($Token -and $needsToken) { $shown = $url -replace 'token=[^&]+', 'token=***' }

$themeText = if ($Theme) { $Theme } else { '跟随上次/系统' }
Say "面板: 端口 $found，主题 $themeText" 'Green'
Say "  $shown" 'Gray'

if ($needsToken -and -not $Token) {
  Say '这个面板要 token：页面会回 401。' 'Yellow'
  Say '  把配置里的 token 传进来：open-panel.bat -Token xxxx（或设 QQ_PANEL_TOKEN）' 'Yellow'
  Say '  打开后同样会 401 —— 但地址是对的。' 'DarkGray'
}

if ($NoOpen) {
  Say '（-NoOpen：没有打开浏览器）' 'DarkGray'
  exit 0
}

try {
  Start-Process $url | Out-Null
  Say '已交给默认浏览器。' 'DarkGray'
  exit 0
} catch {
  Say "没打开浏览器（$($_.Exception.Message)），手动复制上面的地址吧。" 'Yellow'
  exit 3
}
