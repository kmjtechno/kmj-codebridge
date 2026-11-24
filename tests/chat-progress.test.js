import test from "node:test";
import assert from "node:assert/strict";
import { notifyProgress, progressRequested } from "../src/chat-progress.js";

const request = {
  method: "tools/call",
  params: {
    name: "render_codebridge_status",
    _meta: { progressToken: 0 },
  },
};
const accept = "application/json, text/event-stream";

test("progress requires a bounded token, supported tool and both accept types", () => {
  assert.equal(progressRequested(request, accept), true);
  assert.equal(progressRequested(request, "application/json"), false);
  assert.equal(progressRequested(request, undefined), false);
  assert.equal(
    progressRequested(
      { ...request, params: { ...request.params, name: "write_file" } },
      accept,
    ),
    false,
  );
  assert.equal(
    progressRequested(
      {
        ...request,
        params: { ...request.params, _meta: { progressToken: "x".repeat(129) } },
      },
      accept,
    ),
    false,
  );
});

test("notifications preserve token zero and ignore unavailable transports", async () => {
  const sent = [];
  await notifyProgress(
    {
      _meta: { progressToken: 0 },
      sendNotification: async (message) => sent.push(message),
    },
    1,
    "Collecting evidence",
  );
  assert.deepEqual(sent, [
    {
      method: "notifications/progress",
      params: { progressToken: 0, progress: 1, message: "Collecting evidence" },
    },
  ]);
  await notifyProgress({}, 2, "Returned");
  await notifyProgress(
    {
      _meta: { progressToken: 0 },
      sendNotification: async () => {
        throw new Error("closed");
      },
    },
    2,
    "Returned",
  );
});
