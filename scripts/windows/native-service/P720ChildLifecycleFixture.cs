// KMJ TECHNO - fixture-only Windows native cooperative stop lifecycle.
// Never launches Node, accesses enrolled agents, or changes Scheduled Tasks.
// Both parent and child are the same test-only Stage-0 service executable.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

namespace KmjCodeBridge.P720 {
  internal static class P720ChildLifecycleFixture {
    internal const string Ready = "KMJ_CHILD_FIXTURE_READY";
    internal const string Graceful = "KMJ_P720_CHILD_LIFECYCLE_GRACEFUL=PASS";
    internal const string Timeout = "KMJ_P720_CHILD_LIFECYCLE_TIMEOUT_FENCED=PASS";
    internal const string EventPrefix = "Local\\KMJP720Fixture-";

    internal static bool ValidEventName(string name) {
      if (String.IsNullOrEmpty(name) || !name.StartsWith(EventPrefix, StringComparison.Ordinal))
        return false;
      string tail = name.Substring(EventPrefix.Length);
      Guid parsed;
      return tail.Length == 32 && Guid.TryParseExact(tail, "N", out parsed);
    }

    internal static int Child(string mode, string eventName) {
      if (!ValidEventName(eventName)) return 5;
      try {
        using (EventWaitHandle stop = EventWaitHandle.OpenExisting(eventName)) {
          Console.WriteLine(Ready);
          Console.Out.Flush();
          if (String.Equals(mode, "WAIT", StringComparison.Ordinal))
            return stop.WaitOne(8000) ? 0 : 6;
          if (String.Equals(mode, "HOLD", StringComparison.Ordinal)) {
            Thread.Sleep(30000);
            return 4;
          }
        }
      } catch {}
      return 5;
    }

    private static int Error(int code) {
      // Emit only a fixed numeric failure class, never process arguments,
      // account identities, paths, child output, stderr or credentials.
      Console.WriteLine("KMJ_P720_CHILD_FIXTURE_FAILURE_CLASS=" + code);
      return code;
    }

    internal static int Exercise(bool expectTimeout) {
      string binary = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
      if (!File.Exists(binary)) return Error(12);
      string eventName = EventPrefix + Guid.NewGuid().ToString("N");
      if (!ValidEventName(eventName)) return Error(12);

      using (EventWaitHandle stop = new EventWaitHandle(
        false, EventResetMode.ManualReset, eventName)) {
        using (Process child = new Process()) {
          child.StartInfo = new ProcessStartInfo {
            FileName = binary,
            Arguments = "--fixture-child " + (expectTimeout ? "HOLD " : "WAIT ") + eventName,
            WorkingDirectory = Path.GetDirectoryName(binary),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
          };
          bool started = false;
          try {
            started = child.Start();
            if (!started) return Error(13);
            // ManualReset event keeps a STOP signal even if the fixture child
            // hasn't yet finished opening its handle; no stdin/console codecs.
            stop.Set();
            bool exited = child.WaitForExit(expectTimeout ? 1500 : 8000);
            if (expectTimeout) {
              if (exited) return Error(15);
              // Only this exact parent-created fixture Process is terminated.
              // Never enumerate or stop a real CodeBridge or CineCore agent.
              child.Kill();
              if (!child.WaitForExit(3000)) return Error(16);
            } else {
              if (!exited) return Error(14);
              if (child.ExitCode != 0) {
                int code = child.ExitCode;
                return Error(code >= 1 && code <= 9 ? 20 + code : 17);
              }
            }
            // The fixture writes one fixed, short stdout line. Read it only
            // after child exit, avoiding blocking on redirected output.
            string receipt = child.StandardOutput.ReadToEnd().Trim();
            if (!String.Equals(receipt, Ready, StringComparison.Ordinal))
              return Error(19);
            Console.WriteLine(expectTimeout ? Timeout : Graceful);
            return 0;
          } catch {
            return Error(18);
          } finally {
            if (started) {
              try {
                if (!child.HasExited) {
                  child.Kill();
                  child.WaitForExit(3000);
                }
              } catch {}
            }
          }
        }
      }
    }
  }
}
