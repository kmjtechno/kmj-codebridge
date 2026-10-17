import assert from "node:assert/strict";
import test from "node:test";
import {
  PRIVATE_PLATFORM_REPOSITORY,
  planMainPlatformAllowlist,
  verifyPrivateRepoGrant,
} from "../src/private-repo-allowlist-patch.js";

function sampleConfig() {
  return {
    host: "127.0.0.1",
    port: 8787,
    oauth: {
      issuer: "https://kmjtechno.com",
      resource: "https://kmjtechno.com/mcp",
      jwksUri: "https://kmjtechno.com/.well-known/jwks.json",
    },
    github: {
      apiBase: "https://api.github.com/",
      tokenEnv: "KMJ_GITHUB_APP_TOKEN",
      repositories: ["kmjtechno/kmj-codebridge"],
    },
  };
}

test("narrow grant only adds the exact private Main Platform repository", () => {
  const config = sampleConfig();
  const original = structuredClone(config);
  const plan = planMainPlatformAllowlist(config);
  assert.equal(plan.alreadyAllowed, false);
  assert.deepEqual(plan.config.github.repositories, [
    "kmjtechno/kmj-codebridge",
    PRIVATE_PLATFORM_REPOSITORY,
  ]);
  assert.equal(plan.tokenEnv, "KMJ_GITHUB_APP_TOKEN");
  assert.deepEqual(config, original);
  assert.equal(plan.config.oauth.issuer, original.oauth.issuer);
  assert.deepEqual(plan.config.github.tokenEnv, original.github.tokenEnv);
});

test("grant is idempotent and does not multiply entries", () => {
  const first = planMainPlatformAllowlist(sampleConfig());
  const second = planMainPlatformAllowlist(first.config);
  assert.equal(second.alreadyAllowed, true);
  assert.deepEqual(second.config, first.config);
});

test("reject public/anonymous mode and external API endpoints", () => {
  const publicConfig = sampleConfig();
  publicConfig.github = {
    publicReadOnly: true,
    repositories: ["kmjtechno/kmj-codebridge"],
  };
  assert.throws(
    () => planMainPlatformAllowlist(publicConfig),
    /REPO_REPAIR_PRIVATE_MODE_REQUIRED/,
  );
  const unsafe = sampleConfig();
  unsafe.github.apiBase = "https://github-proxy.example/";
  assert.throws(
    () => planMainPlatformAllowlist(unsafe),
    /REPO_REPAIR_PRIVATE_MODE_REQUIRED/,
  );
});

test("refuse allowlist overflow and malformed auth config", () => {
  const config = sampleConfig();
  config.github.repositories = Array.from(
    { length: 100 },
    (_, i) => `kmjtechno/project-${i}`,
  );
  assert.throws(
    () => planMainPlatformAllowlist(config),
    /REPO_REPAIR_ALLOWLIST_FULL/,
  );
  assert.throws(
    () => planMainPlatformAllowlist({}),
    /invalid|Required|too_small|custom|expected/i,
  );
});

function response(value, status = 200) {
  return {
    status,
    headers: { get: () => "120" },
    text: async () => JSON.stringify(value),
  };
}

test("private metadata and git/main content grant must both succeed", async () => {
  const seen = [];
  const request = async (url, options) => {
    seen.push({ url, method: options.method, redirect: options.redirect });
    if (url.endsWith("/git/ref/heads/main"))
      return response({
        ref: "refs/heads/main",
        object: { sha: "a".repeat(40) },
      });
    return response({ private: true, full_name: PRIVATE_PLATFORM_REPOSITORY });
  };
  const verified = await verifyPrivateRepoGrant("x".repeat(40), request);
  assert.deepEqual(verified, {
    privateRepositoryVerified: true,
    readOnlyRefVerified: true,
  });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((x) => x.method === "GET" && x.redirect === "error"));
  assert.ok(
    seen.every((x) =>
      x.url.startsWith(
        "https://api.github.com/repos/kmjtechno/kmj-main-platform",
      ),
    ),
  );
});

test("public repo, absent token, 404, and bad SHA never permit mutation", async () => {
  await assert.rejects(
    verifyPrivateRepoGrant(undefined, async () => response({})),
    /REPO_REPAIR_TOKEN_MISSING/,
  );
  await assert.rejects(
    verifyPrivateRepoGrant("x".repeat(40), async () =>
      response({ private: false, full_name: PRIVATE_PLATFORM_REPOSITORY }),
    ),
    /REPO_REPAIR_PRIVATE_GRANT_NOT_PROVEN/,
  );
  await assert.rejects(
    verifyPrivateRepoGrant("x".repeat(40), async () => response({}, 404)),
    /REPO_REPAIR_GRANT_NOT_PROVEN/,
  );
  let count = 0;
  await assert.rejects(
    verifyPrivateRepoGrant("x".repeat(40), async () => {
      count += 1;
      return count === 1
        ? response({ private: true, full_name: PRIVATE_PLATFORM_REPOSITORY })
        : response({ ref: "refs/heads/main", object: { sha: "invalid" } });
    }),
    /REPO_REPAIR_CONTENT_GRANT_NOT_PROVEN/,
  );
});

test("reject oversized GitHub API responses before JSON parsing", async () => {
  await assert.rejects(
    verifyPrivateRepoGrant("x".repeat(40), async () => ({
      status: 200,
      headers: { get: () => String(1024 * 1024) },
      text: async () => '{"token":"secret"}',
    })),
    /REPO_REPAIR_RESPONSE_TOO_LARGE/,
  );
});
