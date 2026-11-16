param(
  [string]$AppId = 'io.vbss.cchub',
  [string]$Title = 'VBSS CCHUB',
  [string]$Body = '',
  [string]$Tag = '',
  [string]$Group = '',
  [switch]$Remove
)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
if ($Remove) {
  if ($Tag -and $Group) {
    [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($Tag, $Group, $AppId)
  }
  Write-Output "ok"
  exit 0
}
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$escapedTitle = [System.Security.SecurityElement]::Escape($Title)
$escapedBody = [System.Security.SecurityElement]::Escape($Body)
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$escapedTitle</text><text>$escapedBody</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
if ($Tag) { $toast.Tag = $Tag }
if ($Group) { $toast.Group = $Group }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
Write-Output "ok"
