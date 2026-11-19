import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "scripts/production/owner_diagnose_github_credential_20261119.py";
const script = fs.readFileSync(file, "utf8");

test("script compiles", () => {
  const r = spawnSync("python3", [
    "-I",
    "-B",
    "-c",
    "import ast,sys;ast.parse(open(sys.argv[1]).read())",
    file,
  ]);
  assert.equal(r.status, 0);
});

test("read-only: root required, GET only, fixed host, no redirects", () => {
  assert.match(script, /ROOT_REQUIRED/);
  assert.match(script, /API = "https:\/\/api\.github\.com"/);
  assert.match(script, /NoRedirect/);
  for (const bad of [
    "method=",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "write_text",
    "unlink",
    "os.replace",
    "restart",
    "daemon-reload",
    "chmod",
    "chown",
  ])
    assert.ok(!script.includes(bad), bad);
});

test("never prints the token, variable names or response bodies", () => {
  const prints = script
    .match(/out\([^\n]*\)/g)
    .join("\n")
    .replace(/"yes" if tok else "no"/, "")
    .replace(/token_class\(tok\)/, "");
  assert.doesNotMatch(prints, /\btok\b/);
  assert.doesNotMatch(prints, /\bnames\b|\benv\b|\bbody\b|raw/);
  assert.doesNotMatch(script, /print\(.*tok/);
});

test("classification is fixed-field", () => {
  const r = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      `
import importlib.util,sys
s=importlib.util.spec_from_file_location("d",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(m.classify(200,{}),m.classify(401,{}),m.classify(403,{"x-ratelimit-remaining":"0"}),m.classify(403,{}),m.classify(404,{}),m.classify(0,{}))
print(m.token_class("github_pat_x"),m.token_class("ghs_x"),m.token_class("zzz"))
`,
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout.trim().split(/\r?\n/)[0],
    "READ_OK TOKEN_INVALID_OR_EXPIRED RATE_LIMITED FORBIDDEN_GRANT_OR_SSO NO_ACCESS_OR_MISSING NETWORK_OR_OTHER",
  );
  assert.equal(
    r.stdout.trim().split(/\r?\n/)[1],
    "fine_grained_pat app_installation unknown",
  );
});
