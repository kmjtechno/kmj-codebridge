import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge } from "../src/github.js";

test("native branch write receipt is bound to exact requested ref and commit", async (t) => {
  const repository = "kmjtechno/kmj-codebridge";
  const env = "CODEBRIDGE_BRANCH_RECEIPT_TEST_TOKEN";
  const secret = "s".repeat(40);
  process.env[env] = secret;
  t.after(() => delete process.env[env]);

  const requestedRef = "refs/heads/feature/native-proof";
  const requestedSha = "a".repeat(40);
  let returnedRef = "refs/heads/other-branch";
  let returnedSha = requestedSha;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "GET") {
      return Response.json({
        full_name: repository,
        private: true,
        permissions: { pull: true, push: true },
      });
    }
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), {
      ref: requestedRef,
      sha: requestedSha,
    });
    return Response.json(
      { ref: returnedRef, object: { sha: returnedSha } },
      { status: 201 },
    );
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: env,
    repositories: [repository],
    cacheSeconds: 0,
  });
  const doctor = () => dispatch("github_connection_doctor", { repository });
  const create = () =>
    dispatch("github_create_branch", {
      repository,
      branch: "feature/native-proof",
      sha: requestedSha,
    });

  // An HTTP 201 for an unrelated branch is not proof of this mutation.
  await assert.rejects(create(), /GITHUB_WRITE_RECEIPT_UNVERIFIED/);
  assert.equal((await doctor()).writeVerified, false);

  // The right branch with the wrong commit is equally unverified.
  returnedRef = requestedRef;
  returnedSha = "b".repeat(40);
  await assert.rejects(create(), /GITHUB_WRITE_RECEIPT_UNVERIFIED/);
  assert.equal((await doctor()).writeVerified, false);

  returnedSha = requestedSha;
  assert.deepEqual(await create(), {
    ref: requestedRef,
    sha: requestedSha,
  });
  const verified = await doctor();
  assert.equal(verified.writeVerified, true);
  assert.deepEqual(verified.lastNativeWrite, {
    operation: "branch_create",
    evidence: "confirmed_native_mutation",
  });
  assert.ok(!JSON.stringify(verified).includes(secret));
  assert.ok(!JSON.stringify(verified).includes(env));
});
