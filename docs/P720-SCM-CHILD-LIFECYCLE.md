# P720 SCM host Stage 1: fixture-only child lifecycle

This is a **safe process-supervision test harness**, not a running CodeBridge
agent, service installer or production takeover. The fixed Windows ServiceBase
`OnStart` still throws `BLOCKED_UNVERIFIED_TAKEOVER`. The user's real
CodeBridge and CineCore agents, dirty worktrees, disabled S4U task, enrolled
credentials and native Supervisor are **never accessed or modified**.

## What is implemented

`P720ChildLifecycleFixture.cs` starts **only a copy of its own compiled
Stage-0 service host** with the fixed `--fixture-child` argument. The fixture
has no project or gateway awareness and reads no credentials. It emits a fixed
ready marker, accepts `STOP` on redirected stdin for graceful exit, or
`HOLD` to simulate a child that does not shut down within the deadline.

The parent explicitly tracks the exact `System.Diagnostics.Process` it
created. It verifies the ready marker with a bounded wait, waits up to
8 seconds for graceful exit, and tests a 400 ms timeout branch. Only that
parent-owned **fixture** process may be terminated if it is unresponsive;
the test must never enumerate Node processes or stop any existing agent.
No process command line, username, token, file path or stderr is printed.

The existing dry-run-by-default
`scripts/windows/BUILD-P720-AGENTSERVICE-STAGE.ps1` now includes the
fixture in its C# compilation and requires both:

```text
KMJ_P720_SCM_HOST_GRACEFUL_FIXTURE=PASS
KMJ_P720_SCM_HOST_TIMEOUT_FIXTURE=PASS
KMJ_P720_SCM_HOST_SERVICE_REGISTERED=NO
KMJ_P720_SCM_HOST_SERVICE_STARTED=NO
KMJ_P720_SCM_HOST_PRODUCTION_READY=NO
```

Windows CI compiles and runs the harmless fixture, and Ubuntu CI verifies
that no real agent or SCM mutation path was introduced. The compiled Stage-0
host still fails closed on any actual SCM startup. No unattended agent
startup has been added or claimed.

## What Stage 1 does not prove

This is not yet a production child supervisor. Real agent shutdown requires
a cooperative IPC protocol and job drain, separate service identity and
fresh authorized enrollment, safe single-device fencing, server-observed
authenticated heartbeat, rollback under failures, and cold-boot validation.
The fixture's `Kill` is a test-only cleanup of its own child and is
**not** permitted as normal process termination of the existing P720
CodeBridge agent.

No `-Apply` or service installation is present. Do not manually register
or start the Stage-0 executable as a production service.

See [P720 Windows SCM service host](P720-WINDOWS-SCM-SERVICE-HOST.md),
[private enrollment boundary](P720-PRIVATE-ENROLLMENT-BOUNDARY.md)
and [issue #393](https://github.com/kmjtechno/kmj-codebridge/issues/393).
