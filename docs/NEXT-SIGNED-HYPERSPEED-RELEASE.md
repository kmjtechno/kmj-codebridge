# Next signed CodeBridge release — HyperSpeed acceptance ledger

Status snapshot: **16 November 2026**. This is a proposed release scope, not a
claim that a new signed sequence has been created or deployed. The owner
allocates the next monotonic sequence only after exact-head CI and independent
signing. Current live KMJ-elite gateway is signed Seq29
`0.3.2-e8c353dc839a`, with prior signed rollback
`0.3.2-f2a18a1feb0a` in the bounded release history.

## Release candidates and honest state

| Workstream | Verified source or prior evidence | Mandatory end-to-end gate |
| --- | --- | --- |
| Safe worktrees | PR #990 merged main, condensed untracked status; this PR makes gate preflight consistent | P520 installed signed version exposes read-only `worktree_lane_diagnose`; inspect all dirty lanes without reset, prune or cleanup; authorize a **fresh** isolated lane |
| Free cloud-only coding | PR #989 merged; PR #991 independent zero-cost evaluation is under review | Protected account-specific zero-charge route attestor; quota + no-paid-fallback proof before task claim and POST, explicit proxy and external source transfer grants, live lease-to-patch-to-tests-to-PR and restart recovery; **no local LLM** |
| Native Windows Supervisor | Existing-only ACL-restricted onboarding source exists; current P520 reports `WINDOWS_PIPE_NOT_CONFIGURED` | Validate task/pipe ACL and exact enrolled device SID, signed runtime, one authorized benign call; no duplicate agent or general root shell |
| Non-root HyperSpeed workers | Event-driven journal wake exists; task queue at snapshot 37 queued, 8 waiting, 0 running; actual P520 concurrency is 1 | Explicit opt-in worker start, signed entitlement/CPU/RAM/disk limits, bounded task lease, exact SHA and worktree gates, on-disk checkpoint, crash/restart recovery, no silent PR merge |
| Native GitHub | Separate authorized GitHub connector works; gateway-held CodeBridge GitHub doctor reported authorization failed | Operator repairs fixed exact-repository grant without exposing tokens; native read **and** write verified in the same gateway |
| Artifact hash evidence | PRs #987 and #988 added opt-in source-only receipt generation; no approved profile emits it yet | Signed, bounded profile integration; inspect safe SHA-256 receipt after a real gate; no secret/build path escape |
| Browser and cross-chat work | Read-only Chrome QA, coordination mailbox and handoff tools exist | Fixed-origin account approval for sensitive clicks/types, safe negative cases, bounded mailbox archive/readback, no automatic inactive-host-chat wake |
| One-click provider/device control and premium UI | Requested feature direction, **not** attested by this source review | Explicit authenticated UI QA, approvals, zero-cost routing and screenshots on P520 + live public surface, no duplicate device enrollment |
| Rootless backup/health | Three approved KMJ-elite read-only profiles returned fresh local backup and unit PASS receipts | Preserve exact fixed grant scope; independently prove offsite restore separately, never extrapolate local status into recovery PASS |
| Release / rollback | Signed Seq29 history and owner scripts exist; one-command release source PR #983 was merged | Exact full-commit CI Linux/Windows + clients/distribution/registry; trusted owner offline key and monotonic signed manifest; protected canary, before/after tool schema, rollback probe and explicit operator GO |

## HyperSpeed execution contract

1. **Change-triggered admission:** on task journal updates, wake already
   running and independently approved workers; maintain a bounded poll only
   for lease expiry or job completion. Never turn a simple roadmap task into
   an executable command.
2. **Real capacity:** hard-cap parallel projects/jobs by signed entitlements,
   live runner limits and resource pressure. A one-slot P520 stays one-slot.
   Parallelize read-only inspections and non-overlapping *authorized* lanes,
   not private writes, paid models or unverified providers.
3. **Fast preflight, not unsafe preflight:** treat any untracked file/directory
   as dirty while avoiding enumeration of large generated trees. Refuse
   stale HEAD, invalid Git links, over-quota lanes, ambiguous files and
   unsafe patches. Preserve all existing dirty owner worktrees.
4. **Verified free cloud only:** no local inference, provider guessing,
   pay-as-you-go fallback or transfer of private source without a protected
   account-level no-charge attestor and exact owner consent.
5. **Real completion:** record accepted task lease -> correct isolated head ->
   source edit -> deterministic QA -> reviewable PR + CI -> checkpoint/recovery.
   Never call task queue depth, worker loop start, source merge or CI alone
   proof of unattended autonomous engineering.
6. **Measure, don't advertise:** compare observed end-to-end task latency,
   queue-to-claim delay, tests per useful fix, wasted retries, CI outcomes,
   actual concurrent running jobs and provider spend against a recorded
   baseline. No marketing throughput claim without a repeatable receipt.

## Release HOLD conditions

Keep commercial/production readiness **HOLD** whenever a mandatory tool is
missing on the installed signed agent, any independent provider/restore/security
attestation is absent, CI is incomplete, owner consent is missing, or the
rollback release cannot be shown healthy. Merging this documentation or the
bounded gate preflight fix does not change production, start workers, rotate
secrets, trigger paid CI or authorize future root actions.

A missing feature can be included as disabled/review-only source in a signed
successor, but it must remain accurately labelled **SOURCE_ONLY** until its
real host proof and owner activation gates pass.
