import test from "node:test";
import assert from "node:assert/strict";
import { AutopilotGateWorker } from "../src/autopilot-gate-worker.js";
import { IsolatedRepairWorker } from "../src/autopilot-repair-worker.js";
import { LocalAutopilotDraftWorker } from "../src/autopilot-local-worker.js";
import { GitHubCiWatchWorker } from "../src/autopilot-ci-watch-worker.js";

for (const Worker of [
  AutopilotGateWorker,
  IsolatedRepairWorker,
  LocalAutopilotDraftWorker,
  GitHubCiWatchWorker,
]) {
  test(`${Worker.name} does not start new work while update admission is paused`, async () => {
    let checks = 0;
    const project = {
      id: "repo",
      root: "/unused",
      writable: true,
      autopilotGateWorker: { enabled: true, gates: ["fast"] },
      autopilotRepairWorker: { enabled: true, recipes: {} },
      autopilotLocalWorker: { enabled: true },
      autopilotCiWatch: { enabled: true, intervalSeconds: 60 },
    };
    const worker = new Worker({
      projects: [project],
      journal: {
        hasReady: () => {
          checks++;
          return false;
        },
      },
      licenseProvider: () => {
        checks++;
        return { features: [] };
      },
      canStart: () => false,
    });
    await worker.tick();
    assert.equal(
      checks,
      0,
      "paused worker must not touch journals or license/network state",
    );
  });
}
