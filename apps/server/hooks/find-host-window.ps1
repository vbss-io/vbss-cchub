param([int]$StartPid)

$shells = @("pwsh", "powershell", "cmd", "bash", "zsh", "sh", "fish", "nu", "wsl")

$parents = @{}
$names = @{}
$paths = @{}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  $procId = [int]$_.ProcessId
  $parents[$procId] = [int]$_.ParentProcessId
  $names[$procId] = ($_.Name -replace '\.exe$', '').ToLower()
  $paths[$procId] = if ($_.ExecutablePath) { $_.ExecutablePath.ToLower() } else { "" }
}

$current = $StartPid
$shellPid = 0
$claudePid = 0
$hostKind = "terminal"
$hostDecided = $false
for ($i = 0; $i -lt 30; $i++) {
  $name = $names[$current]
  $path = $paths[$current]
  $parentPid = if ($parents.ContainsKey($current)) { $parents[$current] } else { 0 }
  $parentName = if ($parentPid -gt 0) { $names[$parentPid] } else { $null }
  $isDesktopApp = ($path -like "*\windowsapps\claude_*") -or ($name -eq "claude" -and $path -like "*\claude.exe" -and $path -notlike "*\.local\bin\*" -and $path -notlike "*\npm\*" -and $path -notlike "*node_modules*")
  if ($name -eq "claude" -and $claudePid -eq 0 -and -not $isDesktopApp) { $claudePid = $current }
  if (-not $hostDecided) {
    if ($isDesktopApp) {
      $hostKind = "claude-desktop"; $hostDecided = $true
    } elseif ($name -like "code*") {
      $hostKind = "vscode"; $hostDecided = $true
    } elseif ($name -eq "windowsterminal" -or $name -eq "mintty" -or $name -eq "conhost" -or $name -eq "alacritty" -or $name -eq "wezterm-gui") {
      $hostKind = "terminal"; $hostDecided = $true
    }
  }
  # the terminal shell is the shell VS Code itself launched: a shell whose parent is Code
  # ("code" stable or "code - insiders"). This skips the ephemeral cmd.exe that Claude
  # spawns to run this very hook.
  if ($name -and ($shells -contains $name) -and $parentName -like "code*") {
    $shellPid = $current
  }
  $proc = Get-Process -Id $current -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    $isCode = ($name -like "code*")
    if (-not $hostDecided -and $isCode) { $hostKind = "vscode" }
    [pscustomobject]@{ windowPid = $current; shellPid = $shellPid; claudePid = $claudePid; isCode = $isCode; host = $hostKind } |
      ConvertTo-Json -Compress
    exit 0
  }
  if ($parentPid -le 0 -or $parentPid -eq $current) { break }
  $current = $parentPid
}

if ($claudePid -gt 0) {
  [pscustomobject]@{ windowPid = 0; shellPid = 0; claudePid = $claudePid; isCode = $false; host = $hostKind } |
    ConvertTo-Json -Compress
  exit 0
}

exit 1
