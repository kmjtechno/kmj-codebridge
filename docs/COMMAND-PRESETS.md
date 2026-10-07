# Structured command presets

KMJ CodeBridge keeps project command execution **administrator controlled**. AI clients never submit a raw shell, executable, working directory, environment, timeout, or arbitrary argv.

A project may opt into fixed built-in presets with `commandPresets`. Presets expand during agent configuration validation into the same exact structured command profiles used by `run_project_command`.

Supported presets:

- `node-standard` — locked dependency install plus common test/build/check/lint/typecheck, formatter, and bounded cancellable dev variants.
- `python-standard` — requirements install plus pytest and compile verification.
- `cargo-standard` — locked check/build/test/clippy/format-check plus formatter.
- `go-standard` — test/vet/build plus formatter.

Example:

```json
{
  "id": "project1",
  "root": "/srv/project",
  "writable": true,
  "gates": {},
  "commandPresets": ["node-standard"],
  "commands": {}
}
```

Presets are opt-in. They do not inspect package metadata, execute automatically, or turn repository scripts into new permissions. An explicit administrator command with the same profile ID overrides the preset. Runtime execution remains project-root confined, bounded by the job runner, cancellable, redacted, audited, and subject to the existing risk policy.

No preset exposes `sh`, `bash`, PowerShell, `cmd`, or a generic terminal. Repository scripts can still execute project code when the administrator explicitly enables the relevant preset/profile, so untrusted repositories should remain read-only or use stricter isolation.
