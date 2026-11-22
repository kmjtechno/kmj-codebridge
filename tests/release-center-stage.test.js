import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessStagedRuntime,
  verifyStagedRuntime,
} from "../scripts/release-center-stage-verify.mjs";

const sha = "a".repeat(40);
const archive = "kmj-codebridge-0.3.2-aaaaaaaaaaaa.tar.gz";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codebridge-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  mkdirSync(runtime);
  const data = Buffer.from("test-source-archive");
  const manifest = {
    product: "KMJ CodeBridge",
    version: "0.3.2",
    revision: sha,
    archive,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    format: "source-runtime",
    signed: false,
  };
  const manifestPath = path.join(runtime, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(path.join(runtime, archive), data);
  return { root, runtime, manifestPath, manifest, data };
}
test("staging verifies exact SHA, unsigned archive digest and no production mutation", (t) => {
  const f = fixture(t);
  const result = verifyStagedRuntime(f.manifestPath, sha);
  assert.equal(result.ready, true);
  assert.equal(result.state, "STAGED_SOURCE_ONLY_OWNER_SIGNATURE_REQUIRED");
  assert.equal(result.productionMutation, "NONE");
  assert.equal(result.signed, false);
});
test("staging rejects stale SHA, forged signing, traversal, wrong size and hash", (t) => {
  const f = fixture(t);
  for (const [manifest, revision, bytes] of [
    [f.manifest, "b".repeat(40), f.data],
    [{ ...f.manifest, signed: true }, sha, f.data],
    [{ ...f.manifest, archive: "../../private.pem" }, sha, f.data],
    [{ ...f.manifest, bytes: 999 }, sha, f.data],
    [{ ...f.manifest, sha256: "b".repeat(64) }, sha, f.data],
    [f.manifest, "main", f.data],
  ])
    assert.equal(assessStagedRuntime(manifest, revision, bytes).ready, false);
});
test("staging rejects symlink archive rather than following it", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  rmSync(path.join(f.runtime, archive));
  const outside = path.join(f.root, "outside");
  writeFileSync(outside, f.data);
  symlinkSync(outside, path.join(f.runtime, archive));
  assert.throws(
    () => verifyStagedRuntime(f.manifestPath, sha),
    /STAGE_ARCHIVE_UNSAFE/,
  );
});
test("staging workflow stays read-only and runs complete isolated QA", () => {
  const workflow = readFileSync(".github/workflows/oneclick-stage.yml", "utf8");
  for (const token of [
    "workflow_dispatch:",
    "refs/heads/main",
    "npm test",
    "npm run check",
    "npm run package:runtime",
    "release-center-stage-verify.mjs",
    "persist-credentials: false",
    "cancel-in-progress: false",
  ])
    assert.ok(workflow.includes(token), token);
  assert.doesNotMatch(
    workflow,
    /id-token: write|contents: write|secrets\.|--apply|--sign|sudo /i,
  );
});
