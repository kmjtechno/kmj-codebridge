import test from "node:test";
import assert from "node:assert/strict";
import { definitions } from "../src/tools.js";

test("AI chat tools explicitly guide mid-conversation capability refresh", () => {
  assert.match(definitions.list_devices.description, /middle of an AI chat/);
  assert.match(definitions.chat_workspace_open.description, /start OR middle/);
  assert.match(definitions.chat_workspace_open.description, /UNKNOWN_TOOL/);
  assert.match(
    definitions.chat_workspace_open.description,
    /recommended nextTools/,
  );
  assert.match(definitions.multi_chat_sync.description, /start OR middle/);
  assert.match(definitions.connection_doctor.description, /UNKNOWN_TOOL/);
  assert.equal(definitions.chat_workspace_open.access, "read");
  assert.equal(definitions.multi_chat_sync.access, "read");
  assert.equal(definitions.connection_doctor.access, "read");
});
