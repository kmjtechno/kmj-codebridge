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
  NeedDaemonReload: "no",
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
    const trustedDirs = new Set([
      "/",
      "/etc",
      "/etc/systemd",
      "/etc/systemd/system",
      "/usr",
      "/usr/local",
      "/usr/local/libexec",
    ]);
    if (
      !trustedDirs.has(file) &&
      ![DEVELOPMENT_UNIT_PATH, DEVELOPMENT_HELPER_PATH].includes(file)
    )
      throw Error("UNEXPECTED_PATH");
    const dir = trustedDirs.has(file);
    const bad = overrides.badMetadataPath === file;
    return {
      isFile: () => !dir,
      isDirectory: () => dir,
      isSymbolicLink: () => bad || overrides.symlinkPath === file,
      uid: bad ? 1000 : (overrides.uidByPath?.[file] ?? 0),
      mode: bad
        ? 0o100666
        : (overrides.modeByPath?.[file] ?? (dir ? 0o40755 : 0o100644)),
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
    [{ properties: { NeedDaemonReload: "yes" } }, "UNIT_PROPERTIES_UNSAFE"],
    [{ properties: { ReadWritePaths: "/etc" } }, "UNIT_PROPERTIES_UNSAFE"],
    [{ properties: { ActiveState: "active" } }, "UNIT_NOT_IDLE"],
    [{ properties: { LoadState: "not-found" } }, "UNIT_NOT_INSTALLED"],
    [{ badMetadataPath: DEVELOPMENT_UNIT_PATH }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [{ badMetadataPath: DEVELOPMENT_HELPER_PATH }, "ROOT_OWNERSHIP_UNVERIFIED"],
    [
      { modeByPath: { [DEVELOPMENT_UNIT_PATH]: 0o104644 } },
      "ROOT_OWNERSHIP_UNVERIFIED",
    ],
    [
      { modeByPath: { [DEVELOPMENT_HELPER_PATH]: 0o102644 } },
      "ROOT_OWNERSHIP_UNVERIFIED",
    ],
    [
      { modeByPath: { [DEVELOPMENT_HELPER_PATH]: 0o101644 } },
      "ROOT_OWNERSHIP_UNVERIFIED",
    ],
    [
      { modeByPath: { "/usr/local/libexec": 0o42755 } },
      "ROOT_OWNERSHIP_UNVERIFIED",
    ],
    [
      { linkCountByPath: { [DEVELOPMENT_HELPER_PATH]: 2 } },
      "ROOT_OWNERSHIP_UNVERIFIED",
    ],
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

test("untrusted ancestor anywhere in protected unit/helper path rejects start", async () => {
  const ancestors = [
    "/",
    "/etc",
    "/etc/systemd",
    "/etc/systemd/system",
    "/usr",
    "/usr/local",
    "/usr/local/libexec",
  ];
  for (const path of ancestors) {
    const { args, supervisor, started } = fixture({ badMetadataPath: path });
    assert.equal(attestDevelopmentCi(args).reason, "ROOT_OWNERSHIP_UNVERIFIED");
    await assert.rejects(
      supervisor({
        op: "development_ci_start",
        confirmation: "START_PINNED_NONROOT_DEV_PROBE",
      }),
      /SUPERVISOR_DEVELOPMENT_CI_NOT_READY/,
    );
    assert.deepEqual(started, []);
  }
  for (const path of ["/etc/systemd", "/usr/local"]) {
    for (const override of [
      { symlinkPath: path },
      { uidByPath: { [path]: 1000 } },
      { modeByPath: { [path]: 0o40777 } },
    ]) {
      const { args, supervisor, started } = fixture(override);
      assert.equal(
        attestDevelopmentCi(args).reason,
        "ROOT_OWNERSHIP_UNVERIFIED",
      );
      await assert.rejects(
        supervisor({
          op: "development_ci_start",
          confirmation: "START_PINNED_NONROOT_DEV_PROBE",
        }),
        /SUPERVISOR_DEVELOPMENT_CI_NOT_READY/,
      );
      assert.deepEqual(started, []);
    }
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

test("failed bulk unit query exposes only fixed diagnostic names and never authorizes start", async () => {
  const { args, started } = fixture({
    properties: {
      User: "root",
      EnvironmentFiles: "/etc/super-secret-credential",
      ReadWritePaths: "/root/top-secret",
      ActiveState: "failed",
    },
  });
  const original = args.run;
  args.run = (exe, argv) => {
    if (argv.filter((arg) => arg.startsWith("--property=")).length > 1)
      throw Error("secret-bulk-error-do-not-return");
    if (argv.includes("--property=ProtectHome"))
      throw Error("secret-single-error-do-not-return");
    return original(exe, argv);
  };
  const supervisor = createSupervisorHandler({
    ...args,
    start: (unit) => started.push(unit),
  });
  const result = attestDevelopmentCi(args);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "UNIT_PROPERTIES_UNAVAILABLE");
  assert.deepEqual(result.missingProperties, ["ProtectHome"]);
  assert.deepEqual(result.mismatchedProperties, [
    "ActiveState",
    "User",
    "EnvironmentFiles",
    "ReadWritePaths",
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /super-secret|top-secret|do-not-return|\/etc\/|\/root\//,
  );
  await assert.rejects(
    supervisor({
      op: "development_ci_start",
      confirmation: "START_PINNED_NONROOT_DEV_PROBE",
    }),
    /SUPERVISOR_DEVELOPMENT_CI_NOT_READY/,
  );
  assert.deepEqual(started, []);
});

test("corrupt single-property fallback is bounded and always fail closed", () => {
  const { args } = fixture();
  const original = args.run;
  args.run = (exe, argv) => {
    if (argv.filter((a) => a.startsWith("--property=")).length > 1)
      throw Error("bulk unavailable");
    if (argv.includes("--property=EnvironmentFiles"))
      return "EnvironmentFiles=/etc/secret-key\nUser=root";
    if (argv.includes("--property=ReadWritePaths"))
      return "ReadWritePaths=" + "x".repeat(1500);
    return original(exe, argv);
  };
  const result = attestDevelopmentCi(args);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "UNIT_PROPERTIES_UNAVAILABLE");
  assert.deepEqual(result.missingProperties, [
    "EnvironmentFiles",
    "ReadWritePaths",
  ]);
  assert.deepEqual(result.mismatchedProperties, []);
  assert.doesNotMatch(JSON.stringify(result), /secret-key|bulk unavailable/);
});

test("bulk unit parser never trims unsafe trailing values into a trusted policy match", async () => {
  for (const suffix of [" ", "\t", "\n\n"]) {
    const { args, started } = fixture();
    const original = args.run;
    args.run = (exe, argv) => {
      const output = original(exe, argv);
      return argv.filter((part) => part.startsWith("--property=")).length > 1
        ? output + suffix
        : output;
    };
    const supervisor = createSupervisorHandler({
      ...args,
      start: (unit) => started.push(unit),
    });
    const result = attestDevelopmentCi(args);
    assert.equal(result.ready, false);
    assert.ok(
      ["UNIT_PROPERTIES_UNSAFE", "UNIT_PROPERTIES_UNVERIFIED"].includes(
        result.reason,
      ),
    );
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

test("malformed bulk property output yields name-only diagnostics and never starts", async () => {
  const variants = [
    (output) => output.replace("User=root", "User=root\nUser=kmjdevci"),
    (output) => output + "\nSecret=/etc/should-never-appear",
    (output) => output.replace("User=root\n", ""),
    (output) => output + "\0",
    (output) => output + "x".repeat(9000),
  ];
  for (const mutate of variants) {
    const { args, started } = fixture({
      properties: { User: "root", EnvironmentFiles: "/etc/hidden-credential" },
    });
    const original = args.run;
    args.run = (exe, argv) => {
      const output = original(exe, argv);
      return argv.filter((part) => part.startsWith("--property=")).length > 1
        ? mutate(output)
        : output;
    };
    const supervisor = createSupervisorHandler({
      ...args,
      start: (unit) => started.push(unit),
    });
    const result = attestDevelopmentCi(args);
    assert.equal(result.ready, false);
    assert.equal(result.reason, "UNIT_PROPERTIES_UNVERIFIED");
    assert.ok(result.mismatchedProperties.includes("User"));
    assert.ok(result.mismatchedProperties.includes("EnvironmentFiles"));
    assert.doesNotMatch(
      JSON.stringify(result),
      /hidden-credential|should-never-appear|\/etc\//,
    );
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

test("stale PID 1 unit cache fails closed before and after Supervisor ACK", async () => {
  const stale = fixture({ properties: { NeedDaemonReload: "yes" } });
  const result = attestDevelopmentCi(stale.args);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "UNIT_PROPERTIES_UNSAFE");
  assert.deepEqual(result.mismatchedProperties, ["NeedDaemonReload"]);
  await assert.rejects(
    stale.supervisor({
      op: "development_ci_start",
      confirmation: "START_PINNED_NONROOT_DEV_PROBE",
    }),
    /SUPERVISOR_DEVELOPMENT_CI_NOT_READY/,
  );
  assert.deepEqual(stale.started, []);

  const { supervisor, props, started } = fixture();
  const accepted = await supervisor({
    op: "development_ci_start",
    confirmation: "START_PINNED_NONROOT_DEV_PROBE",
  });
  assert.equal(accepted.response.accepted, true);
  props.NeedDaemonReload = "yes";
  accepted.afterSend();
  assert.deepEqual(started, []);
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
