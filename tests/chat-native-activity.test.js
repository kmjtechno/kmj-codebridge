import assert from "node:assert/strict";
import test from "node:test";
import { toolActivityMeta, toolSecurityMeta } from "../src/client-extensions.js";

test("native activity metadata distinguishes tool categories without claiming success", () => {
  for (const [name, expected] of [
    ["connection_doctor", "Checking device connection"],
    ["read_file", "Inspecting project source"],
    ["write_files_atomic", "Requesting guarded file changes"],
    ["run_quality_gate", "Requesting verification"],
    ["github_pull_request", "Checking Git and GitHub"],
    ["supervisor_restart", "Requesting Supervisor operation"],
  ]) {
    const meta = toolActivityMeta(name);
    assert.equal(meta["openai/toolInvocation/invoking"], expected + "…");
    assert.equal(
      meta["openai/toolInvocation/invoked"],
      "CodeBridge response received",
    );
    for (const value of Object.values(meta)) assert.ok(value.length <= 64);
  }
});

test("activity labels preserve OAuth and non-OAuth permission metadata", () => {
  const oauth = toolSecurityMeta({}, "write", "write_file");
  assert.deepEqual(oauth.securitySchemes, [
    { type: "oauth2", scopes: ["codebridge:write"] },
  ]);
  assert.deepEqual(oauth._meta.securitySchemes, oauth.securitySchemes);
  assert.equal(
    oauth._meta["openai/toolInvocation/invoking"],
    "Requesting guarded file changes…",
  );
  const local = toolSecurityMeta(null, "read", "read_file");
  assert.equal(local.securitySchemes, undefined);
  assert.equal(
    local._meta["openai/toolInvocation/invoking"],
    "Inspecting project source…",
  );
});
