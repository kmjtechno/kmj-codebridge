# P720 temporary CodeBridge pairing (Windows)

The workstation's two Ollama endpoints and their readiness checker are independent of CodeBridge enrollment. The first GPU passed at **33.55 tokens/sec with 4,621,179,288 bytes of offload** in an October 9 user-supplied report; the second Qwen3 4B endpoint initially reported no visible generated text. PR #255 corrected the short-probe request with `think: false`; a real P720 recheck is still required.

## One-time setup

1. Use the trusted main-branch repository at `D:\KMJ-HyperSpeed\projects\kmj-codebridge` (from the existing temporary P720 development workspace). Update the checkout only through a normal clean fast-forward; no forced reset.
2. Double-click `scripts\RUN-P720-CODEBRIDGE-PAIR.cmd`. The helper requires Node.js 24+, git, npm and an NTFS D: workspace; it runs as the current Windows user without UAC elevation.
3. During the process, follow the short-lived **HTTPS pairing URL printed in the window**. Sign in to the KMJ account, inspect the displayed device, project and `read/write/execute` scope and approve. A successful OAuth session is not the same as approving a new device.
4. The helper stores credentials outside the project at `D:\KMJ-HyperSpeed\private\p720-codebridge`, applies current-user NTFS ACLs, starts a local Windows agent process and looks for an authenticated gateway heartbeat. It writes only non-secret status to `D:\KMJ-HyperSpeed\P720-CODEBRIDGE-STATUS.txt`.
5. **Upload the status text only. Never upload the contents of `private`, `agent.json` or `enrollment.json`.** In a separate authenticated ChatGPT session, call CodeBridge `connection_overview` for the newly paired P720 device. Only this account-side check establishes that the project grant is available to the signed-in user.

The starter agent binds **one** approved project: `kmj-codebridge`. It uses the existing `free` license semantics, with one concurrent job at most; it does not create unlimited entitlements. Configured safe execution gates are `check`, `p720_ai_tests`, and `scan_secrets`, with no general-purpose remote shell.

The initial agent runs only for the current Windows session; this is intentionally **temporary**. After reboot, rerun the launcher. Do not install it as a machine-wide auto-start service until tested and approved separately.

### Constraints

- The helper does **not** install models, open firewall ports, start GitHub Actions self-hosted runners, pay for APIs, push/merge, alter production servers, or register paid plans.
- The new source still needs end-to-end pairing on the P720. A static/CI test does not prove the production pairing endpoint or tenant/device grant is configured.
- If credentials already exist, the script reuses them without printing or overwriting. A changed project ID/root or invalid identity fails closed.
- Windows 10 is out of standard support and the P720 is a temporary worker. Keep it patched and limit access to the machine.
- When finished with this temporary workstation, revoke its **device grant** in KMJ Main Platform and then securely remove its local credentials. Merely closing the process does not revoke a token.

See [enrollment contract](ENROLLMENT.md) and [P720 AI readiness](P720-TEMPORARY-WORKER.md).
