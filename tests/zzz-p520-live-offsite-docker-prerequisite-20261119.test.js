import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

// P520 fixed Docker/Linux/disk prerequisites; no private recovery data access.
// Doctor is read-only and outputs categorical markers, not any private paths.
const isP520 =
  process.platform === "win32" &&
  os.hostname().toUpperCase() === "DESKTOP-5FVJMET";

test(
  "P520 real Docker Linux restore prerequisite (read-only)",
  { skip: !isP520 },
  () => {
    const script = fileURLToPath(
      new URL(
        "../scripts/windows/P520-MAIN-PLATFORM-OFFSITE-DOCTOR-20261116.ps1",
        import.meta.url,
      ),
    );
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Inspect",
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true, maxBuffer: 16384 },
    );
    const lines = String(r.stdout ?? "").split(/\r?\n/);
    const markers = [
      "KMJ_P520_OFFSITE_DOCTOR=READ_ONLY_V1",
      "DOCKER_LINUX_ENGINE=PASS",
      "P520_STORAGE_SPACE_12GIB=PASS",
      "P520_INDEPENDENT_DECRYPT_RESTORE=NOT_EXECUTED",
      "PRODUCTION_DB_MUTATION=NONE",
    ];
    for (const marker of markers) {
      const key = marker.split("=")[0];
      const value =
        lines.find((line) => line.startsWith(key + "=")) ?? key + "=MISSING";
      console.log(value);
      assert.equal(value, marker, "P520_OFFSITE_PREREQUISITE_BLOCKED_" + key);
    }
    assert.equal(r.status, 0, "P520_OFFSITE_DOCTOR_EXIT_NOT_ZERO");
  },
);
