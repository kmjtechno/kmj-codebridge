import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  attestDevelopmentCi,
  DEVELOPMENT_UNIT,
  DEVELOPMENT_UNIT_PATH,
  DEVELOPMENT_HELPER_PATH,
  DEVELOPMENT_HELPER_SHA256,
  DEVELOPMENT_UNIT_CONTENT,
} from "../src/development-unit-policy.js";
import { createSupervisorHandler } from "../src/supervisor.js";

const properties = {
  LoadState: "loaded",
  ActiveState: "inactive",
  FragmentPath: DEVELOPMENT_UNIT_PATH,
  DropInPaths: "",
  User: "kmjdevci",
  Group: "kmjdevci",
  NoNewPrivileges: "yes",
  ProtectSystem: "strict",
  ProtectHome: "yes",
  PrivateTmp: "yes",
  PrivateDevices: "yes",
  PrivateNetwork: "yes",
  CapabilityBoundingSet: "",
  AmbientCapabilities: "",
  EnvironmentFiles: "",
  ReadWritePaths: "/var/lib/kmj-codebridge-development-ci",
};
const helper = fs.readFileSync(
  new URL("../scripts/production/kmj-codebridge-dev-probe.py", import.meta.url),
  "utf8",
);
const unit = fs.readFileSync(
  new URL(
    "../scripts/production/kmj-codebridge-development-ci.service",
    import.meta.url,
  ),
  "utf8",
);
function fixture(overrides = {}) {
  const calls = [];
  const started = [];
  const props = { ...properties, ...(overrides.properties ?? {}) };
  const handleProps = (exe, args) => {
    calls.push({ exe, args });
    assert.equal(exe, "/usr/bin/systemctl");
    assert.equal(args[0], "show");
    assert.equal(args[1], DEVELOPMENT_UNIT);
    assert.equal(args.at(-1), "--no-pager");
    return [
      ...args
        .filter((arg) => arg.startsWith("--property="))
        .map((arg) => {
          const name = arg.slice("--property=".length);
          return `${name}=${props[name] ?? ""}`;
        }),
      ...(overrides.extraLines ?? []),
    ].join("\n");
  };
  const lstat = (file) => {
    if (
      ![
        DEVELOPMENT_UNIT_PATH,
        DEVELOPMENT_HELPER_PATH,
        "/etc/systemd/system",
        "/usr/local/libexec",
      ].includes(file)
    )
      throw Error("UNEXPECTED_PATH");
    const dir = file.endsWith("system") || file.endsWith("libexec");
    const bad = overrides.badMetadataPath === file;
    return {
      isFile: () => !dir,
      isDirectory: () => dir,
      isSymbolicLink: () => bad,
      uid: bad ? 1000 : 0,
      mode: bad ? 0o100666 : (overrides.modeByPath?.[file] ?? (dir ? 0o40755 : 0o100644)),
      nlink: overrides.linkCountByPath?.[file] ?? 1,
      size: file === DEVELOPMENT_UNIT_PATH ? unit.length : helper.length,
    };
  };
  const readFile = (file) => {
    if (file === DEVELOPMENT_UNIT_PATH) return overrides.unit ?? unit;
    if (file === DEVELOPMENT_HELPER_PATH) return overrides.helper ?? helper;
    throw Error("UNEXPECTED_FILE");
  };
  const args = { run: handleProps, lstat, readFile };
  const supervisor = createSupervisorHandler({
    ...args,
    start: (service) => started.push(service),
  });
  return { args, supervisor, calls, started, props };
}

test("pinned unit and helper are exactly the source contract", () => {
  assert.equal(unit, DEVELOPMENT_UNIT_CONTENT);
  assert.equal(
    createHash("sha256").update(helper).digest("hex"),
    DEVELOPMENT_HELPER_SHA256,
  );
  assert.match(helper, /os.geteuid\(\) == 0/);
  assert.doesNotMatch(unit, /^User=root$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^PrivateNetwork=yes$/m);
});

test("pinned root-owned non-root probe attests and starts fixed unit only", async () => {
  const { args, supervisor, started } = fixture();
  assert.deepEqual(attestDevelopmentCi(args), {
    unit: DEVELOPMENT_UNIT,
    installed: true,
    ready: true,
    reason: "PINNED_NONROOT_UNIT_VERIFIED",
    runsAsRoot: false,
    productionReleaseApproved: false,
  });
  const action = await supervisor({
    op: "development_ci_start",
    confirmation: "START_PINNED_NONROOT_DEV_PROBE",
  });
  assert.equal(action.response.accepted, true);
  assert.equal(action.response.runsAsRoot, false);
  assert.deepEqual(started, []);
  action.afterSend();
  assert.deepEqual(started, [DEVELOPMENT_UNIT]);
});

