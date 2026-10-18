# KMJ P720 Windows SCM Service Host — Stage 0 (build only)

P720 read-only inventory on 18 Oct 2026:

| Field | Observed |
| --- | --- |
| DOMAIN_JOINED | False |
| WINDOWS_PRODUCT_TYPE | 1 (workstation) |
| SERVICE_NAME_AVAILABLE | True |
| DOTNET_SERVICE_COMPILER_AVAILABLE | True |

This supports compiling a Windows-native `System.ServiceProcess.ServiceBase`
host with the built-in .NET Framework 4.x C# compiler. It does **not**
authorize service installation, credential migration, scheduled-task
activation or takeover of any already-connected agent.

## New source

- `scripts/windows/native-service/P720AgentService.cs` is a real
  Windows ServiceBase entrypoint with the fixed name
  `KMJ-CodeBridge-P720-AgentService`.
- The host's SCM `OnStart` deliberately refuses activation with the
  fixed `BLOCKED_UNVERIFIED_TAKEOVER` code. No Node process start/kill
  behavior or persistent service installer is offered in Stage 0.
- `--self-test` is available solely for a local or hosted Windows
  compilation test; it prints stable non-secret state and exits without
  SCM registration.
- `scripts/windows/BUILD-P720-AGENTSERVICE-STAGE.ps1` defaults to
  **DRY_RUN**. With `-Build`, it compiles the staged executable into a
  new, uniquely named **temporary directory** using the stock
  `Framework64/v4.0.30319/csc.exe`, then runs its self-test.
  The build script does not run `sc.exe`, `New-Service`,
  `Start-Service`, `Stop-Process`, task registration, secret reads,
  ACL changes or Node agent startup.

Windows CI must exercise the PowerShell AST parse, C# compilation
and `--self-test`; Linux CI tests static non-destructive contracts.
**These checks prove only buildability, not service control, startup,
shutdown or operating identity on the physical P720.**

## Important production gates

1. **Build semantics:** choose/verify a Windows service virtual identity
   or a dedicated local account; this machine is not domain joined.
   A virtual identity can be serviced through the SCM only after
   installing its specific service. It is not equivalent to LocalService.
2. **New enrollment:** provision an independently approved service
   enrollment/credential in a new service-private directory. Use the
   `gatewayTokenFile` feature (PR #533); never copy or broaden the ACL
   of the live owner agent's `agent.json`.
3. **Pinned runtime:** verify signed source, Node and agent entrypoint
   hashes, service binary hash and release/identity ownership before
   any installer is enabled.
4. **Graceful stop:** implement and validate a cooperative Windows
   shutdown channel to the agent, including bounded timeout, job
   fencing, exit receipt and cleanup. Do not use blind
   `Stop-Process` or `taskkill` as normal takeover.
5. **Exclusive takeover:** owner-agent idle gate, supervisor-agent
   identity and HMAC, globally enforced lease/fence, original process
   recovery snapshot, no simultaneous sessions of the same device.
6. **Server proof:** fresh authenticated gateway heartbeat from the
   intended service identity after a controlled handoff, not a public
   HEAD probe, Windows service RUNNING state or local lock alone.
7. **Rollback:** verified reversal of service/task states and original
   user's session, including stale-agent/credential rejection and
   loss-of-network cases.
8. **Physical release:** operator acceptance for unattended boot,
   logout, restart/crash recovery and Windows updates. Do not enable
   auto-update until a signed release rollback is proven.

The original owner CodeBridge agent, separate CineCore agent, dirty
project checkout and the disabled `KMJ-CodeBridge-P720-Agent` S4U
task remain **untouched** by this Stage-0 implementation.

**Production ready:** NO.

Related: [P720 private enrollment boundary](P720-PRIVATE-ENROLLMENT-BOUNDARY.md)
and [external bearer support](AGENT-GATEWAY-CREDENTIAL-FILE.md),
[issue #393](https://github.com/kmjtechno/kmj-codebridge/issues/393).
