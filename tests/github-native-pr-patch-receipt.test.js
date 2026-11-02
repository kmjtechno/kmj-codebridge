import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge } from "../src/github.js";

test("native PR PATCH receipt binds the exact repository and PR number", async (t) => {
  const repository = "kmjtechno/kmj-codebridge";
  const env = "CODEBRIDGE_NATIVE_PR_PATCH_RECEIPT_TEST_TOKEN";
  const secret = "p".repeat(40);
  process.env[env] = secret;
  t.after(() => delete process.env[env]);

  const target = 723;
  const canonical =
    "https://api.github.com/repos/kmjtechno/kmj-codebridge/pulls/723";
  let returned = null;
  let patches = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "GET") {
      assert.equal(new URL(url).pathname, "/repos/kmjtechno/kmj-codebridge");
      return Response.json({
        full_name: repository,
        private: false,
        permissions: { pull: true, push: true },
      });
    }
    assert.equal(options.method, "PATCH");
    assert.equal(
      new URL(url).pathname,
      "/repos/kmjtechno/kmj-codebridge/pulls/723",
    );
    patches++;
    return Response.json(returned, { status: 200 });
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: env,
    repositories: [repository],
    cacheSeconds: 60,
  });
  const doctor = () => dispatch("github_connection_doctor", { repository });
  const update = () =>
    dispatch("github_update_pull_request", {
      repository,
      number: target,
      title: "bounded PR metadata receipt",
    });

  assert.equal((await doctor()).writeVerified, false);
  for (const invalid of [
    { number: 724, state: "open", url: canonical },
    {
      number: 723,
      state: "open",
      url: "https://api.github.com/repos/other/repo/pulls/723",
    },
    { number: 723, state: "open", url: canonical + "?extra=1" },
    { number: 723, state: "open" },
    { number: 723, state: 42, url: canonical },
  ]) {
    returned = invalid;
    await assert.rejects(update(), /GITHUB_WRITE_RECEIPT_UNVERIFIED/);
    const status = await doctor();
    assert.equal(status.writeVerified, false);
    assert.equal(status.lastNativeWrite, null);
  }

  returned = { number: target, state: "open", url: canonical };
  const accepted = await update();
  assert.equal(accepted.number, target);
  assert.equal(patches, 6);
  const status = await doctor();
  assert.equal(status.writeVerified, true);
  assert.deepEqual(status.lastNativeWrite, {
    operation: "pull_request_update",
    evidence: "confirmed_native_mutation",
  });
  assert.ok(!JSON.stringify(status).includes(secret));
  assert.ok(!JSON.stringify(status).includes(env));
});
