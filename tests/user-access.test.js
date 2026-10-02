import test from "node:test";
import assert from "node:assert/strict";
import { createUserIntrospector } from "../src/user-access.js";

test("licensed user introspection validates and caches memberships", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (
      String(url) ===
      "https://platform.example/api/codebridge/v1/user-access/introspect"
    ) {
      calls++;
      assert.equal(options.headers.authorization, "Bearer " + "x".repeat(48));
      return Response.json({
        active: true,
        user_id: "kmj-user:7",
        memberships: [
          {
            tenant_id: "tenant-a",
            permissions: ["read", "write", "execute", "read"],
          },
        ],
      });
    }
    return originalFetch(url, options);
  });
  const resolve = createUserIntrospector({
    endpoint:
      "https://platform.example/api/codebridge/v1/user-access/introspect",
    cacheSeconds: 30,
  });
  const auth = "Bearer " + "x".repeat(48);
  const first = await resolve(auth, "kmj-user:7");
  const second = await resolve(auth, "kmj-user:7");
  assert.equal(first.memberships[0].tenant, "tenant-a");
  assert.deepEqual(first.memberships[0].permissions, [
    "read",
    "write",
    "execute",
  ]);
  assert.equal(second.id, first.id);
  assert.equal(calls, 1);
});

test("licensed user introspection rejects subject and permission mismatches", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      active: true,
      user_id: "kmj-user:other",
      memberships: [{ tenant_id: "tenant-a", permissions: ["admin"] }],
    }),
  );
  const resolve = createUserIntrospector({
    endpoint:
      "https://platform.example/api/codebridge/v1/user-access/introspect",
    cacheSeconds: 30,
  });
  assert.equal(await resolve("Bearer " + "y".repeat(48), "kmj-user:7"), null);
});
