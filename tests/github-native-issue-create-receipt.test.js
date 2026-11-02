import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge } from "../src/github.js";

test("native issue creation receipt binds exact repository and returned number", async (t) => {
  const repository = "kmjtechno/kmj-codebridge";
  const env = "CODEBRIDGE_NATIVE_ISSUE_CREATE_TEST_TOKEN";
  const secret = "s".repeat(40);
  process.env[env] = secret;
  t.after(() => delete process.env[env]);

  const issueNumber = 723;
  const expectedIssueUrl =
    "https://api.github.com/repos/kmjtechno/kmj-codebridge/issues/723";
  let issueUrl = null;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "GET") {
      reads++;
      return Response.json({
        full_name: repository,
        private: true,
        permissions: { pull: true, push: true },
      });
    }
    assert.equal(options.method, "POST");
    assert.equal(
      new URL(url).pathname,
      "/repos/kmjtechno/kmj-codebridge/issues",
    );
    return Response.json(
      { number: issueNumber, state: "open", url: issueUrl },
      { status: 201 },
    );
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: env,
    repositories: [repository],
    cacheSeconds: 60,
  });
  const doctor = () => dispatch("github_connection_doctor", { repository });
  const cachedRead = () => dispatch("github_repository", { repository });
  const create = () =>
    dispatch("github_create_issue", {
      repository,
      title: "bounded receipt test",
      body: "source-only test",
    });

  assert.equal((await doctor()).writeVerified, false);
  await cachedRead();
  for (const untrusted of [
    null,
    "https://api.github.com/repos/kmjtechno/kmj-codebridge/issues/724",
    "https://api.github.com/repos/other/repository/issues/723",
    "https://api.github.com/repos/kmjtechno/kmj-codebridge/issues/723/comments",
    "https://api.github.com/repos/kmjtechno/kmj-codebridge/issues/723?extra=1",
  ]) {
    issueUrl = untrusted;
    await assert.rejects(create(), /GITHUB_WRITE_RECEIPT_UNVERIFIED/);
    const receipt = await doctor();
    assert.equal(receipt.writeVerified, false);
    assert.equal(receipt.lastNativeWrite, null);
    const beforeCachedRead = reads;
    await cachedRead();
    assert.equal(
      reads,
      beforeCachedRead,
      "invalid receipts must not evict cached repository reads",
    );
  }

  issueUrl = expectedIssueUrl;
  const accepted = await create();
  assert.equal(accepted.number, issueNumber);
  const verified = await doctor();
  assert.equal(verified.writeVerified, true);
  assert.deepEqual(verified.lastNativeWrite, {
    operation: "issue_create",
    evidence: "confirmed_native_mutation",
  });
  assert.ok(!JSON.stringify(verified).includes(secret));
  assert.ok(!JSON.stringify(verified).includes(env));
});
