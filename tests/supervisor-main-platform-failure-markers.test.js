import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

test("Main Platform restart errors expose only fixed sanitized markers", async () => {
  const handle = createSupervisorHandler({
    run: (command, args) => {
      if (
        command.endsWith("journalctl") &&
        args[1] === "kmj-codebridge-main-platform-refresh.service"
      ) {
        return [
          "MAIN_PLATFORM_RUNTIME_NOT_ACCESSIBLE_TO_SERVICE_USER",
          "MAIN_PLATFORM_RESTART_EFFECTIVE_UNIT_CONFLICT",
          "MAIN_PLATFORM_RESTART_ACTIVE_JOB",
          "MAIN_PLATFORM_RESTART_FAILED_ROLLBACK_ATTEMPTED",
          "credential=not-for-display",
          "MAIN_PLATFORM_RESTART_EFFECTIVE_UNIT_CONFLICT=/unsafe/path",
          "MAIN_PLATFORM_RUNTIME_NOT_ACCESSIBLE_TO_SERVICE_USER=1",
        ].join("\n");
      }
      return "LoadState=loaded\nActiveState=inactive\nSubState=dead\n";
    },
    lstat: () => {
      throw new Error("not installed");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response.mainPlatformEvidence, [
    "RUNTIME_PERMISSION_DENIED",
    "EFFECTIVE_UNIT_CONFLICT",
    "RESTART_DEFERRED_ACTIVE_JOB",
    "RESTART_ROLLBACK_ATTEMPTED",
  ]);
  assert.doesNotMatch(JSON.stringify(result.response), /not-for-display|unsafe\/path/);
  await assert.rejects(
    handle({ op: "update_status", unit: "ssh.service" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});
