import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scopes, signInScope, oauthChallenge } from "../src/auth.js";

const script = fs.readFileSync(
  "scripts/production/owner_enable_gateway_signin_scopes_all_20261115.py",
  "utf8",
);
const oauth = { resource: "https://cb.example.com/mcp" };

test("the challenge strings the script waits for are what the gateway sends", () => {
  const one = script.match(/ONE_SCOPE = '([^']+)'/)[1];
  const all = script.match(/ALL_SCOPES = '([^']+)'/)[1];
  assert.ok(
    oauthChallenge(oauth, signInScope({}, "codebridge:read")).includes(one),
  );
  assert.ok(
    oauthChallenge(
      oauth,
      signInScope({ signInScopes: "all" }, "codebridge:read"),
    ).includes(all),
  );
  assert.equal(all, `scope="${scopes.join(" ")}"`);
  assert.ok(!all.includes(one));
});

test("dry-run by default; apply and rollback need the no-active-jobs confirmation", () => {
  assert.match(
    script,
    /sys\.argv\[1:\] in \(\[\], \["--apply", confirm\], \["--rollback", confirm\]\)/,
  );
  assert.match(
    script,
    /if sys\.argv\[1:\] != \["--apply", "--confirm-no-active-jobs"\]:\n\s+print\("SIGNIN_SCOPES=DRY_RUN_UNCHANGED"\)/,
  );
});

test("only the signed27 gateway unit is restarted; nothing else is controlled", () => {
  assert.match(script, /UNIT = "kmj-codebridge-gateway-stage\.service"/);
  assert.match(script, /NEW_SHA = "40655678db7fa62edca28ccc4988614010253ef1"/);
  const calls = [...script.matchAll(/cmd\("systemctl", "([a-z-]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual([...new Set(calls)].sort(), ["restart", "show"]);
  // Code only: the docstring names what is never touched.
  assert.doesNotMatch(
    script.slice(script.indexOf('"""\nimport ')),
    /supervisor|nginx|stable-update|daemon-reload|shell=True|os\.system/i,
  );
});

test("config stays startable: service-user owner, 0600, one key changed, values never printed", () => {
  for (const code of [
    "GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER",
    "REWRITE_CHANGED_OTHER_VALUES",
    "CANDIDATE_REJECTED_BY_GATEWAY_SCHEMA",
    "BASELINE_CHALLENGE_NOT_SINGLE_SCOPE",
    "BACKUP_READBACK_MISMATCH",
    "CONFIG_CHANGED_SINCE_APPLY",
    "GATEWAY_NOT_ON_SIGNED27",
  ])
    assert.ok(script.includes(code), code);
  assert.match(
    script,
    /os\.fchown\(fd, uid, gid\)\n\s+os\.fchmod\(fd, 0o600\)/,
  );
  // Every print is a fixed token, optionally followed by a Blocked code or a
  // constant; no config data ever reaches stdout.
  for (const [, argument] of script.matchAll(/print\(([^\n]*)\)\n/g))
    assert.match(
      argument,
      /^"[A-Z0-9_=:]+"( \+ (str\(reason\)|safe|BACKUP_SUFFIX))?$/,
      argument,
    );
});

test("a failed restart restores the previous bytes and restarts again", () => {
  assert.match(
    script,
    /write_private\(config_path, data, exclusive=False\)\n\s+need\(read_private\(config_path\) == data, "RESTORE_READBACK_MISMATCH"\)\n\s+restart_and_wait\(port, ONE_SCOPE\)/,
  );
  assert.match(script, /GATEWAY_CONFIG_ROLLBACK=FAILED_OWNER_REVIEW_REQUIRED/);
});
