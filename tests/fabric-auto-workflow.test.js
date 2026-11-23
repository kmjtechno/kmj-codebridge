import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planAutomaticFabricWork,
  prepareAutomaticFabricPrompt,
} from "../src/fabric-auto-workflow.js";
import { createDispatcher, definitions } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

test("one-click auto plan selects relevant skills, remains a zero-execution advisory", () => {
  const plan = planAutomaticFabricWork({
    objective: "Fix Rust FFI concurrency and GitHub Actions CI",
    changedFiles: ["src/ffi.rs", ".github/workflows/verify.yml"],
  });
  assert.equal(plan.task, "code");
  assert.deepEqual(plan.selectedSkillIds, [
    "rust-concurrency-ffi",
    "github-actions-hardening",
  ]);
  assert.equal(plan.generation, "NOT_EXECUTED");
  assert.equal(plan.automaticallyExecutableNow, false);
  assert.equal(plan.route, "FREELLMAPI_ONLY_IF_AUTHORIZED");
  assert.ok(
    plan.independentOwnerGates.includes("PRODUCTION_DEPLOY_AND_SIGNING"),
  );
});

test("security review becomes primary ahead of code when genuinely relevant", () => {
  const plan = planAutomaticFabricWork({
    objective: "Security review: authentication vulnerability in Laravel PHP",
  });
  assert.equal(plan.task, "reasoning");
  assert.equal(plan.primarySkillId, "security-differential-review");
  assert.ok(plan.selectedSkillIds.includes("laravel-php-engineering"));
});

test("automatic skill matching recognizes explicit Hindi and Hinglish technology cues", () => {
  const cases = [
    ["लारवेल में queue error ठीक करो", "laravel-php-engineering"],
    ["रस्ट में FFI crash ठीक करो", "rust-concurrency-ffi"],
    ["क्यूटी widget crash fix करो", "qt-cmake-engineering"],
    ["सुरक्षा की समीक्षा करो", "security-differential-review"],
    ["रिएक्ट rendering performance ठीक करो", "react-frontend-performance"],
  ];
  for (const [objective, expected] of cases) {
    assert.equal(
      planAutomaticFabricWork({ objective }).primarySkillId,
      expected,
    );
  }
  const mixed = planAutomaticFabricWork({
    objective: "रस्ट FFI की सुरक्षा समीक्षा करो",
  });
  assert.equal(mixed.primarySkillId, "security-differential-review");
  assert.ok(mixed.selectedSkillIds.includes("rust-concurrency-ffi"));
  const ambiguous = planAutomaticFabricWork({ objective: "काम जारी रखो" });
  assert.equal(ambiguous.primarySkillId, null);
  const raw = "लारवेल में queue error ठीक करो";
  assert.ok(
    prepareAutomaticFabricPrompt({ objective: raw }).prompt.endsWith(raw),
  );
});

test("skill prompt is bounded and treats task text as untrusted", () => {
  const objective = "Fix Qt6 CMake crash";
  const out = prepareAutomaticFabricPrompt({ objective });
  assert.equal(out.selectedSkillIds[0], "qt-cmake-engineering");
  assert.ok(out.prompt.includes("Qt SDK"));
  assert.ok(out.prompt.includes(objective));
  assert.ok(out.prompt.includes("UNTRUSTED OWNER-APPROVED TASK TEXT"));
  assert.ok(!out.prompt.includes("curl --"));
});

test("reject malformed work requests rather than creating empty or unsafe jobs", () => {
  for (const args of [
    { objective: "" },
    { objective: "\0" },
    { objective: "x".repeat(4097) },
    { objective: "task", changedFiles: "src/foo.rs" },
    { objective: "task", changedFiles: Array(21).fill("foo.rs") },
    { objective: "task", failureSummary: "\0" },
  ]) {
    assert.throws(
      () => planAutomaticFabricWork(args),
      /FABRIC_AUTO_INVALID_OBJECTIVE/,
    );
  }
  const unknown = planAutomaticFabricWork({
    objective: "Write an invoice summary",
  });
  assert.deepEqual(unknown.selectedSkillIds, []);
  assert.equal(unknown.task, "general");
  assert.equal(unknown.automaticallyExecutableNow, false);
});

