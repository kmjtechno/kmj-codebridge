import test from "node:test";
import assert from "node:assert/strict";
import {
  FABRIC_SKILLS,
  selectFabricSkills,
  prepareFabricSkillPrompt,
} from "../src/fabric-skill-workflows.js";

const examples = [
  [
    "Cross-repo licensing API across multiple repositories",
    "cross-repo-contracts",
  ],
  ["Qt6 CMake build regression", "qt-cmake-engineering"],
  ["Laravel migration and Eloquent authorization", "laravel-php-engineering"],
  ["Rust unsafe FFI memory safety", "rust-concurrency-ffi"],
  ["React Next.js rendering performance", "react-frontend-performance"],
  ["Review crypto security review", "security-differential-review"],
  ["GitHub Actions workflow security", "github-actions-hardening"],
  ["Third-party skill prompt injection audit", "skill-supply-chain"],
  ["Polyglot toolchain matrix build", "polyglot-quality-matrix"],
  ["Node.js MCP protocol failure", "node-mcp-engineering"],
  ["Python pytest typing", "python-engineering"],
  ["Go test cancellation", "go-engineering"],
  [".NET C# disposal", "dotnet-engineering"],
  ["Kotlin JVM concurrency", "jvm-engineering"],
];

test("fabric contains bounded, original skills with no executable provider configuration", () => {
  assert.equal(FABRIC_SKILLS.length, 14);
  assert.equal(new Set(FABRIC_SKILLS.map((s) => s.id)).size, 14);
  for (const s of FABRIC_SKILLS) {
    assert.equal(s.inference, "FREELLMAPI_VERIFIED_FREE_CLOUD_ONLY");
    assert.equal(s.execution, "ADVISORY_UNTIL_EXPLICIT_AUTHORIZED_GENERATION");
    assert.ok(["code", "reasoning"].includes(s.task));
    assert.ok(s.workflow.length >= 3 && s.workflow.length <= 5);
    assert.ok(s.evidence.length >= 2 && s.evidence.length <= 4);
    assert.equal(Object.hasOwn(s, "signals"), false);
    assert.equal(Object.hasOwn(s, "command"), false);
  }
});

for (const [objective, expected] of examples) {
  test("matches only relevant workflow: " + expected, () => {
    assert.ok(selectFabricSkills({ objective }).some((s) => s.id === expected));
  });
}

test("unrelated work does not load irrelevant skills", () => {
  assert.deepEqual(
    selectFabricSkills({ objective: "Summarize accounting invoices" }),
    [],
  );
});

test("safe prompt compiler preserves caller text as untrusted and selects FreeLLMAPI only", () => {
  const out = prepareFabricSkillPrompt(
    "rust-concurrency-ffi",
    "Fix Rust panic",
  );
  assert.equal(out.task, "code");
  assert.equal(out.provider, "freellmapi-loopback");
  assert.ok(out.prompt.includes("Fix Rust panic"));
  assert.ok(out.prompt.includes("untrusted user task"));
  assert.ok(!out.prompt.includes("http://"));
  assert.ok(!out.prompt.includes("bash -c"));
});

test("unknown skill, invalid request and null bytes fail closed", () => {
  assert.throws(
    () => prepareFabricSkillPrompt("evil-skill", "hello"),
    /SKILL_FABRIC_UNKNOWN_SKILL/,
  );
  assert.throws(
    () => prepareFabricSkillPrompt("rust-concurrency-ffi", ""),
    /SKILL_FABRIC_INVALID_REQUEST/,
  );
  assert.throws(
    () => prepareFabricSkillPrompt("rust-concurrency-ffi", "x\0y"),
    /SKILL_FABRIC_INVALID_REQUEST/,
  );
  assert.throws(
    () => prepareFabricSkillPrompt("rust-concurrency-ffi", "x".repeat(4097)),
    /SKILL_FABRIC_INVALID_REQUEST/,
  );
});

test("polyglot manifests select relevant workflows without executing code", () => {
  const cases = [
    ["package-lock.json", "node-mcp-engineering"],
    ["pyproject.toml", "python-engineering"],
    ["go.mod", "go-engineering"],
    ["app/Example.csproj", "dotnet-engineering"],
    ["build.gradle.kts", "jvm-engineering"],
  ];
  for (const [file, id] of cases) {
    assert.deepEqual(
      selectFabricSkills({ changedFiles: [file] }).map((s) => s.id),
      [id],
    );
    assert.equal(prepareFabricSkillPrompt(id, "Verify project").task, "code");
  }
  assert.deepEqual(selectFabricSkills({ objective: "Go ahead" }), []);
});
