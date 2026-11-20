import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(
  root,
  "scripts/production/google-cloudos-supervisor-rollback-doctor.py",
);
const source = fs.readFileSync(file, "utf8");

test("Google CloudOS rollback doctor is deliberately read only", () => {
  for (const marker of [
    "GOOGLE_SUPERVISOR_RECOVERY_DOCTOR=READ_ONLY",
    "CONFIG_AND_CREDENTIAL_CONTENT=NOT_READ",
    "BOOTSTRAP_OR_RESTART=NOT_EXECUTED",
    "PRESENT_NOT_ATTESTED",
    "ROOT_STAGE_PRESENCE_IS_NOT_SIGNATURE_VERIFICATION=TRUE",
    "fa9340b958ce50000298282d65f3132596c16503",
    "9584b584c9a94545fb9dc750c9dfef5bf4f7978a",
  ]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.match(
    source,
    /subprocess\.run\(\s*\[\s*"\/usr\/bin\/systemctl",\s*"show"/,
  );
  assert.match(source, /len\(sys\.argv\) != 1/);
  assert.match(source, /socket\.gethostname\(\)/);
  assert.doesNotMatch(
    source,
    /subprocess\.(?:Popen|call|check_call|check_output)/,
  );
  assert.doesNotMatch(source, /shell\s*=\s*True/);
  assert.doesNotMatch(source, /\b(?:unlink|rmtree|rename)\s*\(/);
  assert.doesNotMatch(source, /\.(?:write_text|write_bytes|open)\s*\(/);
});
