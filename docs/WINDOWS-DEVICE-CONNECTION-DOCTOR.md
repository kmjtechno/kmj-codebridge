# KMJ CodeBridge — Local Windows device connection doctor

This is a **read-only first step** before running an approved reconnect or owner-browser pairing flow. It does not grant access, execute a project command, run calibration, repair installation, install prerequisites, restart a process, alter Git, or read/expose enrollment secrets.

## One-click status

On the **Home Office PC** open the updated, trusted CodeBridge checkout and double-click:

`scripts/windows/CHECK-HOMEOFFICE-CODEBRIDGE.cmd`

On the separately enrolled **P720** use:

`scripts/windows/CHECK-P720-CODEBRIDGE.cmd`

These launch the same local diagnostic with different fixed, non-interchangeable expected device identities and private configuration locations. It does **not** copy a Home Office credential to P720 or vice versa. Use files from a reviewed CodeBridge checkout; do not download a standalone script from an untrusted source.

Only copy/share the **key=value status markers**. Never upload `agent.json`, `enrollment.json`, access tokens, raw environment variables, process command lines, or private directories.

### What the output actually means

- `DEVICE_HOST_MATCH=YES`: the Windows computer-name hint matches the selected known identity. This alone is **not authenticated gateway device registration**.
- `PRIVATE_CONFIG=PRESENT`: an ordinary `agent.json` was observed at the **standard expected location**. A legacy enrollment stored elsewhere can exist; `NOT_FOUND` is not proof that the device was never enrolled. File contents are never read.
- `LOCAL_AGENT_PROCESS=ONE_CANDIDATE`: a matching Node command line was seen on the local machine. The gateway may still reject it; this is not proof of an authenticated session.
- `LOCAL_AGENT_PROCESS=MULTIPLE_CANDIDATES`: stop and review duplicate candidate processes before starting anything. This doctor never kills one.
- `TRUSTED_CODEBRIDGE_RUNTIME=TRUSTED_DIRTY_PRESERVED`: expected Git origin; tracked changes exist and are **not** reset or cleaned. This observation does not approve running modified runtime code.
- `GATEWAY_AUTHENTICATED=NOT_VERIFIED`: only the authenticated CodeBridge `connection_overview` / `connection_doctor` after owner approval can prove connection state.

### Recommended next steps

If the diagnostic shows `USE_APPROVED_RECONNECT_LAUNCHER`, the existing CodeBridge checkout has these separate, guarded actions:

- Home Office: `scripts/windows/CONNECT-CALIBRATION-PRO.cmd` (existing enrollment only).
- P720: `scripts/windows/CONNECT-P720-CODEBRIDGE.cmd` (existing enrollment only, pinned runtime checks).

If Home Office reports `USE_OWNER_APPROVED_PAIRING_LAUNCHER`, there is also `scripts/windows/PAIR-HOMEOFFICE-CALIBRATION.cmd` for an intentional first-time browser-approved grant, provided the correct Windows host and prerequisites are verified. Do **not** pair anew just because a known, existing private enrollment was stored outside the standard location; inspect the approved legacy reconnect workflow first. P720 never uses Home Office pairing.

If a process candidate exists, first verify CodeBridge's **authenticated account-side** `connection_overview`. The doctor only observes local process metadata without showing PIDs or command lines. An offline gateway cannot be repaired remotely by merging a PR.

## Validation and boundaries

GitHub Windows CI exercises PowerShell's negative-scope `-SelfTest`. Static tests ensure the doctor contains no credential file reads, process changes, downloads, token exports or service operations. These tests do not prove that a real customer's Windows PC, Git toolchain, GPU/camera, SDKs, code editor or enrolled agent is working. No additional paid infrastructure is used.
