import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSupervisorHandler } from "../src/supervisor.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exactSha = "fabbec09255416b1110fa367583aeb7a55f0dc94";
const branch = "feat/payment-gateway-guided-onboarding-20261014";

test("private payment QA is pinned to one exact PR419 head and trusted project", () => {
  const fixed = source("scripts/ci-main-platform-pr419-fixed.sh");
  const preparer = source("scripts/ci-main-platform-pr419.sh");
  const installer = source("scripts/install-private-pr419-ci-unit.sh");
  const updater = source("scripts/auto-update-development.sh");
  assert.ok(fixed.includes(exactSha));
  assert.ok(preparer.includes(exactSha));
  assert.ok(updater.includes(exactSha));
  assert.ok(fixed.includes("refs/remotes/origin/" + branch));
  assert.ok(preparer.includes("refs/remotes/origin/" + branch));
  assert.ok(updater.includes(branch));
  assert.match(preparer, /CI_FIXED_SHA_MISMATCH/);
  assert.match(preparer, /"pr": 419,/);
  assert.doesNotMatch(preparer, /"pr": 337,/);
  assert.match(preparer, /CI_DIRTY_SOURCE/);
  // Agent-specific untracked QA paths are never deleted or archived. The
  // reviewed job is built solely from immutable committed Git objects.
  assert.match(preparer, /status --porcelain --untracked-files=no/);
  assert.match(preparer, /git_read archive --format=tar "\$sha"/);
  assert.match(preparer, /CI_UNSAFE_TRACKED_SYMLINK/);
  assert.match(installer, /User=root/);
  assert.match(installer, /PrivateNetwork=true/);
  assert.match(
    installer,
    /ReadOnlyPaths=\/srv\/kmj-codebridge-projects\/kmj-main-platform/,
  );
  assert.match(
    installer,
    /InaccessiblePaths=\/etc\/kmj-codebridge-main-platform/,
  );
  assert.match(preparer, /User=kmjci/);
  assert.match(preparer, /PrivateNetwork=yes/);
  assert.match(preparer, /InaccessiblePaths=\/srv/);
  assert.doesNotMatch(fixed, /git.*(?:push|merge|reset)/);
  assert.doesNotMatch(preparer, /git.*(?:push|merge|reset)/);
});

test("payment review CI entry refuses arbitrary parameters and shell injection", (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell only");
  for (const script of [
    "scripts/ci-main-platform-pr419.sh",
    "scripts/ci-main-platform-pr419-fixed.sh",
    "scripts/install-private-pr419-ci-unit.sh",
  ]) {
    const check = spawnSync("bash", ["-n", path.join(root, script)], {
      timeout: 5000,
      encoding: "utf8",
    });
    assert.equal(check.status, 0, script + " " + check.stderr);
  }
  for (const args of [
    [],
    ["main"],
    ["a".repeat(39)],
    ["a".repeat(40), "extra"],
  ]) {
    const p = spawnSync(
      "bash",
      [path.join(root, "scripts/ci-main-platform-pr419.sh"), ...args],
      {
        timeout: 5000,
        encoding: "utf8",
      },
    );
    assert.equal(p.status, 2, p.stderr);
    assert.match(p.stderr, /CI_INVALID_SHA/);
  }
});

test("payment CI supervisor rejects arbitrary refs and defers start until after reply", async () => {
  const started = [];
  const handle = createSupervisorHandler({
    run: () => "LoadState=loaded\nActiveState=inactive\n",
    start: (service) => started.push(service),
  });
  const state = await handle({ op: "private_pr419_ci_status" });
  assert.equal(state.response.service.installed, true);
  assert.equal(state.response.last, null);
  const request = await handle({ op: "private_pr419_ci_start" });
  assert.deepEqual(request.response, {
    accepted: true,
    target: "private-pr419",
  });
  assert.deepEqual(started, []);
  request.afterSend();
  assert.deepEqual(started, ["kmj-codebridge-private-pr419-ci.service"]);
  for (const extra of [
    { sha: "a".repeat(40) },
    { command: "bash" },
    { path: "/etc/shadow" },
  ]) {
    await assert.rejects(
      handle({ op: "private_pr419_ci_start", ...extra }),
      /INVALID_SUPERVISOR_REQUEST/,
    );
  }
  await assert.rejects(
    createSupervisorHandler({
      run: () => "LoadState=not-found\nActiveState=inactive\n",
    })({ op: "private_pr419_ci_start" }),
    /SUPERVISOR_PRIVATE_CI_UNAVAILABLE/,
  );
  await assert.rejects(
    createSupervisorHandler({
      run: () => "LoadState=loaded\nActiveState=active\n",
    })({ op: "private_pr419_ci_start" }),
    /SUPERVISOR_PRIVATE_CI_BUSY/,
  );
});

test("CodeBridge offers only fixed payment CI tool commands", () => {
  const tools = source("src/tools.js");
  const supervisor = source("src/supervisor.js");
  assert.match(tools, /supervisor_private_pr419_ci_start/);
  assert.match(tools, /supervisor_private_pr419_ci_status/);
  assert.match(supervisor, /privatePr419Evidence/);
  assert.match(
    supervisor,
    /privateCiEvidence\([\s\S]*?419,[\s\S]*?PRIVATE_PR419_CI_EVIDENCE/,
  );
  assert.match(supervisor, /fixedUnitStatus\(run, PRIVATE_PR419_CI_SERVICE/);
  assert.match(
    source("scripts/install-vps.sh"),
    /install-private-pr419-ci-unit\.sh/,
  );
  assert.match(
    source("scripts/auto-update-development.sh"),
    /"419", "fabbec09255416b1110fa367583aeb7a55f0dc94"/,
  );
});

test("owner one-command payment QA bootstrap never deploys or captures charges", (t) => {
  const script = source("scripts/bootstrap-private-payment-pr419.sh");
  assert.match(script, /7ddd1ebee16f262fd34ec0625c43fff5bd4083d5/);
  assert.match(script, /fabbec09255416b1110fa367583aeb7a55f0dc94/);
  assert.match(script, /"pr": 419,/);
  assert.match(script, /--untracked-files=no/);
  assert.match(script, /systemctl start "\$unit"/);
  assert.match(script, /PAYMENT_PR419_ISOLATED_LINUX_QA_PASS/);
  assert.match(script, /PAYMENT_QA_RUNTIME_BOOTSTRAPPED_FROM_VERIFIED_COMMIT/);
  assert.match(script, /git_stage -c core.hooksPath=\/dev\/null fetch/);
  assert.match(script, /git_stage rev-parse HEAD/);
  assert.match(script, /PAYMENT_QA_SOURCE_ARCHIVE_MISMATCH/);
  assert.match(script, /PAYMENT_QA_RUNTIME_PARTIAL_OR_UNTRUSTED/);
  assert.match(script, /! -e "\$runtime" && ! -L "\$runtime"/);
  assert.match(script, /git_stage -c core.hooksPath=\/dev\/null checkout/);
  assert.doesNotMatch(
    script,
    /git reset|git checkout|git push|php artisan migrate|npm run build/,
  );
  assert.doesNotMatch(
    script,
    /rzp_live_|cashfree.*production|payment.*capture/,
  );
  if (process.platform === "win32") return t.skip("POSIX shell only");
  const check = spawnSync(
    "bash",
    ["-n", path.join(root, "scripts/bootstrap-private-payment-pr419.sh")],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(check.status, 0, check.stderr);
});
