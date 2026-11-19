// P520-only physical read-only handoff witness. Before activation: existing
// pinned PowerShell preflight without -Apply. After activation: verify the
// actual exact additive bound config and authenticated native Supervisor HMAC.
// Never restarts an agent or prints private config/paths/tokens/process data.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectPostBinding } from "../scripts/windows/P520-POST-HANDOFF-BINDING-VERIFY-20261119.mjs";

const onP520 =
  process.platform === "win32" &&
  os.hostname().toUpperCase() === "DESKTOP-5FVJMET";

test(
  "P520 exact existing-agent handoff real preflight or verified applied state",
  { skip: !onP520 },
  async () => {
    try {
      const result = await inspectPostBinding();
      assert.deepEqual(result, { verified: true, mode: "BOUND" });
      console.log("P520_OWNER_HANDOFF_STATE=PASS_APPLIED_HMAC_AUTHENTICATED");
      return;
    } catch (error) {
      if (String(error?.message) !== "POST_BINDING_PIPE_IDENTITY") {
        throw error;
      }
    }
    const script = fileURLToPath(
      new URL(
        "../scripts/windows/P520-GUARDED-AGENT-BINDING-HANDOFF-20261119.ps1",
        import.meta.url,
      ),
    );
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8", windowsHide: true, timeout: 45000, maxBuffer: 65536 },
    );
    const lines = String(r.stdout ?? "").split(/\r?\n/);
    const expected = [
      "P520_AGENT_HANDOFF_PREFLIGHT=PASS",
      "P520_SUPERVISOR_PERSISTENT_HMAC=PASS",
      "P520_AGENT_HANDOFF_MODE=READ_ONLY",
      "P520_AGENT_RESTART=NOT_EXECUTED",
    ];
    for (const marker of expected) assert.ok(lines.includes(marker));
    assert.equal(r.status, 0, "P520_OWNER_HANDOFF_PREFLIGHT_FAILED");
    console.log("P520_OWNER_HANDOFF_STATE=PASS_READ_ONLY_PRE_HANDOFF");
  },
);
