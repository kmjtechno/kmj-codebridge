import fs from "node:fs";

/**
 * A Windows account without Developer Mode or SeCreateSymbolicLinkPrivilege
 * cannot create a symlink test fixture (EPERM). That is NOT evidence the
 * CodeBridge symlink security assertion passed.
 *
 * Skip only that privilege-dependent assertion, visibly; never interpret
 * other I/O errors as permissions or weaken production symlink checks.
 */
export function createSymlinkOrSkip(t, target, link) {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      t.diagnostic(
        "WINDOWS_SYMLINK_ASSERTION_NOT_EXECUTED: symlink fixture privilege denied; run on an authorized symlink-capable Windows environment",
      );
      t.skip("Windows symlink-creation privilege unavailable; security assertion NOT EXECUTED");
      return false;
    }
    throw error;
  }
}
