import fs from "node:fs";
import path from "node:path";

function safeError(code) {
  const error = new Error(code);
  error.name = "CodeBridgeError";
  error.code = code;
  return error;
}

// Hold an exclusive private output file BEFORE a one-time credential can be
// redeemed. A failed destination must never strand an approved device grant.
export function reserveEnrollmentOutput(output) {
  let target;
  let fd;
  let identity;
  try {
    if (typeof output !== "string" || !output.trim())
      throw safeError("ENROLLMENT_OUTPUT_UNAVAILABLE");
    const absolute = path.resolve(output);
    const parent = fs.realpathSync(path.dirname(absolute));
    target = path.join(parent, path.basename(absolute));
    fd = fs.openSync(target, "wx", 0o600);
    // Filesystem IDs can exceed Number.MAX_SAFE_INTEGER on Windows.
    // BigInt keeps inode comparisons exact across rename/replacement races.
    identity = fs.fstatSync(fd, { bigint: true });
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // A cleanup failure is still a hard enrollment failure.
      }
      if (target && identity) {
        try {
          const current = fs.lstatSync(target, { bigint: true });
          if (
            !current.isSymbolicLink() &&
            identity.ino !== 0n &&
            current.dev === identity.dev &&
            current.ino === identity.ino
          )
            fs.unlinkSync(target);
        } catch {
          // Never report a successful preflight after failure.
        }
      }
    }
    throw safeError(
      error?.code === "EEXIST"
        ? "ENROLLMENT_OUTPUT_EXISTS"
        : "ENROLLMENT_OUTPUT_UNAVAILABLE",
    );
  }

  let finished = false;
  function stillOwned() {
    try {
      const current = fs.lstatSync(target, { bigint: true });
      return (
        !current.isSymbolicLink() &&
        identity.ino !== 0n &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      );
    } catch {
      return false;
    }
  }

  function abort() {
    if (finished) return;
    finished = true;
    try {
      fs.ftruncateSync(fd, 0);
    } catch {
      // Best-effort truncation if a write previously failed.
    }
    try {
      fs.closeSync(fd);
    } catch {
      // No secret is returned through errors or logs.
    }
    if (stillOwned()) {
      try {
        fs.unlinkSync(target);
      } catch {
        // A crash or filesystem fault may need manual cleanup.
      }
    }
  }

  return {
    commit(grant) {
      if (finished) throw safeError("ENROLLMENT_OUTPUT_UNAVAILABLE");
      try {
        if (!stillOwned()) throw safeError("ENROLLMENT_OUTPUT_CHANGED");
        const json = JSON.stringify(grant);
        if (typeof json !== "string" || Buffer.byteLength(json) > 65535)
          throw safeError("ENROLLMENT_OUTPUT_UNAVAILABLE");
        fs.writeFileSync(fd, json + "\n");
        fs.fsyncSync(fd);
        if (!stillOwned()) throw safeError("ENROLLMENT_OUTPUT_CHANGED");
        fs.closeSync(fd);
        finished = true;
      } catch {
        abort();
        throw safeError("ENROLLMENT_OUTPUT_WRITE_FAILED");
      }
    },
    abort,
  };
}
