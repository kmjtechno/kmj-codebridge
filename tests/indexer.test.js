import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
import { ProjectIndex } from "../src/indexer.js";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, index: new ProjectIndex(new ProjectFiles(root)) };
}

test("lazy symbol index finds common language symbols and skips sensitive trees", (t) => {
  const { root, index } = setup(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(
    path.join(root, "src", "app.ts"),
    [
      "export class AppService {}",
      "export async function buildApp() {}",
      "export interface AppConfig {}",
      "export type AppId = string;",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "worker.py"),
    ["class Worker:", "    pass", "def run_worker():", "    pass"].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "node_modules", "hidden.js"),
    "export function hiddenDependency() {}\n",
  );
  fs.writeFileSync(path.join(root, ".env.local"), "export function secretFn() {}\n");

  const app = index.search("App");
  assert.deepEqual(
    app.matches.map((m) => [m.kind, m.name]),
    [
      ["class", "AppService"],
      ["function", "buildApp"],
      ["interface", "AppConfig"],
      ["type", "AppId"],
    ],
  );
  const worker = index.search("worker");
  assert.ok(worker.matches.some((m) => m.name === "Worker"));
  assert.ok(worker.matches.some((m) => m.name === "run_worker"));

  const hidden = index.search("hidden");
  assert.equal(hidden.matches.length, 0);
  const secret = index.search("secretFn");
  assert.equal(secret.matches.length, 0);
});

test("lazy index refreshes only changed files and removes deleted symbols", async (t) => {
  const { root, index } = setup(t);
  const file = path.join(root, "module.js");
  fs.writeFileSync(file, "export function firstVersion() {}\n");

  assert.equal(index.search("firstVersion").matches.length, 1);
  const before = index.status();
  assert.equal(before.indexedFiles, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  fs.writeFileSync(file, "export function secondVersion() {}\n");

  assert.equal(index.search("firstVersion").matches.length, 0);
  assert.equal(index.search("secondVersion").matches.length, 1);

  fs.unlinkSync(file);
  assert.equal(index.search("secondVersion").matches.length, 0);
  assert.equal(index.status().indexedFiles, 0);
});

test("symbol search filters by kind and reports bounded scan statistics", (t) => {
  const { root, index } = setup(t);
  fs.writeFileSync(
    path.join(root, "types.ts"),
    [
      "export class Shared {}",
      "export function SharedFactory() {}",
      "export interface SharedOptions {}",
    ].join("\n"),
  );

  const onlyClass = index.search("Shared", "class");
  assert.deepEqual(onlyClass.matches.map((m) => m.name), ["Shared"]);
  assert.ok(onlyClass.scannedFiles >= 1);
  assert.ok(onlyClass.scannedBytes > 0);
  assert.ok(Number.isInteger(onlyClass.scanMs));
  assert.equal(typeof onlyClass.indexTruncated, "boolean");
});
