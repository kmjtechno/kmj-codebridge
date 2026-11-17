import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { manifestDigest } from "../src/freellmapi-zero-cost-verifier.js";

const file = "scripts/production/owner_pin_freellmapi_chain_20261117.py";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
const py = (args) =>
  spawnSync("python3", ["-I", "-B", file, ...args], { encoding: "utf8" });

function fixture(name, members) {
  const db = path.join(tmp, name + ".db");
  const sql = `
    import sqlite3,sys,json
    c=sqlite3.connect(sys.argv[1])
    c.executescript("""
      CREATE TABLE models(id INTEGER PRIMARY KEY,platform TEXT,model_id TEXT,enabled INTEGER DEFAULT 1);
      CREATE TABLE profiles(id INTEGER PRIMARY KEY,name TEXT);
      CREATE TABLE profile_models(id INTEGER PRIMARY KEY,profile_id INT,model_db_id INT,priority INT,enabled INT DEFAULT 1);
      INSERT INTO profiles VALUES(1,'free-code');
    """)
    for i,(p,m,en) in enumerate(json.loads(sys.argv[2])):
        c.execute("INSERT INTO models VALUES(?,?,?,?)",(i+1,p,m,en))
        c.execute("INSERT INTO profile_models VALUES(?,?,?,?,1)",(i+1,1,i+1,i))
    c.commit()`.replace(/^ {4}/gm, "");
  const r = spawnSync(
    "python3",
    ["-I", "-B", "-c", sql, db, JSON.stringify(members)],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return db;
}

test("script compiles and is dry-run by default", () => {
  const r = spawnSync("python3", [
    "-I",
    "-B",
    "-c",
    "import ast,sys;ast.parse(open(sys.argv[1]).read())",
    file,
  ]);
  assert.equal(r.status, 0);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /PIN=DRY_RUN_UNCHANGED/);
  assert.match(text, /mode=ro/);
  assert.ok(!/api_keys|encrypted_key/.test(text.replace(/"""[\s\S]*?"""/, "")));
});

test("all-OpenRouter :free chain: dry run writes nothing, apply writes a digest-valid manifest", () => {
  const ids = ["meta/llama-x:free", "vendor/model-a:free"];
  const db = fixture(
    "ok",
    ids.map((m) => ["openrouter", m, 1]),
  );
  const out = path.join(tmp, "manifest.json");
  const dry = py(["auto:free-code", "--db", db, "--out", out]);
  assert.equal(dry.status, 0, dry.stdout);
  assert.match(dry.stdout, /PIN=DRY_RUN_UNCHANGED/);
  assert.ok(!fs.existsSync(out));
  const bad = py(["auto:free-code", "--apply", "--db", db, "--out", out]);
  assert.equal(bad.status, 2);
  assert.ok(!fs.existsSync(out));
  const ok = py([
    "auto:free-code",
    "--db",
    db,
    "--out",
    out,
    "--apply",
    "--confirm-pin",
    "auto:free-code",
  ]);
  assert.equal(ok.status, 0, ok.stdout);
  const m = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(m.sha256, manifestDigest(ids));
  assert.deepEqual(m.models, [...ids].sort());
  if (process.platform !== "win32")
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const again = py([
    "auto:free-code",
    "--db",
    db,
    "--out",
    out,
    "--apply",
    "--confirm-pin",
    "auto:free-code",
  ]);
  assert.match(again.stdout, /MANIFEST_ALREADY_EXISTS/);
});

test("any non-OpenRouter, non-:free, duplicate or empty chain is BLOCKED", () => {
  for (const members of [
    [["groq", "llama-x", 1]],
    [["openrouter", "vendor/paid-model", 1]],
    [
      ["openrouter", "vendor/a:free", 1],
      ["gemini", "g", 1],
    ],
  ]) {
    const db = fixture("bad" + members.length + members[0][0], members);
    const r = py(["auto:free-code", "--db", db]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /PIN=BLOCKED_CHAIN_NOT_ALL_OPENROUTER_FREE/);
  }
  const db = fixture("disabled", [["openrouter", "vendor/a:free", 0]]);
  assert.match(
    py(["auto:free-code", "--db", db]).stdout,
    /CHAIN_EMPTY_OR_UNKNOWN/,
  );
  assert.match(py(["auto:nope", "--db", db]).stdout, /CHAIN_EMPTY_OR_UNKNOWN/);
});

test("bad usage is rejected", () => {
  assert.match(py(["free-code"]).stdout, /BLOCKED=USAGE/);
});
