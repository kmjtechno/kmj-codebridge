import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseCandidateMetadata } from "../scripts/release-candidate-metadata.js";

const product = {
  product: { name: "KMJ CodeBridge" },
  versions: {
    stable: "0.3.2",
    minimumAgent: "0.3.2",
    minimumClientPackage: "0.3.2",
  },
  supportedClients: ["chatgpt", "claude", "codex"],
  updateChannels: ["stable", "preview"],
};
const runtime = {
  product: "KMJ CodeBridge",
  version: "0.3.2",
  revision: "a".repeat(40),
  archive: "kmj-codebridge-0.3.2-aaaaaaaaaaaa.tar.gz",
  bytes: 12345,
  sha256: "b".repeat(64),
  format: "source-runtime",
  signed: false,
};

test("release candidate metadata binds compatibility and checksum to runtime", () => {
  const built = buildReleaseCandidateMetadata({ product, runtime });
  assert.equal(built.compatibility.version, "0.3.2");
  assert.equal(built.compatibility.revision, runtime.revision);
  assert.deepEqual(
    built.compatibility.supportedClients,
    product.supportedClients,
  );
  assert.equal(
    built.checksums,
    `${runtime.sha256}  runtime/${runtime.archive}\n`,
  );
});

test("release candidate metadata keeps stable publication owner-gated", () => {
  const built = buildReleaseCandidateMetadata({ product, runtime });
  assert.equal(built.signingRequest.state, "owner_signing_required");
  assert.ok(
    built.signingRequest.requiredPrivateInputs.includes(
      "CODEBRIDGE_RELEASE_KEY_FILE",
    ),
  );
  assert.match(built.releaseNotes, /not an official signed stable release/i);
  assert.match(built.signingRequest.policy, /owner-controlled Ed25519/i);
});

test("release candidate metadata fails closed on product/runtime version drift", () => {
  assert.throws(
    () =>
      buildReleaseCandidateMetadata({
        product,
        runtime: { ...runtime, version: "0.3.3" },
      }),
    /RELEASE_METADATA_INPUT_INVALID/,
  );
});
