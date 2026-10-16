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
images, uncaught JS exceptions, and horizontal overflow. Screenshots reside
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
