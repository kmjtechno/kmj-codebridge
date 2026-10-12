# Windows P720 native CodeBridge / logo doctor

When CodeBridge reports `GATEWAY_REGISTRATION_MISSING` for the authorized P720 CodeBridge device but other devices remain `READY`, do not reconnect the ChatGPT OAuth session or interfere with the separate CineCore agent.

On the existing **trusted Windows CodeBridge checkout**, double-click `scripts/START-P720-CODEBRIDGE-DOCTOR.cmd`. The bundled PowerShell script checks the pinned repository origin, branch/HEAD, tracked changes, Node 24 availability, recognized CodeBridge service names and the SHA-256 of the existing approved ChatGPT/Claude icon and optional local Codex-plugin copy.

It **does not** read or display credentials, install packages, modify files, run a root shell, fetch code, restart any process, enroll/revoke devices, rewrite plugin icons or make network calls. Results are printed as safe key/value fields. Only share those fields, never private `agent.json`, pairing files or tokens.

- `localIconMatchesSource=STALE_DIFFERENT_BYTES`: local cached installation does not contain the current approved icon. Refresh via the official validated installer after backing up the existing installation; **do not replace artwork**.
- `liveChatGPTIcon=NOT_VERIFIED_EXTERNALLY`: local bytes cannot prove what the installed ChatGPT app listing displays; authorized marketplace publishing/refresh and visible app validation remain necessary.
- `agentServiceStatus=NOT_FOUND`: may reflect an interactive agent rather than a Windows service; check the approved launch task and local agent diagnostics without modifying customer projects.
- `agentGatewayRegistration=NOT_VERIFIED_LOCALLY`: call CodeBridge `connection_overview` and validate the existing enrollment at the intended Main Platform/gateway through an approved scoped diagnostic tool. No credential is transferred into chat.

**Not a self-healing deployment:** CodeBridge source merged to GitHub does not automatically update an offline P720 agent. Do not alter the independent CineCore device or swap its enrollment with this device.
