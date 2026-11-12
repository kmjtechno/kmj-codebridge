# Roadmap → autopilot: continuous work without re-reading the roadmap

The roadmap is compiled **once per roadmap version** into a persistent
autopilot mission. After that, any AI chat (ChatGPT, Claude, Claude Code) or
opt-in worker only asks the queue for the next dependency-ready task.

## 1. Compile the roadmap (once per roadmap version)

```sh
node scripts/roadmap-mission.mjs --project kmj-codebridge --device p520 > mission.json
```

Pass the JSON fields to the `mission_compile` tool. The mission key is
`roadmap-v<document_version>`, so compiling the same roadmap again is
idempotent; bumping `document_version` creates the next mission. Completed
phases are skipped; each open deliverable becomes one task and each phase gets
an `<id>.accept` review task that depends on its deliverables.

## 2. Work loop for every chat or worker

1. `autopilot_claim` (with a `holder` label such as `chatgpt-2026-11-12`) →
   returns the highest-priority ready task and a `leaseToken`.
2. Do the work with normal CodeBridge tools (small PR, exact-SHA CI).
3. `autopilot_checkpoint` at least every 20 minutes so the lease stays alive.
4. Finish with `autopilot_complete`, or `autopilot_wait` with the reason when
   an owner action (signing, deploy, DNS, money) is needed. Waiting tasks never
   block unrelated ready work.
5. Immediately `autopilot_claim` again. Stop only when nothing is ready.

If a chat disconnects, its lease expires and the next claimer resumes the task
from the last checkpoint.

## 3. Keeping work going when no chat is open

A server cannot wake a ChatGPT or Claude conversation; chats only run when a
message arrives. Two supported ways keep the queue moving:

- **Scheduled session** (for example a Claude scheduled task every hour) with
  this prompt:

  > Use KMJ CodeBridge on device p520, project kmj-codebridge. Run
  > `autopilot_claim` with holder `scheduled-<date>`, complete the task under
  > the rules in docs/AUTOPILOT-ROADMAP.md, checkpoint regularly, then claim
  > the next ready task until none is ready or 50 minutes have passed. Never
  > deploy, sign, change DNS or spend money; use `autopilot_wait` for those.

- **Opt-in local workers** already documented in
  [AUTOPILOT-LOCAL-WORKER.md](AUTOPILOT-LOCAL-WORKER.md) and
  [AUTOPILOT-GATE-WORKER.md](AUTOPILOT-GATE-WORKER.md).

This gives continuous progress without promising an always-on chat, and
without unrestricted shell or root access.
