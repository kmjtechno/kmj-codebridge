# Non-root Git source diagnosis (source-only)

This optional diagnostic supports [issue #652](https://github.com/kmjtechno/kmj-codebridge/issues/652). The owner-installed one-shot service has a pinned helper and currently exits with code 3 (`SOURCE_UNAVAILABLE`). Earlier receipts prove traversal of the checkout and basic visibility of Git metadata, **not** readability of the referenced commit object.

`scripts/production/diagnose-development-nonroot-git.mjs` is a **separate, uninstalled, non-privileged diagnostic**. It is not a replacement for the pinned Python helper, not a root installer, and not a 24x7 worker. GitHub merging this source does not activate any VPS functionality.

## Safety contract

- Runs only as the dedicated `kmjdevci` account, never as root; no caller arguments, repository, branch, shell or environment override.
- Uses the fixed `/usr/bin/git` executable and fixed Main Platform checkout; invokes only `rev-parse --verify HEAD`, `cat-file -t HEAD` and `rev-parse --verify HEAD^{commit}`.
- Git runs with an empty inherited environment, disabled lazy fetch, disabled interactive prompts, disabled optional locks, no replacement objects, a bounded timeout and bounded output.
- Emits only status categories, never raw stderr, object IDs, repository file contents, credentials or arbitrary paths.
- Does not alter filesystem permissions, project files, service units, Git configuration, production or credentials.

The three checks intentionally distinguish a readable HEAD reference from an accessible commit object. A successful ref check alone is insufficient to declare the service ready. The `UNSAFE_OWNERSHIP`, `ACCESS_DENIED`, `REPOSITORY_UNAVAILABLE`, `OBJECT_UNAVAILABLE`, `TIMEOUT` and `OTHER_FAILURE` categories are clues, not permission to modify ownership.

## Activation remains separately gated

Before any host use, the owner must independently review and verify the exact source digest, available Node runtime, target identity, and approved execution path. Do not install this as a root-owned service or modify the existing pinned helper/unit. A bounded diagnostic result should be recorded in a CodeBridge-readable receipt through an independently approved mechanism; raw Git errors must never be uploaded.

The original root-attested one-shot service must pass a real systemd test and owner-reviewed signed agent canary/rollback before further activation. A working zero-paid, explicitly consented local model and lease-bound isolated patch/test/review/recovery proof are additional independent prerequisites for autonomous coding.