test("MCP one-click generate preserves permission, consent, no-paid and no-write gates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-fabric-auto-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const runner = new JobRunner(path.join(root, "jobs"));
  t.after(async () => {
    await runner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const requests = [];
  let proofs = 0;
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(root, "state"),
      projects: [
        { id: "p1", root: project, writable: true, gates: {}, commands: {} },
      ],
    },
    runner,
    () => ({ features: ["read", "execute"], limits: { concurrent_jobs: 1 } }),
    null,
    null,
    null,
    undefined,
    null,
    null,
    () =>
      createFreeLlmApiClient({
        apiKey: "freellmapi-fabric-test-key",
        approvedFreeChains: ["auto:code"],
        verifyZeroCostChain: ({ chain, observedAtEpochMs }) => {
          proofs += 1;
          return {
            source: "authenticated_provider_billing_and_route_binding",
            chain,
            routeBindingVerified: true,
            accountNoChargeVerified: true,
            noPaidFallback: true,
            inputPriceUsdPerToken: 0,
            outputPriceUsdPerToken: 0,
            requestsRemaining: 2,
            observedAtEpochMs,
            expiresAtEpochMs: observedAtEpochMs + 30000,
          };
        },
        request: async (r) => {
          if (r.path === "/v1/models") return { data: [{ id: "auto:code" }] };
          requests.push(r);
          return {
            choices: [
              {
                message: { content: "reviewed proposal only" },
                finish_reason: "stop",
              },
            ],
          };
        },
      }),
  );
  assert.ok(definitions.freellmapi_generate.input.autoSkill);
  const args = {
    device: "d1",
    project: "p1",
    autoSkill: true,
    prompt: "Review Rust FFI ownership",
    localProcessingApproved: true,
    upstreamCloudApproved: true,
  };
  const preview = await dispatch(
    "skill_recommendations",
    { device: "d1", project: "p1", objective: args.prompt },
    ["read"],
  );
  assert.equal(preview.automaticPlan.primarySkillId, "rust-concurrency-ffi");
  assert.equal(preview.automaticPlan.generation, "NOT_EXECUTED");
  assert.equal(requests.length, 0);
  await assert.rejects(
    dispatch("freellmapi_generate", args, ["read"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch(
      "freellmapi_generate",
      { ...args, skillId: "rust-concurrency-ffi" },
      ["execute"],
    ),
    /FABRIC_AUTO_MANUAL_CONFLICT/,
  );
  await assert.rejects(
    dispatch("freellmapi_generate", { ...args, upstreamCloudApproved: false }, [
      "execute",
    ]),
  );
  assert.equal(requests.length, 0);
  const result = await dispatch("freellmapi_generate", args, ["execute"]);
  assert.deepEqual(result.automaticFabric.selectedSkillIds, [
    "rust-concurrency-ffi",
  ]);
  assert.equal(result.automaticFabric.task, "code");
  assert.equal(result.automaticFabric.writesApplied, false);
  assert.equal(result.response, "reviewed proposal only");
  assert.equal(result.writesApplied, false);
  assert.equal(result.paidInference, null);
  assert.equal(proofs, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, "auto:code");
  assert.ok(requests[0].body.messages[0].content.includes("Rust"));
});

test("automatic classification does not bypass absent real billing attestation", async () => {
  let sent = 0;
  const client = createFreeLlmApiClient({
    apiKey: "freellmapi-fabric-test-key",
    approvedFreeChains: ["auto:code"],
    request: async (r) => {
      if (r.path === "/v1/models") return { data: [{ id: "auto:code" }] };
      sent += 1;
      return {};
    },
  });
  const auto = prepareAutomaticFabricPrompt({ objective: "Fix Rust FFI" });
  await assert.rejects(
    client.generateRouted({
      task: auto.task,
      prompt: auto.prompt,
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }),
    /FREELLMAPI_ZERO_COST_NOT_ATTESTED/,
  );
  assert.equal(sent, 0);
});
