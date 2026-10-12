# KMJ CodeBridge — On-demand local Autopilot draft with durable checkpoint

This slice connects the **existing** project Autopilot task journal to the **existing** offline local model client without paid model APIs. An administrator queues and claims a task using `autopilot_enqueue` and `autopilot_claim`; then an execute-authorized chat calls `autopilot_local_draft({device,project,task,model,localProcessingApproved:true})`.

The agent verifies the task belongs to the authorized project and is in `running` state, sends at most 3000 characters of its redacted objective to the owner-installed local Ollama instance at loopback, receives bounded untrusted text and atomically stores it with `autopilot.checkpoint`. A retry with an already saved local draft reuses the checkpoint **without running the model again**, reducing unnecessary inference. Failures never complete tasks or update project files.

No shell, Git commit, model download, third-party cloud, paid API, public prompt sharing, arbitrary project reads, or automatic source edits. This is an **AI planning/drafting step**, not yet an autonomous coding agent: use normal expected-SHA CodeBridge guarded edits, authorized worktree grants and configured quality gates to implement, test and complete tasks.

**Important**: Actual model availability is still dependent on an installed, local Ollama runtime; the agent does not install one. Checkpoint state is durable across agent restarts; callers should review and authorize subsequent changes explicitly. Existing project permissions, signed entitlement and audit trail remain the enforcement boundaries.

Quality verification: `npm run check && npm test` including mocked local inference, strict execute-scope, failure and replay tests. End-to-end hardware inference needs a separately verified local model.
