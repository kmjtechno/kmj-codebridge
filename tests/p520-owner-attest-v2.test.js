import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("P520 attestation v2 rejects model/host/port spoofing on native Windows without touching runtime", { skip: process.platform !== "win32" }, () => {
  const script = fileURLToPath(new URL("../scripts/windows/P520-LLAMACPP-OWNER-ATTEST-V2.ps1", import.meta.url));
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
    "-File", path.resolve(script), "-SelfTest",
  ], { encoding: "utf8", timeout: 20000, windowsHide: true });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /P520_ATTEST_V2_SELFTEST=PASS/);
});
