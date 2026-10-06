import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const doctor = path.join(root, "scripts/diagnose-main-platform-agent.sh");
const legacy = path.join(root, "scripts/verify-main-platform-online.sh");

test("VM connection doctor is shell-valid and locally read-only", () => {
  const source = fs.readFileSync(doctor, "utf8");
  assert.match(source, /kmj-codebridge-kmj-main-platform\.service/);
  assert.match(source, /\/etc\/kmj-codebridge-main-platform\/agent\.json/);
  assert.match(source, /\/etc\/kmj-codebridge\/agents\/kmj-main-platform\.json/);
  assert.match(source, /systemctl show "\$SERVICE" -p ExecStart/);
  assert.match(source, /credential_introspection_http/);
  assert.match(source, /gateway_agent_health_http/);
  assert.match(source, /node_access=DENIED_TO_SERVICE_USER/);
  assert.match(source, /https:\/\/kmj-codebridge-gateway\.onrender\.com/);
  assert.match(source, /legacy_project1=UNTOUCHED/);
  assert.doesNotMatch(source, /systemctl\s+(?:restart|stop|disable|enable)/);
  assert.doesNotMatch(source, /rm\s+-rf|chmod\s|chown\s|curl\s+[^\n]*\|\s*(?:sh|bash)/);
  assert.doesNotMatch(source, /console\.log\([^\n]*\.token|echo\s+[^\n]*\$\{?TOKEN/i);

  if (process.platform !== "win32") {
    const check = spawnSync("bash", ["-n", doctor], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
});

test("legacy verification now delegates without auto-restarting the agent", () => {
  const source = fs.readFileSync(legacy, "utf8");
  assert.match(source, /diagnose-main-platform-agent\.sh/);
  assert.doesNotMatch(source, /systemctl\s+(?:restart|stop|disable|enable)/);
  assert.doesNotMatch(source, /sleep\s+35/);
  if (process.platform !== "win32") {
    const check = spawnSync("bash", ["-n", legacy], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
});

test("plugin promotes the one-argument-free connection doctor", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "plugin/plugin.json"), "utf8"),
  );
  const prompts = manifest.extensions["com.openai"].interface.defaultPrompt;
  assert.ok(prompts[0].includes("CodeBridge connections"));
  assert.ok(prompts[0].includes("Do not reconnect OAuth"));
  const skill = fs.readFileSync(
    path.join(root, "plugin/skills/codebridge/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /connection_overview/);
  assert.match(skill, /Do not repeatedly reconnect OAuth/);
});
