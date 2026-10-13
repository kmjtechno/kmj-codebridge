import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCiFailure, createCiFailureReader } from "../src/ci-failure.js";

const SHA = "a".repeat(40);
const ENV = "CODEBRIDGE_TEST_CIRCLECI_TOKEN";
const TOKEN = "c".repeat(48);
const META =
  "https://circleci.com/api/v1.1/project/github/kmjtechno/kmj-main-platform/263";
const OUTPUT =
  "https://logs.example.com/step?Signature=private-presigned-secret";

function make(
  t,
  {
    status = "failed",
    exitCode = 1,
    outputUrl = OUTPUT,
    revision = SHA,
    lines = "PHPStan Error: line 17 token=secret-information\nUnexpected error",
    metaStatus = 200,
    outputStatus = 200,
    repositories = ["kmjtechno/kmj-main-platform"],
  } = {},
) {
  process.env[ENV] = TOKEN;
  t.after(() => delete process.env[ENV]);
  const calls = [];
  const client = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url) === META)
      return Response.json(
        {
          build_num: 263,
          vcs_revision: revision,
          steps: [
            {
              name: "Checkout",
              actions: [{ status: "success", exit_code: 0 }],
            },
            {
              name: "Static analysis",
              actions: [{ status, exit_code: exitCode, output_url: outputUrl }],
            },
          ],
        },
        { status: metaStatus },
      );
    if (String(url) === OUTPUT)
      return Response.json([{ type: "out", message: lines }], {
        status: outputStatus,
      });
    throw new Error("Unexpected outbound request: " + String(url));
  };
  const read = createCiFailureReader(
    {
      tokenEnv: ENV,
      repositories,
      outputHosts: ["logs.example.com"],
    },
    client,
  );
  return { read, calls };
}

test("read-only CircleCI diagnostics are bound to repository and exact SHA", async (t) => {
  const f = make(t);
  const result = await f.read("ci_status_failure_log", {
    repository: "kmjtechno/kmj-main-platform",
    jobNumber: 263,
    expectedHeadSha: SHA,
  });
  assert.equal(result.result, "FAILED_STEPS");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].category, "PHP_STATIC_ANALYSIS");
  assert.equal(result.steps[0].evidence, "REDACTED_OUTPUT");
  assert.match(result.steps[0].lines[0], /token=\[REDACTED\]/);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("secret-information"));
  assert.ok(!serialized.includes("private-presigned-secret"));
  assert.ok(!serialized.includes(TOKEN));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, META);
  assert.equal(f.calls[0].opts.headers["Circle-Token"], TOKEN);
  assert.equal(f.calls[0].opts.redirect, "error");
  assert.equal(f.calls[1].opts.headers, undefined);
  assert.equal(f.calls[1].opts.redirect, "error");
});

test("unapproved repo fails before any network request", async (t) => {
  const f = make(t);
  await assert.rejects(
    f.read("ci_status_failure_log", {
      repository: "kmjtechno/not-authorized",
      jobNumber: 263,
      expectedHeadSha: SHA,
    }),
    /CIRCLECI_REPOSITORY_DENIED/,
  );
  assert.equal(f.calls.length, 0);
});

test("exact SHA mismatch fails closed without exposing output URL", async (t) => {
  const f = make(t, { revision: "b".repeat(40) });
  await assert.rejects(
    f.read("ci_status_failure_log", {
      repository: "kmjtechno/kmj-main-platform",
      jobNumber: 263,
      expectedHeadSha: SHA,
    }),
    /CIRCLECI_HEAD_MISMATCH/,
  );
  assert.equal(f.calls.length, 1);
});

test("unapproved presigned URL hosts, localhost and private URLs never fetched", async (t) => {
  const f = make(t, {
    outputUrl: "http://127.0.0.1:8080/secrets?token=private",
  });
  const result = await f.read("ci_status_failure_log", {
    repository: "kmjtechno/kmj-main-platform",
    jobNumber: 263,
    expectedHeadSha: SHA,
  });
  assert.equal(result.steps[0].evidence, "OUTPUT_HOST_NOT_APPROVED");
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes("127.0.0.1"));
});

test("CircleCI authorization denial returns only safe error code", async (t) => {
  const f = make(t, { metaStatus: 403 });
  await assert.rejects(
    f.read("ci_status_failure_log", {
      repository: "kmjtechno/kmj-main-platform",
      jobNumber: 263,
      expectedHeadSha: SHA,
    }),
    /CIRCLECI_AUTHORIZATION_FAILED/,
  );
  assert.equal(f.calls.length, 1);
});

test("missing token fails closed before reader activation", (t) => {
  delete process.env[ENV];
  assert.throws(
    () =>
      createCiFailureReader({
        tokenEnv: ENV,
        repositories: ["kmjtechno/kmj-main-platform"],
        outputHosts: ["logs.example.com"],
      }),
    /CIRCLECI_CREDENTIAL_MISSING/,
  );
});

test("successful step never becomes failed evidence", async (t) => {
  const f = make(t, { status: "success", exitCode: 0 });
  const result = await f.read("ci_status_failure_log", {
    repository: "kmjtechno/kmj-main-platform",
    jobNumber: 263,
    expectedHeadSha: SHA,
  });
  assert.equal(result.result, "NO_FAILED_STEPS_OBSERVED");
  assert.deepEqual(result.steps, []);
  assert.equal(f.calls.length, 1);
});

test("oversized or untrusted logs are never echoed to the client", async (t) => {
  const f = make(t, {
    lines: "Not an error\n".repeat(20000),
  });
  const result = await f.read("ci_status_failure_log", {
    repository: "kmjtechno/kmj-main-platform",
    jobNumber: 263,
    expectedHeadSha: SHA,
  });
  assert.equal(result.steps[0].evidence, "OUTPUT_UNAVAILABLE");
  assert.equal(result.steps[0].lines.length, 0);
});

test("diagnostic classification is deterministic and never auto-patches", () => {
  assert.equal(
    classifyCiFailure(["error TS2339: missing property"]),
    "TYPESCRIPT",
  );
  assert.equal(
    classifyCiFailure(["phpstan property does not exist"]),
    "PHP_STATIC_ANALYSIS",
  );
  assert.equal(classifyCiFailure(["no usable output"]), "UNCLASSIFIED");
});
