import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createSupervisorHandler } from "../src/supervisor.js";
import {
  WRITER_IDENTITY_INSPECT_PATH,
  WRITER_IDENTITY_INSPECT_SHA256,
  WRITER_IDENTITY_INSPECT_CONFIRMATION,
  parseWriterIdentityInspect,
} from "../src/main-platform-writer-identity-policy.js";

const SOURCE = fs.readFileSync(
  new URL("./fixtures/elite_activation_writer_identity_doctor.py", import.meta.url),
  "utf8",
);
const CONFIRM = WRITER_IDENTITY_INSPECT_CONFIRMATION;
const GOOD = [
  "KMJ_ACTIVATION_WRITER_IDENTITY=READY_FOR_OWNER_REVIEW_NOT_INSTALLED",
  "KMJ_FPM_WORKERS_AT_SNAPSHOT=3",
  "ACTIVATION_REQUEST=NOT_CREATED",
  "ROOT_BROKER=NOT_STARTED",
  "PRODUCTION_MUTATION=NONE",
].join("\n") + "\n";

const rootFile = (v = {}) => ({
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  uid: 0,
  nlink: 1,
  mode: 0o100750,
  size: SOURCE.length,
  ...v,
});
const rootDir = (v = {}) => ({
  isFile: () => false,
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  mode: 0o40755,
  ...v,
});

function harness({
  file = rootFile(),
  dir = rootDir(),
  script = SOURCE,
  output = GOOD,
  runThrows = false,
  swapAfter = false,
  ancestorOverrides = {},
} = {}) {
  const runs = [];
  let reads = 0;
  const handle = createSupervisorHandler({
    run: (exe, args, options) => {
      runs.push({ exe, args, options });
      if (runThrows) throw new Error("SECRET /root/.ssh/id_ed25519");
      return output;
    },
    lstat: (p) => {
      if (p === WRITER_IDENTITY_INSPECT_PATH) return file;
      if (["/", "/usr", "/usr/local", "/usr/local/libexec"].includes(p))
        return Object.hasOwn(ancestorOverrides, p) ? ancestorOverrides[p] : dir;
      throw new Error("UNEXPECTED_PATH");
    },
    readFile: (p) => {
      assert.equal(p, WRITER_IDENTITY_INSPECT_PATH);
      reads += 1;
      return swapAfter && reads > 1 ? "REPLACED" : script;
    },
    start: () => assert.fail("MUST_NOT_START"),
    restart: () => assert.fail("MUST_NOT_RESTART"),
  });
  return { handle, runs };
}

test("pinned fixture exactly matches independent reviewed Main Platform inspector", () => {
  assert.equal(
    createHash("sha256").update(SOURCE, "utf8").digest("hex"),
    WRITER_IDENTITY_INSPECT_SHA256,
  );
  assert.equal(
    WRITER_IDENTITY_INSPECT_PATH,
    "/usr/local/libexec/kmj-main-platform-activation-writer-identity-inspect.py",
  );
  assert.match(SOURCE, /PRODUCTION_LISTENER = "0100007F:525C"/);
  assert.match(SOURCE, /PRODUCTION_POOL = "php-fpm: pool kmj-elite-stage"/);
  assert.doesNotMatch(SOURCE, /shell=True|subprocess\.Popen|os\.chown|os\.chmod/);
});

test("parser returns only bounded inspect evidence, never release or install proof", () => {
  const parsed = parseWriterIdentityInspect(GOOD);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "activationApproved",
    "activationRequestCreated",
    "brokerStarted",
    "productionMutation",
    "productionPoolWorkers",
    "productionReleaseVerified",
    "status",
  ]);
  assert.equal(parsed.productionPoolWorkers, 3);
  assert.equal(parsed.activationApproved, false);
  assert.equal(parsed.brokerStarted, false);
  assert.equal(parsed.productionReleaseVerified, false);
});

test("output parser fails closed for raw process content, fake PASS and extra fields", () => {
  const invalid = [
    "",
    "secret /root/.ssh/id_ed25519\n" + GOOD,
    GOOD + "SECRET=abc\n",
    GOOD.replace("NOT_STARTED", "STARTED"),
    GOOD.replace("NOT_CREATED", "CREATED"),
    GOOD.replace("PRODUCTION_MUTATION=NONE", "PRODUCTION_MUTATION=LIVE"),
    GOOD.replace("REVIEW_NOT_INSTALLED", "DEPLOYED"),
    GOOD.replace("WORKERS_AT_SNAPSHOT=3", "WORKERS_AT_SNAPSHOT=0"),
    GOOD.replace("WORKERS_AT_SNAPSHOT=3", "WORKERS_AT_SNAPSHOT=1025"),
    GOOD.replace("WORKERS_AT_SNAPSHOT=3", "WORKERS_AT_SNAPSHOT=3;rm -rf /"),
    GOOD + "KMJ_FPM_WORKERS_AT_SNAPSHOT=4\n",
    GOOD.replace("NOT_CREATED", "NOT_CREATED\nENV=SECRET"),
    GOOD + "x".repeat(5000),
  ];
  for (const value of invalid)
    assert.throws(
      () => parseWriterIdentityInspect(value),
      /SUPERVISOR_WRITER_INSPECT_UNSAFE_OUTPUT/,
    );
});

