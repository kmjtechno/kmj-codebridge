import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { hostname } from "node:os";

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
  stage: "5e119d7512a3ca6e33b13bef9ad20d8d43445ed71c2d300f30cb15bb52c07f9b",
  runner: "8269360898a9c7c70128406f80ba6a4de2a658068bca6e0a30803734e288d5fa",
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
    stage.includes('cp -a -- "$oldapp/.env" "$app/.env"') &&
    stage.includes(
      'runuser -u kmjstage -- test -r "$app/.env" || block STAGING_ENV_READ',
    ) &&
    !stage.includes('install -m 0600 "$oldapp/.env" "$app/.env"') &&
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
    runner.includes("deny SYSTEMD_EFFECTIVE_UNIT") &&
    runner.includes("SYSTEMD_DROPINS_FORBIDDEN") &&
    runner.includes("SYSTEMD_DAEMON_CACHE_STALE") &&
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
    [
      "stage",
      'cp -a -- "$oldapp/.env" "$app/.env"',
      'install -m 0600 "$oldapp/.env" "$app/.env"',
    ],
    [
      "stage",
      'runuser -u kmjstage -- test -r "$app/.env" || block STAGING_ENV_READ',
      "true # bypass env readability",
    ],
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
    const changed = {
      ...original,
      [file]: original[file].replaceAll(from, to),
    };
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

// This is an actual execution negative test, not a string/regex contract.
// Never execute a candidate on the approved host as root from CI or a laptop.
const approvedRootHost =
  hostname().split(".")[0] === "KMJ-elite" && process.getuid?.() === 0;

test(
  "candidate entrypoints fail closed before side effects off the approved root host",
  { skip: process.platform === "win32" || approvedRootHost },
  () => {
    for (const [name, expectedMarker] of [
      ["stage", "STAGING_UI_UPDATE=BLOCKED_HOST"],
      ["runner", "KMJ_STAGING=BLOCKED_ROOT_HOST"],
    ]) {
      const result = spawnSync("bash", [paths[name]], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.status, 2, name + ": unexpected exit");
      assert.equal(result.stdout.trim(), expectedMarker, name);
    }
  },
);
