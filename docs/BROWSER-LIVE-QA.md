# CodeBridge live browser QA

The CodeBridge browser_qa_start MCP tool starts an anonymous, fixed-origin real
Chrome smoke for the already-authorized kmj-main-platform project. It returns
an ordinary CodeBridge job ID immediately; read tools and work on other devices
can proceed while the browser job runs. The free-plan device execution limit
remains one slot per agent; excess jobs queue rather than secretly bypassing
concurrency or licensing.

Only the kmj_public target is supported: https://kmjtechno.com/, /products,
and /login. No user URLs, arbitrary script, keyboard/form input, credentials,
payments, admin actions, or screenshot uploads are accepted. Chrome runs with
an ephemeral profile and remote-debugging pipe (never an exposed port).
Linux root is refused rather than disabling browser sandboxing.

Each run captures public pages at 1440, 768, and 390-pixel widths (nine
screenshots). It checks actual navigation, HTTP 200, nonblank text, broken
images, uncaught JS exceptions, and horizontal overflow. Incomplete or undecodable
images fail closed rather than being counted as healthy. The isolated browser
first requests deferred lazy images and waits up to four seconds for load/error
before measurement; images still pending afterward are recorded as failures. Mobile lazy-image
loading has a second bounded 3-second settle phase for _pending-only_ images;
hard-failed or undecodable images still fail immediately. Each sample now
reports safe aggregate `pendingImages` and `failedImages` counts (no URLs,
DOM content, cookies or image bytes). The initial and second windows are
bounded, and pending assets remaining after the deadline are not called PASS.
One failed run followed by two clean runs is evidence of intermittent loading,
not proof that assets are permanently missing or repaired. Screenshots reside
in the CodeBridge agent private state directory, not in the dirty Git checkout.
The browser_qa_receipt tool validates screenshot hashes and returns only
sanitized evidence, not private image bytes, page text, cookies, or secrets.

Minimum activation: merge exact-head green PR, deploy the updated gateway and
agent via an authorized rollback-capable release, confirm Chrome is installed
and a non-root runtime can launch it, discover both new MCP tools, call
browser_qa_start, inspect get_job_status and browser_qa_receipt, and verify
nine screenshots plus final PASS/FAIL. GitHub PR merge is not deployment proof.

The MVP does not claim authenticated Super Admin coverage, arbitrary clicking,
interactive screen control, screenshot retrieval, accessibility audit or a
working live browser if the release is not deployed or Chrome is missing.
Production DNS, website files, licensing and database are never modified.

## Compatibility for a captured ChatGPT command catalog

A connected session may expose `run_project_command` but not the new `browser_qa_start`/`browser_qa_receipt` names. On an authorized writable `kmj-main-platform` device, `list_project_commands` advertises a first-party `browser_public_qa` / `start` command. Call `run_project_command` with `{device,project,command:"browser_public_qa",variant:"start",requestKey}`, then `get_job_status` with the returned job ID. The fixed-origin command uses the **same trusted browser runner, job gate and private receipt path** as `browser_qa_start`. Reusing the request key is idempotent. For terminal browser QA jobs, the already-captured `get_job_status` now also returns `browserQaReceipt`, validated by the **same** project-authorized on-disk SHA-256 verifier as `browser_qa_receipt`. `browserQaReceipt.verified=true` means the returned sample files passed integrity checks; it is **not** an overall visual PASS unless `browserQaReceipt.verdict==="PASS"`. If the evidence is missing or corrupt, the normal job status is preserved and `verified=false` plus a safe error code is returned. Non-browser jobs are unchanged. Direct `browser_qa_receipt` remains available in clients that capture it.

This is **not** a generic tool trampoline, extra worker slot, shell/URL/script override or a way to force ChatGPT to refresh its captured tools. Only the `start` variant and fixed `kmj_public` target are accepted under the existing project authorization. The CodeBridge app registration, OAuth and image branding are unchanged.
