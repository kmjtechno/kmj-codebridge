import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDispatcher, definitions, FAST_READ_TOOLS } from "../src/tools.js";

test("large_prompt_plan is opt-in, scoped, read-only and does not echo private prompts", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-large-prompt-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dispatch = createDispatcher(
    {
      id: "device-one",
      stateDir: path.join(base, "state"),
      projects: [
        {
          id: "project-one",
          root,
          writable: false,
          gates: {},
          commands: {},
        },
      ],
    },
    { maxConcurrent: 1 },
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  const secretText =
    "# Private notes\n" + "This stays local to the authorized project.\n".repeat(4000);
  assert.equal(definitions.large_prompt_plan.access, "read");
  assert.ok(!FAST_READ_TOOLS.includes("large_prompt_plan"));
  const result = await dispatch(
    "large_prompt_plan",
    {
      device: "device-one",
      project: "project-one",
      prompt: secretText,
    },
    ["read"],
  );
  assert.equal(result.device, "device-one");
  assert.equal(result.project, "project-one");
  assert.equal(result.promptContentReturned, false);
  assert.equal(result.promptStored, false);
  assert.equal(result.parts[0].startUtf16, 0);
  assert.equal(result.parts.at(-1).endUtf16, secretText.length);
  assert.ok(!JSON.stringify(result).includes("Private notes"));
  assert.equal(fs.readdirSync(root).length, 0);

  await assert.rejects(
    dispatch(
      "large_prompt_plan",
      {
        device: "device-one",
        project: "other-project",
        prompt: secretText,
      },
      ["read"],
    ),
  );
  await assert.rejects(
    dispatch(
      "large_prompt_plan",
      {
        device: "device-one",
        project: "project-one",
        prompt: secretText,
      },
      [],
    ),
  );
});
