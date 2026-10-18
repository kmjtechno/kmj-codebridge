// KMJ TECHNO - bounded fixture-only Windows child-process lifecycle proof.
// This is NOT a CodeBridge agent launcher; it can execute only a copy of the
// same Stage-0 SCM host as a harmless self-test process.
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

    internal static int Child() {
      Console.WriteLine(Ready);
      Console.Out.Flush();
      string instruction = Console.ReadLine();
      if (String.Equals(instruction, "STOP", StringComparison.Ordinal)) return 0;
      if (String.Equals(instruction, "HOLD", StringComparison.Ordinal)) {
        Thread.Sleep(30000);
        return 4;
      }
      return 5;
    }

    // Starts only this already-compiled Stage-0 host with a literal fixture
    // argument; the real agent entrypoint, task, service, enrollment config,
    // tokens and process command lines are never accessed.
    internal static int Exercise(bool expectTimeout) {
      string binary = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
      if (!File.Exists(binary)) return 12;
      using (ManualResetEvent ready = new ManualResetEvent(false)) {
        using (Process child = new Process()) {
          child.StartInfo = new ProcessStartInfo {
            FileName = binary,
            Arguments = "--fixture-child",
            WorkingDirectory = Path.GetDirectoryName(binary),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
          };
          child.EnableRaisingEvents = true;
          child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
            if (String.Equals(e.Data, Ready, StringComparison.Ordinal)) ready.Set();
          };

          bool started = false;
          try {
            started = child.Start();
            if (!started) return 13;
            child.BeginOutputReadLine();
            if (!ready.WaitOne(5000)) return 14;

            child.StandardInput.WriteLine(expectTimeout ? "HOLD" : "STOP");
            child.StandardInput.Flush();
            // A timed-out fixture is killed only through its owned Process
            // handle; never enumerate or terminate any real Node agent.
            bool exited = child.WaitForExit(expectTimeout ? 400 : 8000);
            if (expectTimeout) {
              if (exited) return 15;
              child.Kill();
              if (!child.WaitForExit(3000)) return 16;
              Console.WriteLine(Timeout);
              return 0;
            }
            if (!exited || child.ExitCode != 0) return 17;
            Console.WriteLine(Graceful);
            return 0;
          } catch {
            // Do not log user identities, command lines, paths or child data.
            return 18;
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
