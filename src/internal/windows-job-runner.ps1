# SPDX-FileCopyrightText: 2026 Fulmetry contributors
# SPDX-License-Identifier: MIT
param(
  [Parameter(Mandatory = $true)]
  [string]$Payload
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class FulmetryWindowsJob
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint INFINITE = 0xffffffff;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    public sealed class ProcessIdentity
    {
        public int pid { get; set; }
        public string startTimeUtcTicks { get; set; }
    }

    public sealed class RunResult
    {
        public bool containmentApplied { get; set; }
        public int childExitCode { get; set; }
        public ulong peakJobMemoryBytes { get; set; }
        public List<ProcessIdentity> orphanProcesses { get; set; }
        public List<ProcessIdentity> survivorProcesses { get; set; }
        public string error { get; set; }
    }

    private static Exception NativeError(string operation)
    {
        return new InvalidOperationException(
            operation + " failed with Win32 error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;
        var result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static StringBuilder CommandLine(string executable, string[] arguments)
    {
        var commandLine = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine;
    }

    private static ulong QueryPeakJobMemory(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint returned;
            if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size, out returned))
                throw NativeError("QueryInformationJobObject(extended limits)");
            var information = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(
                buffer,
                typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            return information.PeakJobMemoryUsed.ToUInt64();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static List<int> QueryProcessIds(IntPtr job)
    {
        const int capacity = 8192;
        int size = 8 + IntPtr.Size * capacity;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint returned;
            if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)size, out returned))
                throw NativeError("QueryInformationJobObject(process list)");
            uint count = (uint)Marshal.ReadInt32(buffer, 4);
            var result = new List<int>();
            for (uint index = 0; index < count; index++)
            {
                long pid = IntPtr.Size == 8
                    ? Marshal.ReadInt64(buffer, 8 + (int)index * IntPtr.Size)
                    : Marshal.ReadInt32(buffer, 8 + (int)index * IntPtr.Size);
                if (pid > 0 && pid <= Int32.MaxValue) result.Add((int)pid);
            }
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static ProcessIdentity Identity(int pid)
    {
        string start = "unavailable";
        try
        {
            using (Process process = Process.GetProcessById(pid))
                start = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        }
        catch { }
        return new ProcessIdentity { pid = pid, startTimeUtcTicks = start };
    }

    private static bool SameProcessIsAlive(ProcessIdentity identity)
    {
        try
        {
            using (Process process = Process.GetProcessById(identity.pid))
            {
                if (identity.startTimeUtcTicks == "unavailable") return !process.HasExited;
                string current = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
                return current == identity.startTimeUtcTicks && !process.HasExited;
            }
        }
        catch { return false; }
    }

    public static RunResult Run(string executable, string[] arguments, string workingDirectory)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr processHandle = IntPtr.Zero;
        IntPtr threadHandle = IntPtr.Zero;
        var result = new RunResult {
            containmentApplied = false,
            childExitCode = 1,
            peakJobMemoryBytes = 0,
            orphanProcesses = new List<ProcessIdentity>(),
            survivorProcesses = new List<ProcessIdentity>()
        };
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw NativeError("CreateJobObject");

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitsBuffer = Marshal.AllocHGlobal(limitsSize);
            try
            {
                Marshal.StructureToPtr(limits, limitsBuffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsBuffer, (uint)limitsSize))
                    throw NativeError("SetInformationJobObject");
            }
            finally
            {
                Marshal.FreeHGlobal(limitsBuffer);
            }

            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = (int)STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            PROCESS_INFORMATION processInformation;
            if (!CreateProcess(
                executable,
                CommandLine(executable, arguments),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out processInformation))
                throw NativeError("CreateProcess");
            processHandle = processInformation.hProcess;
            threadHandle = processInformation.hThread;

            if (!AssignProcessToJobObject(job, processHandle))
            {
                TerminateProcess(processHandle, 1);
                throw NativeError("AssignProcessToJobObject");
            }
            result.containmentApplied = true;
            if (ResumeThread(threadHandle) == UInt32.MaxValue) throw NativeError("ResumeThread");
            CloseHandle(threadHandle);
            threadHandle = IntPtr.Zero;

            if (WaitForSingleObject(processHandle, INFINITE) != WAIT_OBJECT_0)
                throw NativeError("WaitForSingleObject");
            uint exitCode;
            if (!GetExitCodeProcess(processHandle, out exitCode)) throw NativeError("GetExitCodeProcess");
            result.childExitCode = unchecked((int)exitCode);
            result.peakJobMemoryBytes = QueryPeakJobMemory(job);
            foreach (int pid in QueryProcessIds(job))
            {
                if (pid != processInformation.dwProcessId) result.orphanProcesses.Add(Identity(pid));
            }

            CloseHandle(job);
            job = IntPtr.Zero;
            var deadline = DateTime.UtcNow.AddSeconds(5);
            foreach (ProcessIdentity identity in result.orphanProcesses)
            {
                while (DateTime.UtcNow < deadline && SameProcessIsAlive(identity))
                    System.Threading.Thread.Sleep(25);
                if (SameProcessIsAlive(identity)) result.survivorProcesses.Add(identity);
            }
            return result;
        }
        catch (Exception error)
        {
            result.error = error.Message;
            return result;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (threadHandle != IntPtr.Zero) CloseHandle(threadHandle);
            if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
        }
    }
}
'@

function Write-ResultRecord {
  param(
    [Parameter(Mandatory = $true)][IO.FileStream]$Stream,
    [Parameter(Mandatory = $true)]$Record
  )
  $json = $Record | ConvertTo-Json -Depth 6 -Compress
  $encoding = New-Object Text.UTF8Encoding($false)
  $bytes = $encoding.GetBytes($json)
  $Stream.Position = 0
  $Stream.SetLength(0)
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush($true)
}

$resultPath = $null
$resultStream = $null
$wrapperExitCode = 87
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
  $request = $json | ConvertFrom-Json
  $resultPath = [string]$request.resultPath
  # This non-inheritable, exclusive handle is acquired before the target starts.
  # A same-token contained target therefore cannot author, replace, or delete the
  # record while the trusted wrapper is alive. If the wrapper is killed, Job
  # Object handle closure kills the entire target tree and the empty/partial
  # record fails closed in the Bun parent.
  $resultStream = [IO.File]::Open(
    $resultPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  $arguments = @($request.arguments | ForEach-Object { [string]$_ })
  $result = [FulmetryWindowsJob]::Run(
    [string]$request.executable,
    [string[]]$arguments,
    [string]$request.workingDirectory
  )
  Write-ResultRecord -Stream $resultStream -Record $result
  if (-not $result.containmentApplied -or $result.survivorProcesses.Count -gt 0) { $wrapperExitCode = 87 }
  elseif ($result.orphanProcesses.Count -gt 0) { $wrapperExitCode = 86 }
  else { $wrapperExitCode = $result.childExitCode }
}
catch {
  if ($null -ne $resultStream) {
    try {
      Write-ResultRecord -Stream $resultStream -Record @{
        containmentApplied = $false
        childExitCode = 1
        peakJobMemoryBytes = 0
        orphanProcesses = @()
        survivorProcesses = @()
        error = $_.Exception.Message
      }
    } catch { }
  }
  [Console]::Error.WriteLine("CI_GATE_PROCESS_CONTAINMENT_UNAVAILABLE: " + $_.Exception.Message)
  $wrapperExitCode = 87
}
finally {
  if ($null -ne $resultStream) { $resultStream.Dispose() }
}
exit $wrapperExitCode
