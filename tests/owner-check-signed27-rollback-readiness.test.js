import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const check = fs.readFileSync(
  dir + "owner_check_signed27_rollback_readiness_20261115.py",
  "utf8",
);
const cutover = fs.readFileSync(
  dir + "owner_activate_signed27_gateway_20261115.py",
  "utf8",
);
const code = check.slice(check.indexOf('"""\nimport '));

test("readiness check is read-only: no arguments, no writes, no service control", () => {
  assert.match(code, /need\(sys\.argv\[1:\] == \[\], "USAGE"\)/);
  assert.doesNotMatch(
    code,
    /O_WRONLY|O_CREAT|os\.unlink|os\.replace|os\.link|os\.rename|os\.chmod|os\.chown|open\([^)]*"w/,
  );
  const calls = [...code.matchAll(/cmd\("systemctl", "([a-z-]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual([...new Set(calls)], ["show"]);
  assert.doesNotMatch(
    code,
    /"restart"|"stop"|"start"|daemon-reload|shell=True/,
  );
});

test("it pins the same override names, releases and bytes as the signed27 cutover", () => {
  for (const pattern of [
    /OLD_CONF = DIR \/ "zzzzzzzzz-kmj-signed25\.conf"/,
    /NEW_CONF = DIR \/ "zzzzzzzzzz-kmj-signed27\.conf"/,
    /0\.3\.2-55a3f976fd3b"\)/,
    /0\.3\.2-40655678db7f"\)/,
  ]) {
    assert.match(check, pattern);
    assert.match(cutover, pattern);
  }
  // Same five override lines as the cutover's new_content template.
  for (const line of [
    'f"WorkingDirectory={NEW_DIR}\\n"',
    'f"Environment=CODEBRIDGE_SOURCE_COMMIT={NEW_SHA}\\n"',
    'f"ExecStart={NODE} {NEW_DIR}/src/cli.js gateway {config}\\n"',
  ]) {
    assert.ok(cutover.includes(line), line);
    assert.ok(
      check.includes(
        line.replace(/NEW_DIR/g, "release_dir").replace("NEW_SHA", "sha"),
      ),
      line,
    );
  }
});

test("it tests what broke the seq25 rollback: config owner/mode and the old schema", () => {
  assert.match(check, /CONFIG_NOT_STARTABLE_ON_SIGNED25_MODE_OR_OWNER/);
  assert.match(check, /CONFIG_REJECTED_BY_SIGNED25_SCHEMA/);
  assert.match(
    check,
    /import \{\{ gatewaySchema \}\} from '\{OLD_DIR\}\/src\/config\.js'/,
  );
  assert.match(check, /NOT_PROVEN=AGENT_RECONNECT_AFTER_A_REAL_ROLLBACK/);
});
