import assert from "node:assert/strict";
import test from "node:test";
import { createReadBatchCoalescer } from "../src/batch-read-coalescer.js";

test("compact batch shares identical file reads but never across scopes", async () => {
  const read = createReadBatchCoalescer("compact");
  const input = { device: "d1", project: "p1", path: "a.txt" };
  let calls = 0;
  const execute = async () => ++calls;
  assert.deepEqual(
    await Promise.all([
      read("read_file", input, execute),
      read("read_file", { ...input }, execute),
      read("read_file", { ...input, project: "p2" }, execute),
      read("read_file", { ...input, path: "b.txt" }, execute),
    ]),
    [1, 1, 2, 3],
  );
  assert.equal(calls, 3);
  assert.equal(
    await createReadBatchCoalescer("compact")("read_file", input, execute),
    4,
  );
});

test("legacy full reads and non-file tools are never coalesced", async () => {
  for (const [mode, tool] of [
    ["full", "read_file"],
    ["auto", "git_status"],
    [undefined, "read_file"],
  ]) {
    let calls = 0;
    const read = createReadBatchCoalescer(mode);
    const execute = async () => ++calls;
    assert.deepEqual(
      await Promise.all([read(tool, {}, execute), read(tool, {}, execute)]),
      [1, 2],
    );
  }
});

test("failed reads stay failures and a new batch can retry", async () => {
  const input = { device: "d1", project: "p1", path: "missing" };
  const read = createReadBatchCoalescer("auto");
  let calls = 0;
  const execute = async () => {
    calls++;
    throw new Error("unavailable");
  };
  const results = await Promise.allSettled([
    read("read_file", input, execute),
    read("read_file", input, execute),
  ]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(calls, 1);
  await assert.rejects(
    createReadBatchCoalescer("auto")("read_file", input, execute),
    /unavailable/,
  );
  assert.equal(calls, 2);
});
