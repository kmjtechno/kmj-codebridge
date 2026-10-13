import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// A line such as `python3 - <<'PY' ||` makes the NEXT line the heredoc body, so
// the failure handler is never run as a handler and the check is silently skipped.
// Keep the `|| fail` on the same line as the heredoc marker.
const DANGLING = /<<-?\s*['"]?\w+['"]?\s*(\|\||&&|\|)\s*$/;

function shellScripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return shellScripts(full);
    return entry.name.endsWith(".sh") ? [full] : [];
  });
}

test("no shell script ends a heredoc marker line with a dangling operator", () => {
  const offenders = [];
  for (const file of shellScripts("scripts")) {
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (DANGLING.test(line)) offenders.push(`${file}:${index + 1}`);
      });
  }
  assert.deepEqual(offenders, []);
});

test("agent socket validation in the supervisor bootstrap actually fails closed", () => {
  const source = fs.readFileSync(
    "scripts/production/bootstrap-existing-supervisor.sh",
    "utf8",
  );
  assert.match(
    source,
    /<<'PY' \|\| fail "SUPERVISOR_BOOTSTRAP_AGENT_SOCKET_MISMATCH"/,
  );
});
