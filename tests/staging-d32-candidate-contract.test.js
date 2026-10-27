import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = fileURLToPath(
  new URL("../examples/main-platform-staging/d32/", import.meta.url),
);
const paths = {
  stage: join(directory, "guarded-stage.sh"),
  runner: join(directory, "owner-runner.sh"),
  unit: join(directory, "owner-staging.service"),
};
const original = Object.fromEntries(
  Object.entries(paths).map(([name, path]) => [
    name,
    readFileSync(path, "utf8"),
  ]),
);
const expected = {
  stage: "e6b1c58ff8014b062b2df3d3ba20385c62409f3752d8f2064a06683a793c9318",
  runner: "301223172dcebeef78114985899db7a5ae9c7e9dbe79d291bb31c5bbc5878c8b",
  unit: "9342fbacad8f05d52cde7df5fcf8d9599c3704e09f0edf3e6e48797c48af569a",
};
const approved = "d32df111e3a8dae75c8d3321a80f07424c23fe77";
const previous = "9d15e14e39564ffb1e66085a483feb8331f9718f";
const fixedRunner =
  "/usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh";

function contract({ stage, runner, unit }) {
  return (
    stage.includes("sha=" + approved) &&
    stage.includes("old=" + previous) &&
    stage.includes("STAGING_UI_ROLLBACK=PASS") &&
    stage.includes("STAGING_CLOUD_REQUESTS=NONE") &&
    stage.includes("STAGING_PRODUCT_WRITES=NONE") &&
    stage.includes("STAGING_DATABASE_MIGRATIONS=NONE") &&
    runner.includes("approved=" + approved) &&
    runner.includes("prior=" + previous) &&
    runner.includes("source_sha=" + expected.stage) &&
    runner.includes("main-platform-staging-approval.json") &&
    runner.includes("OWNER_MANIFEST_OR_INSTALL") &&
    runner.includes("runnerSha256") &&
    runner.includes("unitSha256") &&
    runner.includes("backupVerified") &&
    runner.includes("rollbackVerified") &&
    runner.includes("storageVerified") &&
    runner.includes("zeroAdditionalCostVerified") &&
    runner.includes("STAGING_RECEIPT_VERDICT") &&
    runner.includes("OWNER_AUTHENTICATED_GENERATE_SAVE_REOPEN=NOT_VERIFIED") &&
    runner.includes("PRODUCTION_DEPLOYMENT=NOT_ATTEMPTED") &&
    unit.includes("Type=oneshot") &&
    unit.includes("ExecStart=/usr/bin/bash " + fixedRunner) &&
    !unit.includes("ExecStartPre=")
  );
}

test("staging owner-install candidate is exact-byte pinned", () => {
  for (const [name, content] of Object.entries(original)) {
    const hash = createHash("sha256").update(content).digest("hex");
    assert.equal(hash, expected[name], name);
  }
  assert.equal(contract(original), true);
});

test("candidate static trust contract rejects stale and weakened variants", () => {
  const mutations = [
    ["stage", "sha=" + approved, "sha=" + previous],
    ["stage", "old=" + previous, "old=" + approved],
    ["stage", "STAGING_UI_ROLLBACK=PASS", "STAGING_UI_ROLLBACK=SKIP"],
    ["stage", "STAGING_CLOUD_REQUESTS=NONE", "STAGING_CLOUD_REQUESTS=YES"],
    ["stage", "STAGING_PRODUCT_WRITES=NONE", "STAGING_PRODUCT_WRITES=YES"],
    ["runner", "source_sha=" + expected.stage, "source_sha=" + expected.runner],
    ["runner", "main-platform-staging-approval.json", "no-approval.json"],
    ["runner", "OWNER_MANIFEST_OR_INSTALL", "ALLOW_WITHOUT_MANIFEST"],
    ["runner", "zeroAdditionalCostVerified", "paidCloudEnabled"],
    ["runner", "runnerSha256", "unverifiedRunner"],
    ["runner", "unitSha256", "unverifiedUnit"],
    ["runner", "STAGING_RECEIPT_VERDICT", "STAGING_UNVERIFIED"],
    ["unit", "ExecStart=/usr/bin/bash " + fixedRunner, "ExecStart=/bin/sh"],
  ];
  for (const [file, from, to] of mutations) {
    assert.ok(original[file].includes(from), file + " missing fixture");
    const changed = { ...original, [file]: original[file].replace(from, to) };
    assert.equal(contract(changed), false, file + ": " + from);
  }
});

test(
  "candidate shell and embedded Python pass syntax checks on Linux",
  { skip: process.platform === "win32" },
  () => {
    for (const name of ["stage", "runner"]) {
      const result = spawnSync("bash", ["-n", paths[name]], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, name + ": " + result.stderr);
    }
    const match = original.runner.match(
      /python3 - "\$approved" "\$prior" <<'PY' \|\| deny OWNER_MANIFEST_OR_INSTALL\n([\s\S]*?)\nPY/,
    );
    assert.ok(match, "manifest validation Python block is present");
    const result = spawnSync(
      "python3",
      ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
      { input: match[1], encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);
