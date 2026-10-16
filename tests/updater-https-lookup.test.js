import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { downloadPinnedHttpsBytes } from "../src/update.js";

for (const all of [true, false]) {
  test(`pinned HTTPS lookup honors Node's all=${all} callback contract`, async (t) => {
    const body = Buffer.from('{"schema":1}');
    let lookedUp = false;
    let lookupResult;
    t.mock.method(https, "get", (url, options, onResponse) => {
      assert.equal(url.hostname, "updates.example");
      assert.notEqual(options.rejectUnauthorized, false);
      const request = new EventEmitter();
      request.setTimeout = () => request;
      queueMicrotask(() => {
        options.lookup(url.hostname, { all }, (error, addresses, family) => {
          lookedUp = true;
          lookupResult = { error, addresses, family };
          const response = Readable.from([body]);
          response.statusCode = 200;
          response.headers = {};
          onResponse(response);
        });
      });
      return request;
    });
    const actual = await downloadPinnedHttpsBytes(
      "https://updates.example/manifest.json",
      {
        resolveAddress: async () => ({ address: "93.184.216.34", family: 4 }),
      },
    );
    assert.equal(lookedUp, true);
    assert.equal(lookupResult.error, null);
    if (all)
      assert.deepEqual(lookupResult.addresses, [
        { address: "93.184.216.34", family: 4 },
      ]);
    else {
      assert.equal(lookupResult.addresses, "93.184.216.34");
      assert.equal(lookupResult.family, 4);
    }
    assert.deepEqual(actual, body);
  });
}
