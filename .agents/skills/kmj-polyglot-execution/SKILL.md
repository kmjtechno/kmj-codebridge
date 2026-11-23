---
name: kmj-polyglot-execution
description: Safely inspect, edit, build and test multilingual software projects using explicit toolchain detection, approved CodeBridge command profiles and reproducible verification.
---

# One engineering workflow, project-specific toolchains

Use for coding in unfamiliar languages or mixed stacks. CodeBridge provides a common authorized workflow; it does **not** make every OS, compiler, SDK or hardware target available.

1. Read `project_environment`, `repo_map` and relevant bounded paths. Detect language from manifests and checked-in configuration (for example `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle`, `*.sln`, `*.csproj`, `CMakeLists.txt`, `Package.swift`, `pubspec.yaml`). Do not execute detected hooks or package scripts merely because a file exists.
2. Read `list_project_commands` and `policy_catalog`. Match to an administrator-reviewed, fixed executable/profile with pinned toolchain, worktree, timeouts, bounded logs and least privilege. A missing command is a setup or review task, **not** authorization to run raw shell.
3. For large codebases, use `hyperindex_status` or `repo_map` and `read_files_batch` before expensive scans. Optional LSP, Tree-sitter or ast-grep indexes may be proposed only after version pinning, resource testing and security review; never download or install implicitly.
4. Reproduce a bounded failing test, identify the smallest affected file set, implement hash-guarded changes inside a disposable exact-head worktree, then run focused tests and full project gates.
5. Examples of **candidate profiles**, not granted commands: Node/TypeScript `npm ci && npm test`; Python `python -m pytest`; PHP/Laravel `composer test` or `php artisan test`; Rust `cargo test`; Go `go test ./...`; Java `mvn test` or Gradle; .NET `dotnet test`; Qt/C++ `cmake --build` and `ctest`. Each must be configured separately as an approved profile; never concatenate or execute these example strings from an AI prompt.
6. Windows-specific SDK/Qt/hardware verification runs on an authorized compatible Windows machine. Apple signing requires approved macOS tooling and credentials. HIL and physical device tests require explicit consent and real-device receipts; emulators are labelled as such.
7. Record source SHA, toolchain/OS versions, test command profile, job ID, result, artifact hash and CI PR head. A successful local test never implies production deploy.

**Acceptance:** independently tested reference projects in Node, Python, PHP, Rust, Go, Java, .NET and CMake/Qt where compatible test environments exist; unsupported combinations remain explicit and safe. Compare actual end-to-end timings; do not promise universal compatibility without the matrix.

References: `docs/UNIVERSAL-LOCAL-DEVELOPMENT-ENGINE.md`, `docs/COMMAND-PROFILE-SCHEMA.md`, `docs/ISOLATED-WORKTREES.md`.
