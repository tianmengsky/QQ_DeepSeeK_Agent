# Local process inspection without CIM/WMI. No credentials or command lines are printed.
if (-not ('DshQq.NativeProcess' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
namespace DshQq { public static class NativeProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, IntPtr buffer, int length, out int returned);
  public static object[] Read(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr basic = Marshal.AllocHGlobal(IntPtr.Size * 6);
    IntPtr text = IntPtr.Zero;
    try {
      int length;
      if (NtQueryInformationProcess(handle, 0, basic, IntPtr.Size * 6, out length) < 0) throw new Exception("Process ancestry unavailable");
      int parent = Marshal.ReadIntPtr(basic, IntPtr.Size * 5).ToInt32();
      NtQueryInformationProcess(handle, 60, IntPtr.Zero, 0, out length);
      if (length <= 0 || length > 1048576) throw new Exception("Process command line unavailable");
      text = Marshal.AllocHGlobal(length);
      if (NtQueryInformationProcess(handle, 60, text, length, out length) < 0) throw new Exception("Process command line unavailable");
      int bytes = (ushort)Marshal.ReadInt16(text);
      IntPtr value = Marshal.ReadIntPtr(text, IntPtr.Size == 8 ? 8 : 4);
      return new object[] { parent, bytes == 0 ? "" : Marshal.PtrToStringUni(value, bytes / 2) };
    } finally {
      if (text != IntPtr.Zero) Marshal.FreeHGlobal(text);
      Marshal.FreeHGlobal(basic);
      CloseHandle(handle);
    }
  }
} }
'@
}

function Get-BridgeProcesses {
  param([string[]]$Names = @('node', 'QQ', 'NapCat*'))
  foreach ($process in [System.Diagnostics.Process]::GetProcesses()) {
    try {
      $name = $process.ProcessName
      if (-not @($Names | Where-Object { $name -like $_ }).Count) { continue }
      try { $detail = [DshQq.NativeProcess]::Read($process.Id) }
      catch {
        if ($process.HasExited) { continue }
        throw "Cannot inspect $name PID $($process.Id); startup stopped to avoid duplicate services or unknown-account injection."
      }
      [pscustomobject]@{ ProcessId = $process.Id; ParentProcessId = $detail[0]; Name = "$name.exe"; CommandLine = $detail[1] }
    } finally { $process.Dispose() }
  }
}
