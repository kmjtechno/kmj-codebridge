import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/production/owner_elite_release.py";
const script = fs.readFileSync(SCRIPT, "utf8");
const REV = "8c48ec92cc0720890efc8b8abf2b575395536e53";
const HASH = "9ceec2f1a4bbdfc15adfe181236ab958fb786db17eef47ec4f8c457323f8d115";

// Run a snippet inside the module (imported, not executed) with python -I.
function py(body) {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("r", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def out(fn):
    try: print(json.dumps({"ok": fn()}, default=str))
    except m.Blocked as e: print(json.dumps({"blocked": e.args[0]}))
${body}`;
  const r = spawnSync("python3", ["-I", "-B", "-c", code], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("compiles, is dry-run by default and pins no per-release value", () => {
  const r = spawnSync("python3", [
    "-I",
    "-B",
    "-c",
    "import ast,sys;ast.parse(open(sys.argv[1]).read())",
    SCRIPT,
  ]);
  assert.equal(r.status, 0);
  assert.match(script, /ELITE_RELEASE=" \+ \("DONE" if args\["apply"\]/);
  // No 40-hex revision literal: everything comes from the signed manifest.
  assert.equal(script.match(/\b[0-9a-f]{40}\b/g), null);
  // The only 64-hex literals are the owner SPKI pin, the commit override and the feed roller.
  const literals = new Set(script.match(/\b[0-9a-f]{64}\b/g));
  assert.equal(literals.size, 3);
});

test("pinned owner SPKI and feed roller hash match the repository", () => {
  const verifier = fs.readFileSync(
    "scripts/verify-signed-owner-release.mjs",
    "utf8",
  );
  const pin = script.match(/SPKI_PIN = "([0-9a-f]{64})"/)[1];
  assert.ok(verifier.includes(pin));
  const roller = script.match(/ROLLER = "([^"]+)"/)[1];
  const rollerSha = script.match(/ROLLER_SHA256 = "([0-9a-f]{64})"/)[1];
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync("scripts/production/" + roller))
      .digest("hex"),
    rollerSha,
  );
  // The commit-override pin is shared with the existing per-release script.
  const commit = script.match(/COMMIT_CONF_SHA = "([0-9a-f]{64})"/)[1];
  assert.ok(
    fs
      .readFileSync(
        "scripts/production/owner_activate_signed32_gateway_20261119.py",
        "utf8",
      )
      .includes(commit),
  );
});

test("argument grammar is closed: manifest hash required, apply needs the confirmation", () => {
  const cases = [
    [[REV, "--manifest-sha256", HASH], true],
    [[REV, "--manifest-sha256", HASH, "--step", "publish"], true],
    [
      [REV, "--manifest-sha256", HASH, "--apply", "--confirm-no-active-jobs"],
      true,
    ],
    [
      [
        REV,
        "--manifest-sha256",
        HASH,
        "--step",
        "cutover",
        "--apply",
        "--confirm-no-active-jobs",
      ],
      true,
    ],
    [[REV], false],
    [[REV, "--apply"], false],
    [[REV, "--manifest-sha256", HASH, "--apply"], false],
    [[REV, "--manifest-sha256", "abc"], false],
    [[REV, "--manifest-sha256", HASH, "--step", "rm -rf"], false],
    [[REV, "--manifest-sha256", HASH, "--url", "http://x"], false],
    [["../../etc", "--manifest-sha256", HASH], false],
    [[REV.toUpperCase(), "--manifest-sha256", HASH], false],
  ];
  for (const [argv, valid] of cases) {
    const res = py(`out(lambda: m.parse_args(${JSON.stringify(argv)}))`);
    assert.equal("ok" in res, valid, JSON.stringify(argv));
  }
  assert.equal(
    py(
      `out(lambda: m.parse_args([${JSON.stringify(REV)}, "--manifest-sha256", ${JSON.stringify(HASH)}])["apply"])`,
    ).ok,
    false,
  );
});

test("every committed signed manifest parses; tampered identity is rejected", () => {
  for (const rev of fs.readdirSync("releases/stable")) {
    const raw = fs.readFileSync(`releases/stable/${rev}/release-manifest.json`);
    const data = JSON.parse(raw);
    const r = py(
      `out(lambda: m.parse_manifest(open(${JSON.stringify(`releases/stable/${rev}/release-manifest.json`)},"rb").read(), ${JSON.stringify(rev)}))`,
    );
    assert.equal(r.ok.sequence, data.sequence, rev);
    assert.equal(
      r.ok.archive,
      `kmj-codebridge-${data.version}-${rev.slice(0, 12)}.tar.gz`,
    );
    assert.equal(
      r.ok.github,
      `https://github.com/kmjtechno/kmj-codebridge/releases/download/codebridge-stable-seq${data.sequence}-${rev.slice(0, 8)}/${r.ok.archive}`,
    );
  }
  const base = JSON.parse(
    fs.readFileSync(`releases/stable/${REV}/release-manifest.json`, "utf8"),
  );
  const tampered = [
    { ...base, revision: "0".repeat(40) },
    { ...base, channel: "canary" },
    { ...base, keyId: "other" },
    { ...base, sequence: "32" },
    { ...base, sequence: 0 },
    { ...base, sha256: "xyz" },
    { ...base, bytes: 300000001 },
    { ...base, version: "0.3.2; rm" },
    { ...base, archive: base.archive.replace("kmjtechno.com", "evil.example") },
    { ...base, archive: base.archive.replace(".tar.gz", ".zip") },
  ];
  for (const item of tampered) {
    const raw = JSON.stringify(item);
    const r = py(
      `out(lambda: m.parse_manifest(${JSON.stringify(raw)}.encode(), ${JSON.stringify(REV)}))`,
    );
    assert.ok("blocked" in r, raw);
  }
  assert.ok(
    "blocked" in
      py(`out(lambda: m.parse_manifest(b"not json", ${JSON.stringify(REV)}))`),
  );
});

