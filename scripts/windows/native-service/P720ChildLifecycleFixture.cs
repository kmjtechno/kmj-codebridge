// KMJ TECHNO - deterministic fixture-only Windows child lifecycle proof.
// Never launches Node, executes an enrolled agent or changes any Windows task.
// Only the same compiled Stage-0 service host is executed as a test fixture.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
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

    private static int Error(int code) {
      // A bounded fixed numeric class only. Never print paths, process
      // arguments, identities, exception messages or child stderr.
      Console.WriteLine("KMJ_P720_CHILD_FIXTURE_FAILURE_CLASS=" + code);
      return code;
    }

    internal static int Exercise(bool expectTimeout) {
      string binary = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
      if (!File.Exists(binary)) return Error(12);

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
        bool started = false;
        try {
          started = child.Start();
          if (!started) return Error(13);
          // This fixture writes only one fixed, short stdout line. Sending
          // the stop request first avoids asynchronous EventDataReceived races;
          // readiness is independently attested from stdout *after* exit.
          // Write exactly ASCII bytes with LF. Avoid StreamWriter's console
          // encoding/BOM behavior, which can alter a child control message.
          byte[] instruction = Encoding.ASCII.GetBytes(expectTimeout ?
            "HOLD\n" : "STOP\n");
          child.StandardInput.BaseStream.Write(
            instruction, 0, instruction.Length);
          child.StandardInput.BaseStream.Flush();
          bool exited = child.WaitForExit(expectTimeout ? 500 : 8000);
          if (expectTimeout) {
            if (exited) return Error(15);
            // Terminate ONLY the exact fixture we spawned, never search
            // for, stop, or kill any existing CodeBridge/Node agent.
            child.Kill();
            if (!child.WaitForExit(3000)) return Error(16);
          } else {
            if (!exited) return Error(14);
            if (child.ExitCode != 0) {
              int exitCode = child.ExitCode;
              // Diagnostic classes 21..29 are only fixture-defined exits.
              return Error(exitCode >= 1 && exitCode <= 9 ?
                20 + exitCode : 17);
            }
          }

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
