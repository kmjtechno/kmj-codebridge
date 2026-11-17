import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createChainSnapshotReader,
  MAX_AGE_MS,
} from "../src/freellmapi-chain-snapshot.js";

const NOW = 1_800_000_000_000;
const CHAIN = "auto:or-free";
const snap = (patch = {}) =>
  JSON.stringify({
    version: 1,
    chain: CHAIN,
    observedAtEpochMs: NOW - 10000,
    members: [{ platform: "openrouter", modelId: "meta/llama-x:free" }],
    ...patch,
  });
const read = (text, chain = CHAIN) =>
  createChainSnapshotReader({ readSnapshot: async () => text, now: () => NOW })(
    chain,
  );
const unusable = (text, chain) =>
  assert.rejects(read(text, chain), { message: "CHAIN_SNAPSHOT_UNUSABLE" });

test("a fresh matching snapshot returns only platform and modelId", async () => {
  const m = await read(
    snap({ members: [{ platform: "openrouter", modelId: "a/b:free", x: 1 }] }),
  );
  assert.deepEqual(m, [{ platform: "openrouter", modelId: "a/b:free" }]);
});

test("stale, future, wrong-chain, malformed or empty snapshots are unusable", async () => {
  await unusable(snap({ observedAtEpochMs: NOW - MAX_AGE_MS - 1 }));
  await unusable(snap({ observedAtEpochMs: NOW + 60000 }));
  await unusable(snap({ chain: "auto:other" }));
  await unusable(snap({ version: 2 }));
  await unusable(snap({ members: [] }));
  await unusable(snap({ members: [{ platform: "x" }] }));
  await unusable(
    snap({ members: [{ platform: "bad id", modelId: "a:free" }] }),
  );
  await unusable("not json");
  await unusable(snap(), "free-code");
  await assert.rejects(
    createChainSnapshotReader({
      readSnapshot: async () => {
        throw new Error("ENOENT");
      },
      now: () => NOW,
    })(CHAIN),
    { message: "CHAIN_SNAPSHOT_UNUSABLE" },
  );
  assert.throws(() => createChainSnapshotReader({}), {
    message: "SNAPSHOT_IO_MISSING",
  });
});

test("installer's embedded helper writes a minimal, readable snapshot from a router DB", () => {
  const script =
    "scripts/production/owner_install_freellmapi_chain_snapshot_20261117.py";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  const db = path.join(tmp, "r.db");
  const helper = path.join(tmp, "helper.py");
  const gen = `
import sqlite3,sys
c=sqlite3.connect(sys.argv[2])
c.executescript("""
CREATE TABLE models(id INTEGER PRIMARY KEY,platform TEXT,model_id TEXT,enabled INTEGER DEFAULT 1);
CREATE TABLE profiles(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE profile_models(id INTEGER PRIMARY KEY,profile_id INT,model_db_id INT,priority INT,enabled INT DEFAULT 1);
CREATE TABLE api_keys(id INTEGER PRIMARY KEY,encrypted_key TEXT);
INSERT INTO api_keys VALUES(1,'SECRET-CIPHERTEXT');
INSERT INTO profiles VALUES(1,'or-free');
INSERT INTO models VALUES(1,'openrouter','meta/llama-x:free',1),(2,'openrouter','off:free',0);
INSERT INTO profile_models VALUES(1,1,1,0,1),(2,1,2,1,1);
""")
c.commit()`;
  const src = fs.readFileSync(script, "utf8");
  const m = src.match(/HELPER_SOURCE = r'''([\s\S]*?)'''/);
  assert.ok(m);
  fs.writeFileSync(helper, m[1]);
  const g = spawnSync("python3", ["-I", "-B", "-c", gen, script, db], {
    encoding: "utf8",
  });
  assert.equal(g.status, 0, g.stderr);
  const r = spawnSync("python3", ["-I", "-B", helper, db, tmp, CHAIN], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(tmp, "or-free.json"), "utf8");
  assert.ok(!text.includes("SECRET"));
  const body = JSON.parse(text);
  assert.deepEqual(body.members, [
    { platform: "openrouter", modelId: "meta/llama-x:free" },
  ]);
  assert.ok(Math.abs(body.observedAtEpochMs - Date.now()) < 60000);
});

test("installer is dry-run by default, runs as the router user, and the reader is only used by the opt-in runtime", () => {
  const text = fs.readFileSync(
    "scripts/production/owner_install_freellmapi_chain_snapshot_20261117.py",
    "utf8",
  );
  assert.match(text, /SNAPSHOT=DRY_RUN_UNCHANGED/);
  assert.match(text, /User=\{USER\}/);
  assert.ok(!/User=root/.test(text));
  assert.match(text, /--confirm-install-snapshot/);
  const importers = fs
    .readdirSync("src")
    .filter((f) => f.endsWith(".js") && f !== "freellmapi-chain-snapshot.js")
    .filter((f) =>
      /freellmapi-chain-snapshot/.test(
        fs.readFileSync(path.join("src", f), "utf8"),
      ),
    );
  assert.deepEqual(importers, ["freellmapi-runtime.js"]);
  const src = fs
    .readFileSync("src/freellmapi-chain-snapshot.js", "utf8")
    .replace(/\/\/.*$/gm, "");
  assert.ok(!/process\.env|readFile|child_process|node:/.test(src));
});
