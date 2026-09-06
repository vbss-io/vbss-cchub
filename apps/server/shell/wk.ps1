function wk {
  param([string]$Name)
  $root = if ($env:WORKSPACES_ROOT) { $env:WORKSPACES_ROOT } else { Join-Path $HOME "workspaces" }
  $editor = if ($env:WK_EDITOR) { $env:WK_EDITOR } else { "code" }
  if (-not $Name) {
    $files = @(Get-ChildItem -Path $root -Filter *.code-workspace -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) { Write-Host "no workspaces in $root"; return }
    $files | ForEach-Object { Write-Host ("  " + $_.BaseName) }
    return
  }
  $file = Join-Path $root "$Name.code-workspace"
  if (-not (Test-Path -LiteralPath $file)) { Write-Host "workspace '$Name' not found in $root"; return }
  Start-Process -FilePath $editor -ArgumentList ('"' + $file + '"')
}
