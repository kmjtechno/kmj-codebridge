# Windows Supervisor — Rust/Cargo OmniDesk verification

**Status:** source feature pending exact-head CI and owner-managed installation. No local P520 supervisor has been installed or activated by this change.

The native Windows Supervisor previously supported CMake-only verification projects. `rustProjects` is a distinct, operator-configured profile for fixed Cargo quality gates, using the existing nonce+HMAC protected Windows named pipe and exact 40-hex commit-SHA isolated Git worktrees.

## Opt-in operator configuration

An administrator may add one entry to a separately reviewed supervisor configuration, after confirming the actual trusted paths on the owner workstation:

```json
{
  "rustProjects": [
    {
      "id": "kmj-omnidesk",
      "repoRoot": "E:\\KMJ\\KMJ OmniDesk",
      "worktreeRoot": "E:\\KMJ\\CodeBridge-OmniDesk-QA",
      "gitExe": "C:\\Program Files\\Git\\cmd\\git.exe",
      "cargoExe": "C:\\Users\\EXAMPLE\\.cargo\\bin\\cargo.exe",
      "cargoHome": "C:\\Users\\EXAMPLE\\.cargo",
      "rustupHome": "C:\\Users\\EXAMPLE\\.rustup",
      "allowFetch": false
    }
  ]
}
```

**Example only:** do not copy placeholder user paths. All executable, environment and workspace paths must be inspected and pinned by the P520 operator. Validate the complete config through the strict Windows schema before installing a supervisor. The native supervisor installer prepares a **disabled** task and proposed agent config; activation is a separate, reversible owner approval after existing-agent health, token ACL, user identity and task collisions are checked. Do not install duplicate agents or overwrite an enrolled `agent.json`.

## Allowlisted stages

Only these stage names are accepted for `rustProjects`, under an explicit `project_verify_stage` request with the exact prepared SHA:

- `fmt`: `cargo fmt --all -- --check`
- `clippy`: `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- `test`: `cargo test --workspace --all-targets --all-features`

Each executes with a fixed operator-reviewed Cargo executable, no shell, fixed argv, time and output bounds, and a receipt with SHA/exit status/duration/log SHA. The caller cannot supply arbitrary argv, directories, environment, executable paths, task names or scripts. `allowFetch` defaults to false, so no repository network operation is presumed. `configure`, `build` and `ctest` remain CMake-only; `fmt`, `clippy` and `test` remain Rust-only.

The original checkout, including any owner-edited `Cargo.lock`, is never reset, cleaned, switched or written by a `project_verify_*` operation. Cargo may execute trusted repository build scripts and tests inside the **separate worktree**, which is not an OS sandbox. Review source provenance and local dependencies before enabling this on a workstation.

## Release acceptance

1. Source PR exact-head GitHub Windows/Ubuntu CI and negative-operation tests green.
2. Trusted reviewed CodeBridge release staged outside the active development checkout; active agent identity and original credentials unchanged.
3. Owner config with verified P520 paths, supervisor token ACL, HMAC pipe and disabled-task dry-run.
4. After separate owner activation, authenticated `supervisor_status` shows `windows-native` for `kmj-omnidesk` (mere task existence is not success).
5. Exact SHA worktree prepared; `fmt`, `clippy`, `test` receipts verify; original dirty `Cargo.lock` hash unchanged.
6. Account `connection_overview` still `READY` on `kmj-kmj-omnidesk-desktop-5fvjmet`; no P720 or other project permissions changed.

**Boundary:** this does not install or grant a Supervisor automatically, replace the existing signed updater, grant unrestricted Windows commands, provide unattended AI coding, satisfy M4 real-network evidence or constitute an OmniDesk commercial release.
