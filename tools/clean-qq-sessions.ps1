# QQ 桥接会话清理
#
# 背景：桥接每 rotateEveryTurns 轮就换一个新 Session（这是省 token 的设计），
# 但这会让 sessions 目录里堆积大量小会话文件。实测一天就攒了 94 个。
#
# 为什么要清：这些会话内容是**可丢弃的** —— 桥接自己维护滑动窗口和长期记忆，
# 不依赖 DSH 的会话历史。清掉不影响对话连续性。
#
# 而且 DSH 界面要渲染会话列表，数量多了也增加渲染负担。
#
# 用法（通过同目录的 clean-qq-sessions.bat 调用）：
#   clean-qq-sessions.bat            列出将删除的内容（预演，不动手）
#   clean-qq-sessions.bat -Apply     真的删除
#   clean-qq-sessions.bat -Apply -KeepDays 1   保留最近 1 天的

param(
  [switch]$Apply,
  [int]$KeepDays = 0,
  [string]$Workspace = 'D:\作业\计算机组成原理'
)

$ErrorActionPreference = 'Continue'

# 工作区目录名是路径的转义形式（非 ASCII 会变成 ~XXXX 形式），所以按
# 会话里记的 cwd 来找，而不是拼目录名。

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }

$root = Join-Path $env:USERPROFILE '.dsh\sessions'
if (-not (Test-Path $root)) { Say "找不到 sessions 目录: $root" 'Red'; exit 1 }

$cutoff = (Get-Date).AddDays(-$KeepDays)

# 找出所有工作区目录里、属于目标工作区、且超期的会话
$targets = @()
foreach ($wsDir in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue) {
  foreach ($sess in Get-ChildItem $wsDir.FullName -Directory -ErrorAction SilentlyContinue) {
    $log = Join-Path $sess.FullName 'session.v4.jsonl.zstd'
    if (-not (Test-Path $log)) { continue }
    $stat = Get-Item $log
    if ($stat.LastWriteTime -gt $cutoff) { continue }

    # 会话头部记录了 cwd，用它判断属于哪个工作区
    $cwd = $null
    try {
      $head = Get-Content $log -TotalCount 1 -ErrorAction SilentlyContinue
      if ($head -match '"cwd"\s*:\s*"([^"]+)"') { $cwd = $Matches[1] }
    } catch { }

    $belongs = $false
    if ($cwd) {
      $belongs = ($cwd -replace '\\\\', '\').TrimEnd('\').ToLower() -eq ($Workspace.TrimEnd('\').ToLower())
    } else {
      # 首行拿不到就退化成按工作区目录名匹配
      $belongs = $wsDir.Name -like '*计算机组成原理*' -or $wsDir.Name -like '*~8BA1~7B97~673A*'
    }
    if (-not $belongs) { continue }

    $targets += [PSCustomObject]@{
      Dir   = $sess.FullName
      Name  = $sess.Name
      KB    = [Math]::Round($stat.Length / 1KB, 1)
      Time  = $stat.LastWriteTime
    }
  }
}

Say ''
Say '  ============================================================' 'Cyan'
Say '    QQ 桥接会话清理' 'Cyan'
Say '  ============================================================' 'Cyan'
Say ''
Say "  目标工作区: $Workspace"
if ($KeepDays -gt 0) { Say "  保留最近  : $KeepDays 天" }
Say ''

if ($targets.Count -eq 0) {
  Say '  没有需要清理的会话。' 'Green'
  Say ''
  exit 0
}

$totalKB = ($targets | Measure-Object KB -Sum).Sum
Say "  找到 $($targets.Count) 个会话，合计 $([Math]::Round($totalKB / 1024, 1)) MB"
Say ''
Say '  最近 5 个：'
$targets | Sort-Object Time -Descending | Select-Object -First 5 |
  ForEach-Object { Say ("    {0,8:N1} KB  {1}  {2}" -f $_.KB, $_.Name.Substring(0, [Math]::Min(24, $_.Name.Length)), $_.Time.ToString('MM-dd HH:mm')) }
Say ''

if (-not $Apply) {
  Say '  【预演模式】没有删除任何东西。' 'Yellow'
  Say '  确认无误后加 -Apply 真删：' 'Yellow'
  Say '      clean-qq-sessions.bat -Apply' 'Yellow'
  Say ''
  Say '  这些会话的内容是可丢弃的 —— 桥接自己维护滑动窗口与长期记忆，' 'DarkGray'
  Say '  不依赖 DSH 的会话历史，删掉不影响对话连续性。' 'DarkGray'
  Say ''
  exit 0
}

$del = 0
foreach ($t in $targets) {
  try { Remove-Item -LiteralPath $t.Dir -Recurse -Force -ErrorAction Stop; $del++ }
  catch { Say ("    删除失败: " + $t.Name + " —— " + $_.Exception.Message) 'Red' }
}
Say "  已删除 $del 个会话，释放约 $([Math]::Round($totalKB / 1024, 1)) MB" 'Green'
Say ''
