# Elite activation writer identity: fixed CodeBridge read-only diagnostic

Source-only proposal for [CodeBridge issue #1140](https://github.com/kmjtechno/kmj-codebridge/issues/1140).
This must **not** be advertised as installed, signed, activated, or release-ready merely because CI passes.

## Contract

The root-owned **Main Platform** Supervisor may accept exactly one scoped operation:
`main_platform_writer_identity_inspect` with fixed confirmation
`RUN_FIXED_READONLY_WRITER_IDENTITY_INSPECT`.

The CodeBridge client tool `supervisor_main_platform_writer_identity_inspect`
must be enrolled for **exact** device `kmj-elite-main-platform`, project
`kmj-main-platform`, and its ordinary `execute` permission model. The
Google CloudOS, Elite CloudOS and separate CodeBridge dev Supervisor profiles
must deny this operation.

The script is not discovered from project checkout, environment, GitHub API,
user input, PATH or an uploaded command. An owner-installed root-owned regular
file under `/usr/local/libexec/kmj-main-platform-activation-writer-identity-inspect.py`
is the only executable target. Its SHA-256 must match the reviewed
`kmj-main-platform` PR #971 squash merge
`ae5978be9be9bf62e8da18cd97db4f416e7ca574`:

`1d77f327ac518b39d997c415d9390e0ecdb7d0ae0abc1541f3fc664a789b1d0e`

The script and each ancestor must be root-owned, non-symlink and non-group/world
writable. The file must have one link and executable owner bit. The fixed
command is `/usr/bin/python3 -I -B <fixed path> --inspect`. The Supervisor
re-hashes after execution. Any mismatch, uninstalled path, process error or
unexpected stdout fails closed and never returns arbitrary output, stdout,
stderr, permissions or private path data.

Only 5 exact allowlisted stdout lines are accepted for an inspect success.
Even then, the result is **`READY_FOR_OWNER_REVIEW_NOT_INSTALLED`**, not
production release approval or a signed broker installation.

## Owner installation and signed release boundary

This source PR does **not** install the script or register it on any existing
live Supervisor. After independent review and exact-head green CI, owner may
approve a separate signed CodeBridge release and an audited, hash-checked,
create-only install of the reviewed script to that exact protected path.
Fail on conflicting existing file, symlink, changed pin, wrong owner/mode or
ancestor. Do not replace or chown an unknown file, adjust php-fpm pool users,
change Nginx, create release requests, mutate approval manifests or start the
activation broker.

The installed production CodeBridge runtime and its live tool catalog must
then be checked independently. Until that proof, direct ChatGPT execution of
this new action is **NOT AVAILABLE**. This is a read-only diagnostic capability,
not a general root terminal or one-click production deployment.

## Review tests

- Exact fixture digest and hardcoded file pin agree.
- Caller-controlled path, script, args, UID, port, command and env are rejected.
- Wrong owner, symlink, hardlink, writable directory, changed pin and missing
  target cannot execute privileged subprocesses.
- Output parsing excludes paths, process data, unknown status, forged READY
  or installed/activation claims.
- Exit 2 or a thrown subprocess cannot become PASS or leak exception text.
- Tampering between preflight and readback blocks the receipt.
- Separate CloudOS/dev Supervisor profiles cannot run the operation.

Main Platform production still uses its separate
`docs/operations/FAST_RELEASE_GUIDE_ELITE.md` protected approval chain.
