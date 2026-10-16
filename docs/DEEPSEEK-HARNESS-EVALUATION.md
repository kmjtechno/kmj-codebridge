# DeepSeek Harness evaluation — KMJ CodeBridge native extension seam

Research source: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
[architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md),
[tool execution](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md),
[safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md).
Source license: MIT; CodeBridge implementation below is original JavaScript, not
vendored DeepSeek source.

DeepSeek Harness is an experimental Cordis plugin-based agent runtime. Its
developer-preview safety notice explicitly says it is not audited or ready
to secure untrusted workloads. **Do not install dsh in production CodeBridge,
replace our MCP authorization, or expose unrestricted shell / filesystem /
credential privileges to AI plugins.**

## First integrated slice: monotonic reversible tool guards

- `src/tool-guard-host.js` provides a trusted **in-process** extension point
  with project-scoped registration, disposal and fixed insertion order.
- The pre-execute hook receives only frozen, non-sensitive identity and access
  facts: device, project, tool, access, writable. No arguments, tokens, paths,
  prompts, model outputs, configuration or credential objects are exposed.
- A hook can allow or veto. Allow **never** bypasses CodeBridge OAuth,
  device/project permission, license, command allowlists or the existing
  audit ledger. Plugin failures and invalid verdicts deny execution.
- `startAgent` installs the native read-only project write guard, and
  `createDispatcher` runs it **after** the existing authorization checks.
- Unloading a guard does not erase core CodeBridge authorization; it releases
  only that guard's own registration. There is no arbitrary third-party code
  loader, live profile patching or dependency on Cordis in this slice.

## Future candidates, not claimed as implemented

1. Durable turn/step/tool **event projection** with privacy-safe replay and
   versioned storage. Integrate with the existing audit/Autopilot journals;
   do not dump prompts or secrets to a new session store.
2. Profile overlays for agent/model/tool capabilities with explicit signed
   configuration, scope isolation and atomic activation/rollback.
3. Multi-agent DAG compare-and-set revisions and overlapping write-scope
   warnings atop existing worktree lanes, before expanding parallelism.
4. Provider capability adapters, model-budget accounting and compaction
   consistent with ModelFabric's cloud consent and free-first rules.
5. Approval lifecycle hooks with non-replayable approval receipts, explicit
   cancellation and sandboxed subprocess isolation; not an all-access shell.

Each candidate needs isolated tests, an authorization/security review, exact
Windows + Ubuntu CI and measured deployment proof before release.
This change does **not** activate the currently unavailable P720 supervisor,
replace an agent runtime, enable background AI chats or merge any unreviewed PR.
