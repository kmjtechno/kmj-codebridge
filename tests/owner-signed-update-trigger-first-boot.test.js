import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dir = "scripts/production/";
const reviewed = fs.readFileSync(
  dir + "owner-trigger-signed-update-20261103.sh",
  "utf8",
);
const script = fs.readFileSync(
  dir + "owner-trigger-signed-update-20261114.sh",
  "utf8",
);
const UNIT = "kmj-codebridge-stable-update.service";
const posix = process.platform !== "win32";

test("20261114 trigger differs from the reviewed script only in the no-prior-entry handling", () => {
  const lines = (text) => new Set(text.split("\n"));
  const before = lines(reviewed);
  const after = lines(script);
  const removed = [...before].filter((line) => !after.has(line));
  const added = [...after].filter((line) => !before.has(line));
  assert.deepEqual(removed, [
    '[[ -n "$cursor_before" ]] || fail SIGNED_JOURNAL_CURSOR_UNAVAILABLE',
    "        ['journalctl', '-b', '-u', unit, '--after-cursor=' + cursor,",
    "         '-n', '200', '-o', 'json', '--no-pager'],",
  ]);
  assert.equal(added.length, 10);
  assert.ok(added.includes('if [[ -z "$cursor_before" ]]; then'));
  // A journalctl failure is still fatal; only a clean empty answer continues.
  assert.match(
    script,
    /sed -n 's\/\^-- cursor: \/\/p'\) \|\| fail SIGNED_JOURNAL_CURSOR_UNAVAILABLE/,
  );
  assert.match(script, /len\(matches\) != 1/);
  assert.doesNotMatch(script, /--since|--boot=-1|systemctl enable|\.timer/);
});

const verifier = /"\$cursor_before" <<'PY'\n([\s\S]*?)\nPY\n/.exec(script)?.[1];

function runVerifier(t, cursor, messages) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-trigger-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const argsFile = path.join(tmp, "args.txt");
  const rows = messages
    .map((m) =>
      JSON.stringify({ _SYSTEMD_UNIT: m.unit ?? UNIT, MESSAGE: m.text }),
    )
    .join("\n");
  fs.writeFileSync(path.join(tmp, "rows.json"), rows + (rows ? "\n" : ""));
  fs.writeFileSync(
    path.join(tmp, "journalctl"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat "${path.join(tmp, "rows.json")}"\n`,
    { mode: 0o755 },
  );
  const result = spawnSync("python3", ["-I", "-S", "-", UNIT, cursor], {
    input: verifier,
    encoding: "utf8",
    env: { PATH: `${tmp}:/usr/bin:/bin` },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    args: fs.existsSync(argsFile)
      ? fs.readFileSync(argsFile, "utf8").trim().split("\n")
      : [],
  };
}
const done = (sequence) => ({
  text: `KMJ CodeBridge stable update complete; version 0.3.2, sequence ${sequence}, updated=true.`,
});

test(
  "first run after a reboot: no cursor reads the unit's whole current-boot journal",
  { skip: !posix },
  (t) => {
    assert.ok(verifier, "completion verifier heredoc found");
    const run = runVerifier(t, "", [
      { text: "unrelated line" },
      { text: done(25).text, unit: "some-other.service" },
      done(25),
    ]);
    assert.equal(run.status, 0, run.stdout);
    assert.deepEqual(run.args, [
      "-b",
      "-u",
      UNIT,
      "-n",
      "200",
      "-o",
      "json",
      "--no-pager",
    ]);
    assert.match(run.stdout, /CODEBRIDGE_SIGNED_JOB=COMPLETED/);
    assert.match(run.stdout, /CODEBRIDGE_SIGNED_SEQUENCE=25/);
  },
);

test(
  "a prior cursor is still passed, and missing or ambiguous completion stays unproven",
  { skip: !posix },
  (t) => {
    const withCursor = runVerifier(t, "s=abc;i=1", [done(25)]);
    assert.equal(withCursor.status, 0, withCursor.stdout);
    assert.ok(withCursor.args.includes("--after-cursor=s=abc;i=1"));

    for (const rows of [[], [done(24), done(25)]]) {
      const run = runVerifier(t, "", rows);
      assert.equal(run.status, 2);
      assert.match(run.stdout, /CODEBRIDGE_SIGNED_JOB=NOT_PROVEN/);
      assert.doesNotMatch(run.stdout, /COMPLETED/);
    }
  },
);