test("override naming reproduces the live seq31 to seq32 chain and always sorts later", () => {
  const names = [
    "zzzzz-kmj-source-commit.conf",
    "zzzzzzzzzzzzz-kmj-signed30.conf",
    "zzzzzzzzzzzzzz-kmj-signed31.conf",
  ];
  const r = py(`out(lambda: list(m.newest_conf(${JSON.stringify(names)})))`);
  assert.deepEqual(r.ok, [31, 14, "zzzzzzzzzzzzzz-kmj-signed31.conf"]);
  const next = py(`out(lambda: m.next_conf_name(14, 32))`).ok;
  assert.equal(next, "zzzzzzzzzzzzzzz-kmj-signed32.conf");
  assert.ok(next > names[2] && next > names[0]);
  // Numeric (not lexical) ordering of the sequence: 100 > 99.
  const big = py(
    `out(lambda: m.newest_conf(["zz-kmj-signed99.conf","zzz-kmj-signed100.conf"])[0])`,
  );
  assert.equal(big.ok, 100);
  assert.equal(
    py(`out(lambda: m.newest_conf(["other.conf"]))`).blocked,
    "NO_SIGNED_OVERRIDE_FOUND",
  );
  assert.equal(
    py(
      `out(lambda: m.newest_conf(["zz-kmj-signed5.conf","zzz-kmj-signed5.conf"]))`,
    ).blocked,
    "AMBIGUOUS_SIGNED_OVERRIDE",
  );
});

test("override bytes round-trip and equal the template the per-release script wrote", () => {
  const dirName = "/opt/kmj-codebridge-stable/releases/0.3.2-8c48ec92cc07";
  const cfg = "/etc/kmj-codebridge/gateway.json";
  const expected =
    "[Service]\n" +
    `WorkingDirectory=${dirName}\n` +
    `Environment=CODEBRIDGE_SOURCE_COMMIT=${REV}\n` +
    "ExecStart=\n" +
    `ExecStart=/opt/kmj-codebridge-node/bin/node ${dirName}/src/cli.js gateway ${cfg}\n`;
  const r = py(
    `out(lambda: m.override_content(m.pathlib.Path(${JSON.stringify(dirName)}), ${JSON.stringify(REV)}, m.NODE, ${JSON.stringify(cfg)}).decode())`,
  );
  assert.equal(r.ok, expected);
  const parsed = py(
    `out(lambda: [str(x) for x in m.parse_override(${JSON.stringify(expected)})])`,
  );
  assert.deepEqual(parsed.ok, [dirName, REV, cfg]);
  const forged = [
    expected.replace("0.3.2-8c48ec92cc07", "0.3.2-000000000000"),
    expected + "ExecStartPre=/bin/sh\n",
    expected.replace("/etc/kmj-codebridge/gateway.json", "/tmp/../etc/x y"),
    expected.replace("/opt/kmj-codebridge-stable/releases", "/tmp"),
  ];
  for (const text of forged) {
    assert.ok(
      "blocked" in py(`out(lambda: m.parse_override(${JSON.stringify(text)}))`),
      text,
    );
  }
});

test("the new gateway catalog must be a superset of the live catalog", () => {
  assert.equal(
    py(`out(lambda: m.tools_superset(["a","b"],["a","b","c"]))`).ok,
    null,
  );
  assert.equal(
    py(`out(lambda: m.tools_superset(["a","b"],["a"]))`).blocked,
    "REQUIRED_TOOLS_MISSING",
  );
});

test("a non-root run is refused before anything is read or written", () => {
  if (process.getuid && process.getuid() === 0) return;
  const r = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      SCRIPT,
      REV,
      "--manifest-sha256",
      HASH,
      "--apply",
      "--confirm-no-active-jobs",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2);
  assert.match(r.stdout, /ELITE_RELEASE=BLOCKED/);
  assert.match(r.stdout, /REASON=WRONG_ROOT_OR_HOST/);
});
