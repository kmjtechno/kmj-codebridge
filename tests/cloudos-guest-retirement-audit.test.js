import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "scripts/production/audit-google-cloudos-guest-retirement.py");
const source = fs.readFileSync(file, "utf8");

test(
  "CloudOS guest audit Python syntax parses on Linux",
  { skip: process.platform === "win32" },
  () => {
    assert.doesNotThrow(() =>
      execFileSync("python3", ["-B", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", file], {
        timeout: 10000,
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  },
);

test("CloudOS guest inventory never deletes, stops, or mutates guests", () => {
  for (const marker of [
    "KMJ_CLOUDOS_GUEST_RETIREMENT_AUDIT=READ_ONLY",
    "VM_REMOVALS=0",
    "SAFE_AUTO_DELETE_COUNT=0",
    "google-vps1",
    "kmj-cloudos-api.service",
    "kmj-cloudos-worker.service",
    "kmj-codebridge-cloudos.service",
    "EXTERNAL_BACKUP_RESTORE=UNVERIFIED",
    "RELEASE_GATE_USAGE=UNVERIFIED",
  ]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.doesNotMatch(source, /\b(?:rm|unlink|rmdir|remove|destroy|terminate|purge)\s*\(/);
  assert.doesNotMatch(source, /(?:lxc|machinectl|virsh)\s+(?:delete|stop|terminate|destroy|rm)\b/);
  assert.doesNotMatch(source, /shell\s*=\s*True/);
  assert.doesNotMatch(source, /\bopen\([^\n]*["'](?:w|a|x)["']/);
});

test("all known nspawn and LXD names are included without claiming release credit", () => {
  for (const name of [
    "kvm01", "kvm02", "kvm03",
    "shared01", "shared02", "shared03",
    "util01", "util02", "util03",
    "upg01", "upg02", "upg03",
  ]) {
    assert.ok(source.includes(name), name);
  }
  assert.match(source, /disposition=/);
  assert.match(source, /backup=NOT_VERIFIED/);
});
