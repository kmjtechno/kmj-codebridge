import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDispatcher,
  FAST_READ_TOOLS,
  definitions,
} from "../src/tools.js";
import {
  BrowserGrantRegistry,
  createBrowserGrant,
} from "../src/browser-grants.js";

test("browser_grant_status is read-only, empty by default and cannot issue grants", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-bg-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dispatch = createDispatcher(
    {
      id: "d1",
      tenant: "t1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  assert.equal(definitions.browser_grant_status.access, "read");
  assert.ok(FAST_READ_TOOLS.includes("browser_grant_status"));
  assert.deepEqual(Object.keys(definitions.browser_grant_status.input).sort(), [
    "device",
    "project",
  ]);
  const r = await dispatch(
    "browser_grant_status",
    { device: "d1", project: "p1" },
    ["read"],
  );
  assert.deepEqual(r.grants, []);
  assert.equal(r.active, 0);
  assert.equal(r.issuance, "TRUSTED_HOST_ONLY");
  assert.equal(r.browserLaunch, "NOT_AVAILABLE");
});

test("registry list is scoped, pruned and omits nothing replayable", () => {
  let now = 1000;
  const reg = new BrowserGrantRegistry({ now: () => now });
  const mk = (project, id) =>
    createBrowserGrant(
      {
        tenant: "t1",
        device: "d1",
        project,
        origin: "https://example.com",
        scopes: ["read"],
        ttlMs: 60_000,
      },
      { now: () => now, idFactory: () => id },
    );
  reg.register(mk("p1", "g1"));
  reg.register(mk("p2", "g2"));
  assert.deepEqual(
    reg.list({ tenant: "t1", device: "d1", project: "p1" }).map((g) => g.id),
    ["g1"],
  );
  assert.equal(reg.list({}).length, 2);
  now += 61_000;
  assert.equal(reg.list({}).length, 0);
});