test("fixed operation rejects all injected parameters before running", async () => {
  const h = harness();
  for (const override of [
    {},
    { confirmation: "yes" },
    { confirmation: CONFIRM, path: "/root/.ssh" },
    { confirmation: CONFIRM, command: "/bin/sh" },
    { confirmation: CONFIRM, args: ["--apply"] },
    { confirmation: CONFIRM, uid: 0 },
    { confirmation: CONFIRM, port: 22 },
    { confirmation: CONFIRM, env: { PHP_INI_SCAN_DIR: "/tmp" } },
  ])
    await assert.rejects(
      h.handle({ op: "main_platform_writer_identity_inspect", ...override }),
    );
  assert.equal(h.runs.length, 0);
});

test("root-owned exact file and fixed Python command required for PASS snapshot", async () => {
  const h = harness();
  const result = await h.handle({
    op: "main_platform_writer_identity_inspect",
    confirmation: CONFIRM,
  });
  assert.equal(result.response.mode, "READ_ONLY_FIXED_DIAGNOSTIC");
  assert.equal(result.response.diagnostic.productionPoolWorkers, 3);
  assert.equal(result.response.rootBrokerInstalled, false);
  assert.equal(result.response.releaseApprovalGranted, false);
  assert.equal(result.response.productionMutation, "NONE");
  assert.equal(result.response.rawProcessDataExposed, false);
  assert.deepEqual(h.runs, [{
    exe: "/usr/bin/python3",
    args: [
      "-I",
      "-B",
      WRITER_IDENTITY_INSPECT_PATH,
      "--inspect",
    ],
    options: { timeout: 25000, maxBuffer: 2048, cwd: "/" },
  }]);
});

test("absent, unsafe, replaced or non-root script never executes", async () => {
  const bad = [
    { file: rootFile({ uid: 1000 }) },
    { file: rootFile({ isFile: () => false }) },
    { file: rootFile({ isSymbolicLink: () => true }) },
    { file: rootFile({ mode: 0o100777 }) },
    { file: rootFile({ mode: 0o104750 }) },
    { file: rootFile({ nlink: 2 }) },
    { file: rootFile({ size: 0 }) },
    { file: rootFile({ size: 100000 }) },
    { dir: rootDir({ uid: 1000 }) },
    { dir: rootDir({ mode: 0o40777 }) },
    { dir: rootDir({ isSymbolicLink: () => true }) },
    { script: "print('secret')" },
    { ancestorOverrides: { "/usr/local/libexec": rootDir({ uid: 1000 }) } },
  ];
  for (const v of bad) {
    const h = harness(v);
    await assert.rejects(
      h.handle({
        op: "main_platform_writer_identity_inspect",
        confirmation: CONFIRM,
      }),
      /SUPERVISOR_WRITER_INSPECT_NOT_READY/,
    );
    assert.equal(h.runs.length, 0);
  }
});

test("inspector exit 2 never becomes a PASS and never leaks raw exception", async () => {
  const h = harness({ runThrows: true });
  await assert.rejects(
    h.handle({ op: "main_platform_writer_identity_inspect", confirmation: CONFIRM }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_WRITER_INSPECT_BLOCKED");
      assert.doesNotMatch(String(error.message), /secret|\/root/);
      return true;
    },
  );
  assert.equal(h.runs.length, 1);
});

test("script replacement after execution blocks receipt", async () => {
  const h = harness({ swapAfter: true });
  await assert.rejects(
    h.handle({ op: "main_platform_writer_identity_inspect", confirmation: CONFIRM }),
    /SUPERVISOR_WRITER_INSPECT_NOT_READY/,
  );
  assert.equal(h.runs.length, 1);
});

test("non-Main-Platform Supervisor profile rejects the new root operation", async () => {
  const h = createSupervisorHandler({
    profile: "codebridge-dev-elite",
    run: () => assert.fail("MUST_NOT_RUN"),
  });
  await assert.rejects(
    h({ op: "main_platform_writer_identity_inspect", confirmation: CONFIRM }),
    /SUPERVISOR_OPERATION_NOT_ALLOWED/,
  );
});
