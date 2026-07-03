param([int]$StartPid)

$shells = @("pwsh", "powershell", "cmd", "bash", "zsh", "sh", "fish", "nu", "wsl")

$parents = @{}
$names = @{}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  $procId = [int]$_.ProcessId
  $parents[$procId] = [int]$_.ParentProcessId
  $names[$procId] = ($_.Name -replace '\.exe$', '').ToLower()
}

$current = $StartPid
$shellPid = 0
for ($i = 0; $i -lt 30; $i++) {
  $name = $names[$current]
  $parentPid = if ($parents.ContainsKey($current)) { $parents[$current] } else { 0 }
  $parentName = if ($parentPid -gt 0) { $names[$parentPid] } else { $null }
  # the terminal shell is the shell VS Code itself launched: a shell whose parent is Code
  # ("code" stable or "code - insiders"). This skips the ephemeral cmd.exe that Claude
  # spawns to run this very hook.
  if ($name -and ($shells -contains $name) -and $parentName -like "code*") {
    $shellPid = $current
  }
  $proc = Get-Process -Id $current -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    $isCode = ($name -like "code*")
    [pscustomobject]@{ windowPid = $current; shellPid = $shellPid; isCode = $isCode } |
      ConvertTo-Json -Compress
    exit 0
  }
  if ($parentPid -le 0 -or $parentPid -eq $current) { break }
  $current = $parentPid
}

exit 1
