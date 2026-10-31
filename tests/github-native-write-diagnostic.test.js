import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge } from "../src/github.js";

const repository = "kmjtechno/kmj-codebridge";

test("native GitHub doctor reports bounded, repository-scoped write HTTP classes without implying authorization", async (t) => {
  const env = "CODEBRIDGE_NATIVE_WRITE_DIAG_TEST_TOKEN";
  const secret = "s".repeat(40);
  process.env[env] = secret;
  t.after(() => delete process.env[env]);

  let writeStatus = 403;
  let invalidSuccessBody = false;
  let unconfirmedSuccessBody = false;
  let quota = false;
  let push = false;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ method: options.method, path: new URL(url).pathname });
    if (options.method === "GET") {
      return Response.json({
        full_name: repository,
        private: true,
        permissions: { pull: true, push },
      });
    }
    if (invalidSuccessBody)
      return new Response("not valid JSON", { status: 201 });
    if (unconfirmedSuccessBody)
      return Response.json(
        { message: "NO_MUTATION_IDENTITY" },
        { status: 201 },
      );
    return Response.json(
      writeStatus >= 200 && writeStatus < 300
        ? {
            id: 123,
            html_url:
              "https://github.com/kmjtechno/kmj-codebridge/issues/723#issuecomment-123",
          }
        : { message: "NEVER_EXPOSE_GITHUB_RESPONSE_BODY" },
      {
        status: writeStatus,
        headers: quota ? { "x-ratelimit-remaining": "0" } : {},
      },
    );
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: env,
    repositories: [repository],
    cacheSeconds: 0,
  });
  const doctor = () => dispatch("github_connection_doctor", { repository });
  const write = () =>
    dispatch("github_comment_issue", {
      repository,
      number: 723,
      body: "native credential diagnostic test",
    });

  const initial = await doctor();
  assert.equal(initial.status, "read_ready");
  assert.equal(initial.repositoryPushHint, "not_granted");
  assert.equal(initial.lastWriteFailure, null);
  assert.equal(initial.writeVerified, false);

  await assert.rejects(write(), /GITHUB_AUTHORIZATION_FAILED/);
  const forbidden = await doctor();
  assert.deepEqual(forbidden.lastWriteFailure, {
    httpStatus: 403,
    classification: "http_403",
  });
  assert.equal(forbidden.writeVerified, false);

  writeStatus = 401;
  await assert.rejects(write(), /GITHUB_AUTHORIZATION_FAILED/);
  assert.deepEqual((await doctor()).lastWriteFailure, {
    httpStatus: 401,
    classification: "http_401",
  });

  writeStatus = 403;
  quota = true;
  await assert.rejects(write(), /GITHUB_RATE_LIMIT/);
  assert.deepEqual((await doctor()).lastWriteFailure, {
    httpStatus: 403,
    classification: "rate_limited",
  });

  // A denied write must retain only fixed HTTP classes, including
  // repository-not-found, protected/conflicting writes and HTTP 429.
  quota = false;
  for (const [status, code, classification] of [
    [404, "GITHUB_NOT_FOUND", "http_404"],
    [409, "GITHUB_CONFLICT", "conflict"],
    [422, "GITHUB_CONFLICT", "conflict"],
    [429, "GITHUB_RATE_LIMIT", "rate_limited"],
  ]) {
    writeStatus = status;
    await assert.rejects(write(), new RegExp(code));
    const receipt = (await doctor()).lastWriteFailure;
    assert.deepEqual(receipt, { httpStatus: status, classification });
    assert.equal((await doctor()).writeVerified, false);
  }

  // A malformed HTTP 201 body must not erase the last recorded denial.
  writeStatus = 201;
  invalidSuccessBody = true;
  await assert.rejects(write(), /GITHUB_RESPONSE_INVALID/);
  assert.deepEqual((await doctor()).lastWriteFailure, {
    httpStatus: 429,
    classification: "rate_limited",
  });

  invalidSuccessBody = false;
  unconfirmedSuccessBody = true;
  // A syntactically valid 201 with no GitHub mutation identity is not proof
  // that the native gateway credential can write.
  await assert.rejects(write(), /GITHUB_WRITE_RECEIPT_UNVERIFIED/);
  assert.deepEqual((await doctor()).lastWriteFailure, {
    httpStatus: 429,
    classification: "rate_limited",
  });

  unconfirmedSuccessBody = false;
  quota = false;
  push = true;
  await write();
  const recovered = await doctor();
  assert.equal(recovered.repositoryPushHint, "reported_unverified");
  assert.equal(recovered.lastWriteFailure, null);
  assert.equal(recovered.writeVerified, false);
  assert.equal(calls.filter((call) => call.method === "POST").length, 10);

  for (const receipt of [initial, forbidden, recovered]) {
    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /NEVER_EXPOSE_GITHUB_RESPONSE_BODY/);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(env));
  }
});

test("public-read-only doctor never treats repository push metadata as native write permission", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      full_name: repository,
      private: false,
      permissions: { push: true },
    }),
  );
  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    publicReadOnly: true,
    repositories: [repository],
    cacheSeconds: 0,
  });
  const receipt = await dispatch("github_connection_doctor", { repository });
  assert.equal(receipt.repositoryPushHint, "public_read_only");
  assert.equal(receipt.writeVerified, false);
  assert.equal(receipt.lastWriteFailure, null);
});


test("unconfirmed HTTP 201 never succeeds or evicts an independently cached read", async (t) => {
  const env = "CODEBRIDGE_NATIVE_UNCONFIRMED_WRITE_TEST_TOKEN";
  process.env[env] = "s".repeat(40);
  t.after(() => delete process.env[env]);
  let getCalls = 0;
  let writePayload = { message: "NOT_A_MUTATION_RECEIPT" };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "GET") {
      getCalls++;
      return Response.json({
        full_name: repository,
        default_branch: "main",
        private: true,
        archived: false,
        visibility: "private",
      });
    }
    return Response.json(writePayload, { status: 201 });
  });
  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: env,
    repositories: [repository],
    cacheSeconds: 60,
  });
  const read = () => dispatch("github_repository", { repository });
  const write = () =>
    dispatch("github_comment_issue", {
      repository,
      number: 723,
      body: "receipt check",
    });
  await read();
  for (const payload of [
    { message: "NOT_A_MUTATION_RECEIPT" },
    { id: "123" },
    { id: 0 },
  ]) {
    writePayload = payload;
    await assert.rejects(write(), /GITHUB_WRITE_RECEIPT_UNVERIFIED/);
    await read();
    assert.equal(getCalls, 1, "unconfirmed writes must not evict read cache");
  }
});
