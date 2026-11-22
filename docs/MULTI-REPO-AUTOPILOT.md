# KMJ multi-repository engineering autopilot: one fleet read, scoped work

Status: **source-only design and bounded read-only handoff**. This does not
automatically wake an AI chat, run a coding model, grant root, merge PRs,
or deploy a release. It uses the existing CodeBridge queue; do not install
Beads, Gas Town, a second task database or a paid service just to resume work.

## One-call start for any ChatGPT / Claude / IDE session

1. If the owner asks to continue KMJ engineering **across repos**, read
   `fleet_overview({maxProjects:12})` once. Use the new `nextWork.candidates`
   only when that field is present in the signed running gateway. If absent,
   use the existing `lanes[]` + `nextAction` fields; never claim the new
   feature is live because a GitHub PR has merged.
2. Never infer a **global** priority from that read: each project owns its
   priority/mission and an unavailable, blocked, waiting or offline lane is
   not ready. The snapshot may be truncated; each device's signed job slots
   are shared by its project lanes. Check the latest explicit owner priority
   and current running work before selecting an authorized lane.
3. For the selected `{device,project}`, call
   `chat_workspace_open({device,project,lane:"mission-control"})` to resume
   compact session state, then `autopilot_status({device,project,limit:10})`
   to revalidate the exact task, ownership, dependencies and pause/deny rules.
4. When authorized, `autopilot_claim` the next task **once** using a stable
   holder and its existing lease. Reserve overlapping file scopes, work on an
   isolated exact-Git-SHA branch, test with focused and full CI, then save a
   checkpoint plus PR/test identifiers. Call `autopilot_complete` only for
   proven completed scope; otherwise `autopilot_wait` with the exact blocker.
5. Re-read the compact fleet snapshot only when switching projects or after
   a completed milestone. Do not repeatedly scan whole roadmaps if a
   revisioned checkpoint exists. Never create parallel copies of queued
   tasks just because a chat restarted.

## Complex features spanning several repositories

Use one small human-reviewed **feature ID** in the owning repo's spec:
`KMJ-FEATURE-<short-id>`. Store desired behavior, linked repositories,
API/SDK contract, prerequisites, acceptance tests, owner-locked UX/security
decisions and evidence. For example:

- Owning Main Platform: licensing authority, API contract and stable schema
- Client products (OmniDesk/Calibration/CloudOS): compatibility + negative
  tests against the same signed fixture
- CodeBridge: scoped agent tasks, dependency ordering and progress evidence

Represent dependencies in _each authorized project's existing_ mission/task
queue; cross-repo claims are **not** an automatic distributed transaction.
Use GitHub PR links and verified artifact SHAs as evidence. An OpenSpec-like
proposal / spec / tasks layout is useful for large changes, but first pilot
the format on one non-privileged feature without forcing a new CLI or
vendor-owned runtime into every repository.

## Guardrails

- Owner-signed Elite release approval, paid inference, private-source
  transfer, account/customer deletion, migrations, DNS, and hardware
  activation each retain their existing independent gates.
- Active owner pauses (including automatic unverified-account cleanup) take
  precedence over any old queued objective. A paused task must not be
  claimed merely because a stale queue advertises it as ready.
- Multi-repo summaries are advisory. They contain task IDs and project
  scopes, **not objectives, secrets, source files or verified deployment
  claims**. A second `autopilot_status` read is required before a claim.
- If the gateway/agent runtime has not installed this source change, use
  the older fleet output. Never equate CI PASS or signed binary source with
  an actual live feature.

## Definition of done

- Fleet next-work output passes exact-head formatting, security/isolation,
  runner-capacity and gateway integration CI on source PR.
- A signed CodeBridge gateway release is approved and activated separately.
- A live, authenticated `fleet_overview` read actually contains the bounded
  `nextWork` suggestions and does not expose task objectives or exceed
  per-device available slots.
- At least one task in two _distinct, authorized_ project lanes is resumed
  from a checkpoint and linked to CI evidence without duplicate enqueue.
- Measure real run times, CI reruns and extra monetary spend; do not claim
  speedup until compared with a baseline.
