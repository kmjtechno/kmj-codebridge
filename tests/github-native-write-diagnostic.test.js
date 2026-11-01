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
  assert.equal(initial.lastNativeWrite, null);

  await assert.rejects(write(), /GITHUB_AUTHORIZATION_FAILED/);
  const forbidden = await doctor();
  assert.deepEqual(forbidden.lastWriteFailure, {
    httpStatus: 403,
    classification: "http_403",
  });
  assert.equal(forbidden.writeVerified, false);
  assert.equal(forbidden.lastNativeWrite, null);

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
  assert.equal(recovered.writeVerified, true);
  assert.deepEqual(recovered.lastNativeWrite, {
    operation: "issue_comment",
    evidence: "confirmed_native_mutation",
  });

  // A later denied native write revokes the scoped success witness. A read
  // permission hint or separate connector cannot restore it.
  writeStatus = 403;
  await assert.rejects(write(), /GITHUB_AUTHORIZATION_FAILED/);
  const revoked = await doctor();
  assert.equal(revoked.writeVerified, false);
  assert.equal(revoked.lastNativeWrite, null);
  assert.deepEqual(revoked.lastWriteFailure, {
    httpStatus: 403,
    classification: "http_403",
  });
  assert.equal(calls.filter((call) => call.method === "POST").length, 11);

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
  assert.equal(receipt.lastNativeWrite, null);
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

test("newer write attempts win even when responses finish out of order", async (t) => {
  const env = "CODEBRIDGE_NATIVE_OVERLAP_TEST_TOKEN";
  process.env[env] = "s".repeat(40);
  t.after(() => delete process.env[env]);

  const otherRepository = "kmjtechno/kmj-main-platform";
  const pending = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const repo = new URL(url).pathname.includes("/kmj-main-platform")
      ? otherRepository
      : repository;
    if (options.method === "GET")
      return Response.json({
        full_name: repo,
        private: true,
        permissions: { pull: true, push: true },
      });
    return new Promise((resolve) => pending.push({ repo, resolve }));
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: env,
    repositories: [repository, otherRepository],
    cacheSeconds: 0,
  });
  const doctor = (repo) =>
    dispatch("github_connection_doctor", { repository: repo });
  const write = (repo) =>
    dispatch("github_comment_issue", {
      repository: repo,
      number: 723,
      body: "bounded overlap regression",
    });
  const response = (status, id) =>
    Response.json(status === 201 ? { id } : { message: "PRIVATE_ERROR_BODY" }, {
      status,
    });

  // A starts before B. B's denial is the newest attempt even when A's
  // older successful HTTP 201 completes afterwards.
  const a = write(repository);
  const b = write(repository);
  assert.equal(pending.length, 2);
  pending[1].resolve(response(403));
  await assert.rejects(b, /GITHUB_AUTHORIZATION_FAILED/);
  pending[0].resolve(response(201, 1001));
  await a;
  const denied = await doctor(repository);
  assert.equal(denied.writeVerified, false);
  assert.equal(denied.lastNativeWrite, null);
  assert.deepEqual(denied.lastWriteFailure, {
    httpStatus: 403,
    classification: "http_403",
  });

  // The reverse completion order must not let A's stale failure overwrite
  // B's later confirmed success.
  const c = write(repository);
  const d = write(repository);
  assert.equal(pending.length, 4);
  pending[3].resolve(response(201, 1002));
  await d;
  pending[2].resolve(response(403));
  await assert.rejects(c, /GITHUB_AUTHORIZATION_FAILED/);
  const confirmed = await doctor(repository);
  assert.equal(confirmed.writeVerified, true);
  assert.deepEqual(confirmed.lastNativeWrite, {
    operation: "issue_comment",
    evidence: "confirmed_native_mutation",
  });
  assert.equal(confirmed.lastWriteFailure, null);

  // Generation is repository-local: an independent confirmed write remains
  // valid even if another repository's newest attempt fails.
  const e = write(repository);
  const f = write(otherRepository);
  assert.equal(pending.length, 6);
  assert.equal(pending[5].repo, otherRepository);
  pending[5].resolve(response(201, 1003));
  await f;
  pending[4].resolve(response(403));
  await assert.rejects(e, /GITHUB_AUTHORIZATION_FAILED/);
  assert.equal((await doctor(repository)).writeVerified, false);
  const isolated = await doctor(otherRepository);
  assert.equal(isolated.writeVerified, true);
  assert.equal(isolated.lastWriteFailure, null);
  assert.doesNotMatch(JSON.stringify(isolated), /PRIVATE_ERROR_BODY/);
});
