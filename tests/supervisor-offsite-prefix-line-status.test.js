import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

const UNIT = "kmj-elite-offsite-backup.service";
const ID = "a".repeat(32);

function mockSupervisor({ result = "exit-code", exitCode = "3", log = "" } = {}) {
  const requests = [];
  const start = () => assert.fail("read-only status cannot start or restart a unit");
  const handle = createSupervisorHandler({
    run(exe, args, opts) {
      requests.push({ exe, args, opts });
      if (exe === "/usr/bin/systemctl") {
        assert.equal(args[0], "show");
        const isBackup = args[1] === UNIT;
        if (args.includes("--property=InvocationID")) {
          assert.equal(args[1], UNIT);
          return "LoadState=loaded\nInvocationID=" + ID;
        }
        return [
          "LoadState=loaded",
          "ActiveState=inactive",
          "SubState=dead",
          "Result=" + (isBackup ? result : "success"),
          "ExecMainStatus=" + (isBackup ? exitCode : "0"),
          "ExecMainExitTimestamp=Thu 2026-11-12 08:13:17 IST",
        ].join("\n");
      }
      assert.equal(exe, "/usr/bin/journalctl");
      assert.ok(args.includes("_SYSTEMD_INVOCATION_ID=" + ID));
      assert.equal(args[0], "--no-pager");
      assert.equal(args[1], "--output=cat");
      assert.equal(args[2], "--lines=200");
      assert.equal(opts.cwd, "/");
      return log;
    },
    start,
    restart: start,
  });
  return { handle, requests };
}

test("failed exit-3 one-shot returns exact-invocation numeric advisory line only", async () => {
  const { handle, requests } = mockSupervisor({
    log: "secret=never-return-this\nLOCAL_PREFIX_ERR_TRAP_LINE_CANDIDATE=LINE_24\n",
  });
  const { response } = await handle({ op: "main_platform_maintenance_status" });
  assert.deepEqual(response.offsitePrefixFailure, {
    line: "LINE_24", journalScope: "EXACT_INVOCATION", rawJournalExposed: false,
    backupVerified: false, restoreVerified: false,
  });
  assert.equal(response.recentBackupVerified, false);
  assert.equal(response.restoreVerified, false);
  assert.equal(response.productionReleaseApprovedByThisCheck, false);
  assert.equal(requests.filter((x) => x.exe === "/usr/bin/journalctl").length, 1);
  assert.doesNotMatch(JSON.stringify(response), /secret=|InvocationID|never-return-this/);
});

test("old exit-255 and successful services skip journal probe", async () => {
  for (const [result, exitCode] of [["exit-code", "255"], ["success", "0"]]) {
    const { handle, requests } = mockSupervisor({ result, exitCode });
    const { response } = await handle({ op: "main_platform_maintenance_status" });
    assert.equal(response.offsitePrefixFailure.line, "UNKNOWN");
    assert.equal(response.offsitePrefixFailure.journalScope, "UNAVAILABLE");
    assert.equal(requests.some((x) => x.exe === "/usr/bin/journalctl"), false);
  }
});

test("duplicate or malformed journal line is not returned as a false diagnosis", async () => {
  const { handle } = mockSupervisor({
    log: "LOCAL_PREFIX_ERR_TRAP_LINE_CANDIDATE=LINE_11\n" +
         "LOCAL_PREFIX_ERR_TRAP_LINE_CANDIDATE=LINE_12\n",
  });
  const { response } = await handle({ op: "main_platform_maintenance_status" });
  assert.equal(response.offsitePrefixFailure.line, "UNKNOWN");
  assert.equal(response.offsitePrefixFailure.rawJournalExposed, false);
});
