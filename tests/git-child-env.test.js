import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { gitChildEnvironment } from "../src/git-child-env.js";

test("Git children never inherit native ModelFabric tokens, even under alternate names", () => {
  const token = "kmjmf_" + "a".repeat(48);
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    GIT_CONFIG_GLOBAL: "/home/dev/.gitconfig",
    CODEBRIDGE_KMJ_MODELFABRIC_TOKEN: token,
    codebridge_kmj_modelfabric_token_p520: "other",
    ALIAS: "Bearer " + token,
    GIT_TERMINAL_PROMPT: "1",
  };
  const env = gitChildEnvironment(source);
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    GIT_CONFIG_GLOBAL: "/home/dev/.gitconfig",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
  assert.equal(source.CODEBRIDGE_KMJ_MODELFABRIC_TOKEN, token);
});

test("all audited coding and repair Git paths use the isolated credential filter", () => {
  for (const name of [
    "autopilot-coding-worker",
    "worktree-lanes",
    "autopilot-repair-review",
    "autopilot-gate-worker",
    "autopilot-ci-watch-worker",
    "workspace-job-worker",
    "autopilot-repair-worker",
  ]) {
    const source = fs.readFileSync("src/" + name + ".js", "utf8");
    assert.match(source, /env: gitChildEnvironment\(\)/, name);
    assert.doesNotMatch(source, /\.\.\.process\.env/, name);
  }
});
