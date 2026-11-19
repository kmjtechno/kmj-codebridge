import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const file = path.resolve(
  import.meta.dirname,
  "..",
  "scripts",
  "setup-codebridge-dev-agent.sh",
);
const text = fs.readFileSync(file, "utf8");

test("dev-agent setup is dry-run by default and refuses root service user", () => {
  assert.match(text, /^APPLY=0$/m);
  assert.match(text, /--apply/);
  assert.match(text, /SERVICE_USER_IS_ROOT/);
  assert.match(text, /^SERVICE_USER='kmjdev'$/m);
  assert.match(text, /\[\[ "\$\{HOST_SHORT,,\}" == "kmj-elite" \]\]/);
});

test("dev-agent setup never touches the Main Platform agent or pipes remote code", () => {
  assert.doesNotMatch(text, /main-platform/);
  assert.doesNotMatch(text, /curl[^\n]*\|\s*(ba)?sh/);
  assert.doesNotMatch(text, /deploy_ed25519|gh auth|ssh-keygen/);
});

test("dev-agent uses the signed readable runtime, not the root-only legacy tree", () => {
  assert.match(text, /^RUNTIME='\/opt\/kmj-codebridge-stable\/current'$/m);
  assert.doesNotMatch(text, /RUNTIME='\/opt\/kmj-codebridge-agent'/);
});

test("dev-agent config is fixed-profile only and the unit is hardened", () => {
  assert.match(text, /commandPresets: \['node-standard'\]/);
  assert.match(text, /gates: \{\}/);
  for (const d of [
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "RestrictSUIDSGID=true",
    "PrivateTmp=true",
  ])
    assert.ok(text.includes(d), d);
  assert.match(text, /ReadWritePaths=\$PROJECT_ROOT \$STATE_DIR/);
});

test("dev-agent setup is valid bash and non-root dry-run exits before changing anything", (t) => {
  if (process.platform === "win32") return t.skip("bash is POSIX only");
  assert.equal(spawnSync("bash", ["-n", file]).status, 0);
  if (typeof process.getuid === "function" && process.getuid() === 0)
    return t.skip("needs a non-root caller");
  const r = spawnSync("bash", [file], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /MODE=DRY_RUN/);
  assert.match(r.stderr, /Run as root/);
});
