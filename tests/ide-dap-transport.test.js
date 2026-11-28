import test from "node:test";
import assert from "node:assert/strict";
import {
  DapFrameDecoder,
  createDapConnection,
  encodeDapRequest,
} from "../src/ide-dap-transport.js";

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([
    Buffer.from("Content-Length: " + body.length + "\r\n\r\n"),
    body,
  ]);
}

test("DAP decoder handles split UTF-8 frames and combined messages", () => {
  const decoder = new DapFrameDecoder();
  const a = { type: "event", event: "stopped", body: { text: "नमस्ते" } };
  const b = { type: "event", event: "terminated" };
  const bytes = Buffer.concat([frame(a), frame(b)]);
  const decoded = [];
  for (let i = 0; i < bytes.length; i += 3)
    decoded.push(...decoder.push(bytes.subarray(i, i + 3)));
  assert.deepEqual(decoded, [a, b]);
});

test("DAP framing rejects oversized and ambiguous headers permanently", () => {
  for (const invalid of [
    "Content-Length: 999999\r\n\r\n",
    "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
    "Content-Length: 0\r\n\r\n",
    "Content-Length: 2\r\n\r\n[]",
  ]) {
    const decoder = new DapFrameDecoder();
    assert.throws(
      () => decoder.push(Buffer.from(invalid)),
      /DAP_PROTOCOL_INVALID/,
    );
    assert.throws(() => decoder.push(frame({})), /DAP_DECODER_CLOSED/);
  }
});

test("request IDs correlate even for out-of-order adapter replies", async () => {
  const sent = [];
  let closed = 0;
  const connection = createDapConnection({
    write: (chunk) => sent.push(chunk),
    closeTransport: () => closed++,
  });
  const a = connection.request("threads");
  const b = connection.request("stackTrace", { threadId: 1 });
  const decoder = new DapFrameDecoder();
  assert.equal(decoder.push(sent[0])[0].command, "threads");
  assert.equal(decoder.push(sent[1])[0].command, "stackTrace");
  connection.receive(
    frame({
      type: "response",
      request_seq: 2,
      command: "stackTrace",
      success: true,
      body: { stackFrames: [] },
    }),
  );
  connection.receive(
    frame({
      type: "response",
      request_seq: 1,
      command: "threads",
      success: true,
      body: { threads: [] },
    }),
  );
  assert.deepEqual(await b, { stackFrames: [] });
  assert.deepEqual(await a, { threads: [] });
  assert.equal(connection.status().pending, 0);
  connection.close();
  connection.close();
  assert.equal(closed, 1);
});

test("arbitrary evaluation, attach and reverse process launch are denied", async () => {
  let closed = 0;
  const connection = createDapConnection({
    write: () => assert.fail("unauthorized request was sent"),
    closeTransport: () => closed++,
  });
  for (const command of ["evaluate", "attach", "setVariable", "runInTerminal"])
    await assert.rejects(connection.request(command), /DAP_REQUEST_INVALID/);
  assert.throws(
    () =>
      connection.receive(frame({ type: "request", command: "runInTerminal" })),
    /DAP_CONNECTION_PROTOCOL_FAILURE/,
  );
  assert.equal(closed, 1);
  await assert.rejects(connection.request("threads"), /DAP_CONNECTION_CLOSED/);
});

test("events retain bounded metadata rather than untrusted log data", () => {
  const connection = createDapConnection({
    write: () => {},
    closeTransport: () => {},
  });
  for (let i = 0; i < 40; i++)
    connection.receive(
      frame({
        type: "event",
        event: "output",
        body: { output: "secret-data" },
      }),
    );
  const result = connection.drainEvents();
  assert.equal(result.events.length, 32);
  assert.equal(result.eventOverflow, true);
  assert.equal(JSON.stringify(result).includes("secret-data"), false);
  connection.close();
});

test("timeouts close the connection rather than replaying debugger commands", async () => {
  let writes = 0;
  let closed = 0;
  const connection = createDapConnection({
    timeoutMs: 100,
    write: () => writes++,
    closeTransport: () => closed++,
  });
  await assert.rejects(
    connection.request("next", { threadId: 1 }),
    /DAP_REQUEST_TIMEOUT/,
  );
  assert.equal(writes, 1);
  assert.equal(closed, 1);
  assert.equal(connection.status().closed, true);
});

test("mismatched response fails closed and rejects the pending request", async () => {
  const connection = createDapConnection({
    write: () => {},
    closeTransport: () => {},
  });
  const rejected = assert.rejects(
    connection.request("threads"),
    /DAP_CONNECTION_CLOSED/,
  );
  assert.throws(
    () =>
      connection.receive(
        frame({
          type: "response",
          command: "launch",
          request_seq: 1,
          success: true,
        }),
      ),
    /DAP_CONNECTION_PROTOCOL_FAILURE/,
  );
  await rejected;
  assert.throws(() => encodeDapRequest(0, "threads"), /DAP_REQUEST_INVALID/);
});
