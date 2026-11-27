// The job handle belongs only to the monitor. Windows closes it on exit even
// when the Hub is killed, so checks cannot outlive the monitor.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::ReadLine()
if (-not $request) { exit 0 }
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class AlcorCheckJob {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Limits {
    public Basic BasicLimits;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int info, ref Limits limits, int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();

  public static int Run(string file, string args) {
    var job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new Limits();
    limits.BasicLimits.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)) ||
        !AssignProcessToJobObject(job, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(job);
      throw new Win32Exception(error);
    }
    // A read on the dedicated control pipe ends when the Hub stops or dies.
    var watcher = new Thread(() => {
      Console.In.ReadToEnd();
      Process.GetCurrentProcess().Kill();
    });
    watcher.IsBackground = true;
    watcher.Start();
    using (var child = Process.Start(new ProcessStartInfo(file, args) {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true
    })) {
      child.StandardInput.Close();
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
'@
  $start = ConvertFrom-Json -InputObject $request
  exit [AlcorCheckJob]::Run($start.file, $start.args)
} catch {
  [Console]::Error.WriteLine('Windows 检查监护器无法启动进程：' + $_.Exception.Message)
  exit 9010
}
`;

export const windowsCheckMonitor = Buffer.from(script, "utf16le").toString(
  "base64",
);
