import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL(
    "../scripts/windows/ENABLE-CALIBRATION-STUDIO-DEVELOPMENT.ps1",
    import.meta.url,
  ),
);

test(
  "P520 Studio owner development profiles pass Windows PowerShell 5.1 selftest",
  { skip: process.platform !== "win32" },
  () => {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", script, "-SelfTest"],
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /STUDIO_DEV_SELFTEST=PASS/);
  },
);
