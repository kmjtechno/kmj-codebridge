# P720: owner-private enrollment boundary and headless Windows agent plan

Status: **LOCAL SERVICE PRIVATE-CONFIG BLOCKED; active agent untouched**.
This document is a migration specification, **not** an installer, credential
migration, or authorization to stop the live agent.

## Physical evidence

The owner ran SHA-pinned `RUN-P720-LOCALSERVICE-CANARY.ps1 -Apply` from
CodeBridge main `833119771d03e6fc08ac244df7acac9780086b34` on an elevated
P720 PowerShell session (2026-10-18). The bounded LocalService-authored
receipts and the controller agreed:

```text
KMJ_P720_LOCALSERVICE_CANARY_START_RECEIPT=True
KMJ_P720_LOCALSERVICE_CANARY_SCHEDULER_STARTED=True
KMJ_P720_LOCALSERVICE_CANARY_TASK_STATE=Ready
KMJ_P720_LOCALSERVICE_CANARY_SCHEDULER_RESULT=23
KMJ_P720_LOCALSERVICE_CANARY_RESULT_RECEIPT=AGENT_CONFIG_NOT_READABLE
KMJ_P720_LOCALSERVICE_CANARY_FILES_AND_PUBLIC_TLS=NOT_VERIFIED
KMJ_P720_LOCALSERVICE_CANARY_TASK_CLEANUP=REMOVED
KMJ_P720_LOCALSERVICE_CANARY_STAGE_CLEANUP=REMOVED
KMJ_P720_LOCALSERVICE_CANARY_AGENT_MUTATIONS=NONE
KMJ_P720_LOCALSERVICE_CANARY_TAKEOVER=NOT_PERFORMED
LOCALSERVICE_CANARY_V2_EXIT=3
```

This **proves the LocalService process started** and could not open the
existing owner-private `agent.json` under its process token. It does not
distinguish absent path from filesystem permission failure under that token,
although the preceding owner-scoped preflight verified that the configuration
path exists. The private token/supervisor lock checks and outbound HTTPS
were **not reached** and must not be called FAIL or PASS. The existing
live CodeBridge agent and disabled S4U task were not changed.

CodeBridge's `agentSchema` currently contains `token: z.string().min(32)`
alongside its `gateway`, `id`, and `stateDir` fields. This agent
configuration is a credential-bearing resource. It must not become readable
by a broadly shared built-in account merely to turn a canary green.

## Decisions

**Hard rejects for existing enrollment takeover:**

- Do not add LocalService, NetworkService, Users, Everyone, or Authenticated
  Users to the *existing* `agent.json`/private token/agent state ACL.
- Do not copy the existing owner enrollment token to a second identity,
  print secrets, allow a hidden secondary agent session, or modify the
  existing disabled `KMJ-CodeBridge-P720-Agent` task to avoid the block.
- Never run existing `S4U` agent task: Windows Task Scheduler documents
  that S4U tasks lack network and encrypted-file access.
- Do not run previous `-Apply` canary again: it already proved the relevant
  private-config boundary under LocalService.
- Do not treat `NetworkService` or `LocalSystem` as automatic drop-in
  replacements. NetworkService can present the computer identity to network
  servers and shares its account context with other services.

**Preferred 24/7 architecture (requires new implementation and approval):**

1. Select a *dedicated and isolated* Windows service identity after
   checking whether the P720 is domain joined and which Windows service
   mechanisms are actually supported. A virtual service identity, where
   supported, belongs to an installed service; a Scheduled Task named like
   that service is not itself a Windows Service. An ordinary dedicated local
   user with password logon is another option, but the credentials must be
   obtained locally by Windows security APIs, never in ChatGPT, source,
   GitHub, console output, arguments, or logs.
2. Build a separately verified service host that can receive stop/shutdown
   notifications and restart automatically. Use a **new** fixed private state
   and config directory with ACLs restricted to its precise service SID or
   dedicated account; no inheritance from permissive machine-wide
   groups. Check trusted runtime source SHA and the full service action.
3. Perform **new or formally rotated, operator-approved enrollment** into
   the service identity's own credential store. Do not simply import the
   current user's bearer token. Verify the gateway's device-identity,
   license/seat, and no-duplicate-ownership policy before this operation.
4. Implement a single-device lease/fence against simultaneous agent
   sessions; idle all active work and preserve the original owner-owned
   process/config/task in a rollback manifest before any promotion.
5. Prove the managed identity can read its *own* new enrollment and fixed
   supervisor HMAC channel, write only its own state directory, and reach
   the outbound gateway. Observe a **fresh server-side authenticated
   heartbeat** from the intended identity, not a local file or an
   unauthenticated public HEAD.
6. Switch ownership only through a reviewed transactional handoff.
   On timeout, credential rejection, duplicate lease, unavailable network
   or service crash, rollback to the original agent and verify heartbeat.
   Fail closed if rollback cannot be proved; never leave both active.
7. For production readiness, test cold boot with no user logged in,
   logout/re-login, power interruption recovery, update/rollback and loss
   of the network. Keep CineCore's distinct enrolled agent and its dirty
   development checkout out of this transaction.

**Conditional lower-scope fallback:** A new disabled
`InteractiveToken` task under the current user may work while that user
is logged on, without copying the existing secret. It is **not 24/7
headless**, must not replace the requested always-on deployment, and
requires independent heartbeat and reversible single-owner cutover.

## Current disposition

- Owner's Live CodeBridge/CineCore agents: keep online and untouched.
- Existing `KMJ-CodeBridge-P720-Agent` task: stay **Disabled** (S4U).
- Original LocalService canary: **inconclusive timeout**, superseded.
- Receipt-based LocalService canary: **blocked at existing agent.json**,
  with complete temporary task and stage cleanup.
- Production managed service: **NOT INSTALLED**, fresh gateway heartbeat
  and rollback unverified.
- Only a reviewed source/CI gate may be merged now; physical migration
  requires local Windows administrator approval and credential-safe
  enrollment. These steps cannot be asserted through GitHub CI alone.

## Microsoft references

- [Task Scheduler logon types](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)
- [Windows service user accounts](https://learn.microsoft.com/en-us/windows/win32/services/service-user-accounts)
- [Windows service accounts and virtual identities](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-service-accounts)
- [NetworkService account](https://learn.microsoft.com/en-us/windows/win32/services/networkservice-account)

Related: #393; source changes #526, #527, #528, #530, #531.
