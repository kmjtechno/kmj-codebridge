import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles, isDeniedName } from "../src/policy.js";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-deny-"));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "tst_designtokens.cpp"), "// ok\n");
  fs.writeFileSync(path.join(root, "src", "DesignTokens.h"), "#pragma once\n");
  fs.writeFileSync(path.join(root, "src", "tokenizer.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "api-token.txt"), "t\n");
  fs.writeFileSync(path.join(root, "githubtoken"), "t\n");
  fs.writeFileSync(path.join(root, "client_secret.json"), "{}\n");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return new ProjectFiles(root);
}

test("source files whose names merely contain a credential word are readable", (t) => {
  const files = fixture(t);
  assert.equal(files.read("tests/tst_designtokens.cpp").content, "// ok\n");
  assert.equal(files.read("src/DesignTokens.h").content, "#pragma once\n");
  assert.equal(files.read("src/tokenizer.ts").content, "export {};\n");
  const listed = files.list("tests").entries.map((entry) => entry.name);
  assert.ok(listed.includes("tst_designtokens.cpp"));
});

test("credential-named files stay protected", (t) => {
  const files = fixture(t);
  for (const name of ["api-token.txt", "githubtoken", "client_secret.json"])
    assert.throws(() => files.read(name), /PATH_DENIED/, name);
  const listed = files.list().entries.map((entry) => entry.name);
  assert.ok(!listed.includes("api-token.txt"));
  assert.ok(!listed.includes("githubtoken"));
  assert.ok(!listed.includes("client_secret.json"));
});

test("name rule: exact credential segments and non-source names are denied", () => {
  for (const name of [
    ".env",
    ".env.local",
    ".ssh",
    "id_ed25519",
    "server.pem",
    "signing.pfx",
    "token.ts",
    "secrets.yaml",
    "credentials",
    "credentials.json",
    "accesstoken.txt",
    "apiToken.json",
    "tokens",
  ])
    assert.equal(isDeniedName(name), true, name);
  for (const name of [
    "tst_designtokens.cpp",
    "DesignTokens.h",
    "tokenizer.ts",
    "SecretManagerClient.cs",
    "README.md",
    "main.cpp",
  ])
    assert.equal(isDeniedName(name), false, name);
});
