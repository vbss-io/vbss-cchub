param([string]$AppId = 'io.vbss.cchub')
$push = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -ErrorAction SilentlyContinue
$toasts = if ($null -eq $push -or $null -eq $push.ToastEnabled) { $null } else { [int]$push.ToastEnabled -ne 0 }
$app = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$AppId" -ErrorAction SilentlyContinue
$appEnabled = if ($null -eq $app -or $null -eq $app.Enabled) { $null } else { [int]$app.Enabled -ne 0 }
$registered = $null -ne (Get-StartApps | Where-Object { $_.AppID -eq $AppId })
@{ toastsEnabled = $toasts; appEnabled = $appEnabled; registered = $registered } | ConvertTo-Json -Compress
