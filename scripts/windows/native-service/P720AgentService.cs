// KMJ TECHNO - P720 Windows SCM host, Stage 0 (non-activating).
// Compile with Windows .NET Framework csc and System.ServiceProcess.dll.
// Intentionally does NOT launch Node or install/start/change an SCM service.
// Safe agent shutdown, authenticated enrollment and rollback are not yet proven.
using System;
using System.ServiceProcess;
using System.Security.Principal;

namespace KmjCodeBridge.P720 {
  internal sealed class P720AgentService : ServiceBase {
    internal const string FixedServiceName = "KMJ-CodeBridge-P720-AgentService";
    internal const string NotReadyCode = "KMJ_P720_SERVICE_HOST_ACTIVATION=BLOCKED_UNVERIFIED_TAKEOVER";

    public P720AgentService() {
      ServiceName = FixedServiceName;
      CanStop = true;
      CanShutdown = true;
      CanPauseAndContinue = false;
      AutoLog = false; // Never emit enrolled agent credentials or paths in event logs.
    }

    protected override void OnStart(string[] args) {
      // A source-compiled host must NOT be allowed to replace an online agent
      // just because a Windows service was created. Until a reviewed
      // single-device lease, independent enrolled identity, cooperative stop,
      // server-observed heartbeat, and tested rollback exist, fail closed.
      throw new InvalidOperationException(NotReadyCode);
    }

    protected override void OnStop() {
      // There is deliberately no agent process owned by Stage 0.
    }

    protected override void OnShutdown() {
      // Do not kill or modify any existing user-owned CodeBridge agent.
    }

    internal static int SelfTest() {
      if (FixedServiceName != "KMJ-CodeBridge-P720-AgentService") return 3;
      if (String.IsNullOrEmpty(NotReadyCode)) return 3;
      Console.WriteLine("KMJ_P720_SERVICE_HOST_STAGE=ZERO");
      Console.WriteLine("KMJ_P720_SERVICE_HOST_BUILD=PASS");
      Console.WriteLine("KMJ_P720_SERVICE_HOST_AGENT_STARTED=NO");
      Console.WriteLine("KMJ_P720_SERVICE_HOST_SERVICE_REGISTERED=NO");
      Console.WriteLine("KMJ_P720_SERVICE_HOST_EXISTING_AGENT=UNTOUCHED");
      Console.WriteLine(NotReadyCode);
      return 0;
    }

    internal static int Main(string[] args) {
      if (args.Length == 1 &&
          String.Equals(args[0], "--self-test", StringComparison.Ordinal)) {
        return SelfTest();
      }
      if (args.Length > 0) {
        Console.Error.WriteLine("KMJ_P720_SERVICE_HOST_ARGUMENTS=REJECTED");
        return 2;
      }
      // SCM attempts will fail closed at OnStart. No undocumented
      // interactive or agent-start command-line mode is supported.
      try {
        ServiceBase.Run(new P720AgentService());
        return 0;
      } catch {
        // No exception message or stack trace is printed.
        return 5;
      }
    }
  }
}
