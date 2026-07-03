param([int]$HostPid, [string]$Cwd)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HubFocus {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<string> Windows() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        int len = GetWindowTextLength(h);
        if (len > 0) {
          var sb = new StringBuilder(len + 1);
          GetWindowText(h, sb, sb.Capacity);
          uint pid; GetWindowThreadProcessId(h, out pid);
          r.Add(h.ToInt64() + "|" + pid + "|" + sb.ToString());
        }
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
  public static void Bring(long hwnd) {
    IntPtr h = (IntPtr)hwnd;
    if (IsIconic(h)) { ShowWindow(h, 9); }
    IntPtr fg = GetForegroundWindow();
    uint tmp;
    uint fgThread = GetWindowThreadProcessId(fg, out tmp);
    uint targetThread = GetWindowThreadProcessId(h, out tmp);
    uint cur = GetCurrentThreadId();
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);
    bool a1 = (fgThread != cur) && AttachThreadInput(fgThread, cur, true);
    bool a2 = (targetThread != cur && targetThread != fgThread) && AttachThreadInput(targetThread, cur, true);
    SetForegroundWindow(h);
    BringWindowToTop(h);
    if (a2) { AttachThreadInput(targetThread, cur, false); }
    if (a1) { AttachThreadInput(fgThread, cur, false); }
  }
}
"@

$leaf = ""
if ($Cwd) { $leaf = ($Cwd.TrimEnd('\', '/') -split '[\\/]')[-1] }

$wins = [HubFocus]::Windows() | ForEach-Object {
  $parts = $_.Split('|', 3)
  [PSCustomObject]@{ Hwnd = [long]$parts[0]; Pid = [int]$parts[1]; Title = $parts[2] }
}

# janelas do mesmo processo que hospeda a sessão
$sameProc = @($wins | Where-Object { $_.Pid -eq $HostPid })
if ($sameProc.Count -eq 0) { $sameProc = @($wins) }

$match = $null
# 1) título contém o nome da pasta da sessão
if ($leaf) { $match = $sameProc | Where-Object { $_.Title -like "*$leaf*" } | Select-Object -First 1 }
# 2) processo tem só uma janela → é ela
if (-not $match -and $sameProc.Count -eq 1) { $match = $sameProc[0] }

if ($match) {
  [HubFocus]::Bring($match.Hwnd)
  exit 0
}

exit 2
