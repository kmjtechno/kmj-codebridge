import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
import {
  extractLexicalSymbols,
  findIdentifierLocations,
  languageForExtension,
  REPO_INTELLIGENCE_ADAPTER,
} from "../src/repo-intelligence.js";

test("lexical adapter extracts symbols and exact identifier boundaries", () => {
  const source = [
    "export async function authenticate(user) { return user; }",
    "const authenticateUser = authenticate;",
    "authenticate('alice');",
    "",
  ].join("\n");
  assert.deepEqual(extractLexicalSymbols(source), [
    { kind: "function", name: "authenticate", line: 1 },
  ]);
  assert.deepEqual(findIdentifierLocations(source, "authenticate"), [
    { line: 1, column: 23 },
    { line: 2, column: 26 },
    { line: 3, column: 1 },
  ]);
  assert.equal(languageForExtension(".TS"), "typescript");
  assert.equal(languageForExtension(".txt"), null);
});

test("project repo intelligence is bounded, metadata-only and skips denied trees", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-intel-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(
      path.join(root, "src", "auth.ts"),
      [
        "export async function authenticate(user: string) { return user; }",
        "export function login() { return authenticate('alice'); }",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, "src", "other.ts"),
      "export const authenticateUser = true;\n",
    );
    fs.writeFileSync(
      path.join(root, "node_modules", "ignored.js"),
      "function authenticate() {}\n",
    );
    fs.writeFileSync(path.join(root, ".env"), "AUTH_SECRET=must-not-appear\n");

    const files = new ProjectFiles(root);
    const result = files.repoIntelligence("authenticate", "both", 10, 20);
    assert.equal(result.adapter, REPO_INTELLIGENCE_ADAPTER);
    assert.equal(result.fallback, true);
    assert.equal(result.identifier, "authenticate");
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, "src/auth.ts");
    assert.deepEqual(result.files[0].definitions, [
      { kind: "function", name: "authenticate", line: 1 },
    ]);
    assert.equal(result.files[0].references.length, 2);
    assert.equal(result.files[0].references[0].isDefinition, true);
    assert.equal(result.files[0].references[1].isDefinition, false);
    assert.ok(!JSON.stringify(result).includes("must-not-appear"));
    assert.ok(!JSON.stringify(result).includes("node_modules"));
    assert.ok(!JSON.stringify(result).includes("return authenticate"));
    assert.equal(typeof result.scannedBytes, "number");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project repo intelligence fails closed on unsafe identifiers and caps results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-intel-bounds-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "many.js"),
      "function target() {}\n" + "target();\n".repeat(20),
    );
    const files = new ProjectFiles(root);
    const result = files.repoIntelligence("target", "references", 10, 3);
    assert.equal(result.resultCount, 3);
    assert.equal(result.truncated, true);
    assert.throws(
      () => files.repoIntelligence("../target", "both", 10, 10),
      /INVALID_REPO_INTELLIGENCE/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
