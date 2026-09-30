import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanDirectory } from "../scripts/scan-secrets.js";

const cwd = path.resolve(import.meta.dirname, "..");
// Fixtures are assembled at runtime so this file never contains a literal
// credential-shaped string that the repository scan would flag.
const fake = (prefix, n) => prefix + "Q".repeat(n);

test("secret scan flags planted credentials and private config without echoing them", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-scan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planted = {
    "a.json": `{"headers":{"Authorization":"Bearer ${"x".repeat(40)}"}}`,
    "b.md": "-----BEGIN " + "PRIVATE KEY-----",
    "c.txt": fake("sk-" + "ant-", 40),
    "d.txt": fake("gh" + "p_", 36),
    "gateway.json": "{}",
  };
  for (const [name, text] of Object.entries(planted))
    fs.writeFileSync(path.join(dir, name), text);
  const findings = scanDirectory(dir).join("\n");
  for (const name of Object.keys(planted))
    assert.match(findings, new RegExp(name.replace(".", "\\.")));
  assert.doesNotMatch(findings, /x{40}|Q{36}/);
});

test("secret scan accepts environment-variable header references", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-scan-ok-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    '{"headers":{"Authorization":"Bearer ${KMJ_CODEBRIDGE_TOKEN}"}}',
  );
  assert.deepEqual(scanDirectory(dir), []);
});

test("repository tracked files contain no credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/scan-secrets.js"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
