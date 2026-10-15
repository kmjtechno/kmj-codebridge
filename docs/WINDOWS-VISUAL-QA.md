# Windows desktop visual QA — opt-in project command

CodeBridge supports the `windows-visual-qa` **operator-approved preset**.
It is for already-authorized Windows project roots only. No project is enrolled
or granted access by selecting this preset.

## Configuration

The administrator first reviews `scripts/codebridge-ui-qa.mjs` **within the
approved product repository** and chooses to enable it:

```json
{
  "id": "kmj-omnidesk",
  "root": "C:\\path\\to\\kmj-omnidesk",
  "writable": true,
  "gates": {},
  "commandPresets": ["cargo-standard", "windows-visual-qa"]
}
```

Then `list_project_commands` exposes the exact `windows_visual_qa` variants:

- `capture` — run the product-owned script's bounded native-window capture
- `compare` — run the product-owned screenshot/baseline comparison
- `accessibility` — run the product-owned UI Automation/accessibility audit

Invoke `run_project_command` with a previously approved device/project,
`profile: "windows_visual_qa"`, and one of those fixed variants. Review the
returned job receipt and use `get_job_status` to obtain the result.

## Safeguards and truthful QA

- The command profile runs `node scripts/codebridge-ui-qa.mjs <fixed variant>`
  **inside the authorized project root** with a 120-second timeout. It never
  accepts executable paths, shell strings, arbitrary argv, or external URLs.
- It cannot bypass Windows user-session isolation. Running in a Windows
  service/session 0 cannot prove that an operator desktop rendered correctly.
  A headless `UNVERIFIED` screenshot is not a visual PASS.
- UIA/FlaUI are optional research references, not injected into customers'
  runtime. The authorized project script remains responsible for the actual
  capture/test and all subprocess authorization.
- Store local screenshot evidence only in the approved project's artifact
  directory. Upload or share only with explicit operator direction. Redact
  remote-session content and private device names before external publication.
- Compare the approved 1419×611 OmniDesk main-window reference, not the
  separate marketing-banner image. Review 100/125/150/200% DPI and dynamic
  disconnected/permission/connected states separately.
- A screenshot and pointer test do not prove authenticated internet
  connectivity, relay behavior, M9 commercial signing, or public release.

**Important:** CodeBridge does not yet provide an unrestricted computer-use
session or interactive desktop API. This preset is a bounded, auditable
integration point for each product's own Windows UI QA runner.
