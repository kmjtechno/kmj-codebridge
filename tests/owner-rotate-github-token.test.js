import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const file = "scripts/production/owner_rotate_github_token_20261119.py";
const script = fs.readFileSync(file, "utf8");

const py = (code, ...args) =>
  spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      `import importlib.util,sys
s=importlib.util.spec_from_file_location("r",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
${code}`,
      file,
      ...args,
    ],
    { encoding: "utf8" },
  );

test("script compiles", () => {
  const r = py("print('ok')");
  assert.equal(r.status, 0, r.stderr);
});

test("dry-run by default; apply needs the explicit restart confirmation", () => {
  assert.match(script, /DRY_RUN_UNCHANGED/);
  assert.match(script, /CONFIRM_FLAG_REQUIRED/);
  const r = py("sys.exit(m.main(['--apply']))");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED=CONFIRM_FLAG_REQUIRED/);
});

test("token only from a hidden prompt; never printed, passed as argument or logged", () => {
  assert.match(script, /getpass\.getpass\(/);
  assert.doesNotMatch(script, /sys\.argv\[[^\]]*\]\s*\)?\s*#?.*tok/);
  const prints = script.match(/out\([^\n]*\)/g).join("\n");
  assert.doesNotMatch(prints, /\btok\b|\boriginal\b|\btext\b/);
  // The only print is inside out(), which is never given the token.
  assert.equal((script.match(/print\(/g) ?? []).length, 1);
});

test("only fine-grained tokens are accepted", () => {
  const r = py(
    "print(m.valid_token('github_pat_'+'A'*40), m.valid_token('ghp_'+'A'*40), m.valid_token('github_pat_short'), m.valid_token(None))",
  );
  assert.equal(r.stdout.trim(), "True False False False");
});

test("exactly one token line is located and only that line is replaced", () => {
  const r = py(`
t="A=1\\nCODEBRIDGE_GITHUB_PROXY_TOKEN=old\\nB=2"
n=("CODEBRIDGE_GITHUB_PROXY_TOKEN","KMJ_CODEBRIDGE_GITHUB_TOKEN")
print(m.find_line(t,n))
print(repr(m.replace_line(t,"CODEBRIDGE_GITHUB_PROXY_TOKEN",1,"NEW")))
print(m.find_line("CODEBRIDGE_GITHUB_PROXY_TOKEN=a\\nKMJ_CODEBRIDGE_GITHUB_TOKEN=b",n))
print(m.find_line("A=1",n))
e="export KMJ_CODEBRIDGE_GITHUB_TOKEN=old"
print(repr(m.replace_line(e,"KMJ_CODEBRIDGE_GITHUB_TOKEN",0,"NEW")))
`);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], "('CODEBRIDGE_GITHUB_PROXY_TOKEN', 1)");
  assert.equal(lines[1], "'A=1\\nCODEBRIDGE_GITHUB_PROXY_TOKEN=NEW\\nB=2'");
  assert.equal(lines[2], "None");
  assert.equal(lines[3], "None");
  assert.equal(lines[4], "'export KMJ_CODEBRIDGE_GITHUB_TOKEN=NEW'");
});

test("atomic write preserves mode and leaves no temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-rot-"));
  const f = path.join(dir, "env");
  fs.writeFileSync(f, "X=1\n", { mode: 0o640 });
  const r = py(
    "p=__import__('pathlib').Path(sys.argv[2]);m.atomic_write(p,'X=2\\n',p)",
    f,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(f, "utf8"), "X=2\n");
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir), ["env"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("probe requires read on both repos and refuses explicit no-push", () => {
  assert.match(script, /st != 200 or push == "no"/);
  assert.match(script, /NEW_TOKEN_NOT_ACCEPTED_OR_NO_PUSH/);
});

test("apply path backs up, restarts once and rolls back on failure", () => {
  assert.match(script, /O_EXCL \| os\.O_NOFOLLOW/);
  assert.match(script, /ROLLED_BACK/);
  assert.match(script, /wait_active/);
  assert.equal((script.match(/"restart", UNIT/g) ?? []).length, 2);
});
