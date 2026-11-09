import fs from "node:fs";

/**
 * Only symbolic-link fixture creation is optional on non-admin Windows
 * workstations without Developer Mode. Production link rejection is unchanged.
 * Audited GitHub Actions Windows CI must exercise the real symlink case, never
 * waive it. The local job runner also sets CI=true but is a workstation, so only
 * GITHUB_ACTIONS (never an arbitrary CI flag) makes the privilege mandatory.
 */
export function tryFileSymlink(t, target, link) {
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch (error) {
    if (
      process.platform !== "win32" ||
      (error.code !== "EPERM" && error.code !== "EACCES")
    ) {
      throw error;
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error("WINDOWS_CI_SYMLINK_PRIVILEGE_REQUIRED", {
        cause: error,
      });
    }
    t.diagnostic(
      "WINDOWS_SYMLINK_ASSERTION_NOT_EXECUTED: non-admin fixture creation denied; audited Windows CI must exercise this assertion",
    );
    return false;
  }
}
