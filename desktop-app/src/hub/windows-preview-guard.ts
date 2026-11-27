// This owner is outside the Job Object. It can confirm that all render
// processes are gone before returning a terminal receipt to the monitor.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $line = [Console]::ReadLine()
  if (-not $line) { exit 1 }
  $inputSpec = ConvertFrom-Json -InputObject $line
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AlcorPreviewGuard {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic {
    public long PerProcessTime, PerJobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint Priority, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Limits {
    public Basic Base;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, In, Out, Error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, ref Limits data, int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int cls, out Accounting data, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint status);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateProcess(IntPtr process, uint status);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string file, StringBuilder command,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
    IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static volatile bool stop;
  static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }

  public static void Run(string file, string command, string cwd, long hardAt) {
    var job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    Require(job != IntPtr.Zero);
    var process = new ProcessInfo();
    bool assigned = false;
    try {
      var limits = new Limits();
      limits.Base.Flags = 0x2000;
      Require(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
      var reader = new Thread(() => { try { Console.In.ReadToEnd(); } finally { stop = true; } });
      reader.IsBackground = true;
      reader.Start();
      var startup = new Startup();
      startup.Size = (uint)Marshal.SizeOf(startup);
      Require(CreateProcess(file, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
        false, 0x08000004, IntPtr.Zero, cwd, ref startup, out process));
      Require(AssignProcessToJobObject(job, process.Process));
      assigned = true;
      if (!stop && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < hardAt) {
        Require(ResumeThread(process.Thread) != 0xffffffff);
        Console.WriteLine("started");
      }
      bool terminated = false;
      while (true) {
        Accounting current;
        Require(QueryInformationJobObject(job, 1, out current, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (current.ActiveProcesses == 0) break;
        if ((stop || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= hardAt) && !terminated) {
          Require(TerminateJobObject(job, 164));
          terminated = true;
        }
        Thread.Sleep(40);
      }
      uint code;
      Require(GetExitCodeProcess(process.Process, out code));
      Console.WriteLine("released " + code + " " + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    } finally {
      if (process.Process != IntPtr.Zero) {
        if (!assigned) TerminateProcess(process.Process, 164); // still suspended
        CloseHandle(process.Thread);
        CloseHandle(process.Process);
      }
      CloseHandle(job);
    }
  }
}
'@
  [AlcorPreviewGuard]::Run($inputSpec.file, $inputSpec.command, $inputSpec.cwd, [long]$inputSpec.hardAt)
} catch {
  # The caller deliberately does not interpret monitor failure as release.
  exit 91
}
`;

export const windowsPreviewGuard = Buffer.from(script, "utf16le").toString("base64");