test("hardening bypass, wrong ownership, changed helper, active service all fail closed", async () => {
  const scenarios = [
    [{ properties: { User: "root" } }, "UNIT_PROPERTIES_UNSAFE"],
    [
      { properties: { DropInPaths: "/etc/systemd/system/override.conf" } },
      "UNIT_PROPERTIES_UNSAFE",
    ],
    [{ properties: { NoNewPrivileges: "no" } }, "UNIT_PROPERTIES_UNSAFE"],
    [{ properties: { ReadWritePaths: "/etc" } }, "UNIT_PROPERTIES_UNSAFE"],
    [{ properties: { ActiveState: "active" } }, "UNIT_NOT_IDLE"],
    [{ properties: { LoadState: "not-found" } }, "UNIT_NOT_INSTALLED"],
    [{ badMetadataPath: DEVELOPMENT_UNIT_PATH }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [{ badMetadataPath: DEVELOPMENT_HELPER_PATH }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [{ modeByPath: { [DEVELOPMENT_UNIT_PATH]: 0o104644 } }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [{ modeByPath: { [DEVELOPMENT_HELPER_PATH]: 0o102644 } }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [{ modeByPath: { [DEVELOPMENT_HELPER_PATH]: 0o101644 } }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [{ modeByPath: { "/usr/local/libexec": 0o42755 } }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [{ linkCountByPath: { [DEVELOPMENT_HELPER_PATH]: 2 } }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [{ unit: unit + "# changed\n" }, "UNIT_CONTENT_MISMATCH"],
    [{ helper: helper + "# changed\n" }, "HELPER_HASH_MISMATCH"],
    [{ extraLines: ["User=root"] }, "UNIT_PROPERTIES_UNVERIFIED"],
  ];
  for (const [overrides, reason] of scenarios) {
    const { args, supervisor, started } = fixture(overrides);
    assert.equal(attestDevelopmentCi(args).reason, reason);
    await assert.rejects(
      supervisor({
        op: "development_ci_start",
        confirmation: "START_PINNED_NONROOT_DEV_PROBE",
      }),
      /SUPERVISOR_DEVELOPMENT_CI_NOT_READY/,
    );
    assert.deepEqual(started, []);
  }
});

test("unsafe unit reveals only fixed property names, never effective values or authorization", async () => {
  const { args, supervisor, started } = fixture({
    properties: {
      User: "root",
      ReadWritePaths: "/root/secrets/my-key",
      EnvironmentFiles: "/etc/my-secret-token",
    },
  });
  const result = attestDevelopmentCi(args);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "UNIT_PROPERTIES_UNSAFE");
  assert.deepEqual(result.mismatchedProperties, [
    "User",
    "EnvironmentFiles",
    "ReadWritePaths",
  ]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /my-key|my-secret-token|secrets/);
  await assert.rejects(
    supervisor({
      op: "development_ci_start",
      confirmation: "START_PINNED_NONROOT_DEV_PROBE",
    }),
    /SUPERVISOR_DEVELOPMENT_CI_NOT_READY/,
  );
  assert.deepEqual(started, []);
});

test("root development probe rejects caller-selected shell, unit, path and missing confirmation", async () => {
  const { supervisor, calls, started } = fixture();
  for (const fields of [
    { command: "/bin/bash" },
    { argv: ["sh", "-c", "id"] },
    { unit: "ssh.service" },
    { path: "/root/.ssh" },
    { projectId: "another" },
    { confirmation: "START_OTHER_SERVICE" },
  ]) {
    await assert.rejects(
      supervisor({ op: "development_ci_start", ...fields }),
      /INVALID_SUPERVISOR_REQUEST/,
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(started, []);
});

test("CloudOS supervisor cannot start another project's development unit", async () => {
  const { args } = fixture();
  const supervisor = createSupervisorHandler({ ...args, profile: "cloudos" });
  await assert.rejects(
    supervisor({
      op: "development_ci_start",
      confirmation: "START_PINNED_NONROOT_DEV_PROBE",
    }),
    /SUPERVISOR_OPERATION_NOT_ALLOWED/,
  );
});

test("start callback reattests and refuses changed effective service", async () => {
  const { supervisor, props, started } = fixture();
  const first = await supervisor({
    op: "development_ci_start",
    confirmation: "START_PINNED_NONROOT_DEV_PROBE",
  });
  assert.equal(first.response.accepted, true);
  props.User = "root";
  first.afterSend();
  assert.deepEqual(started, []);
});
