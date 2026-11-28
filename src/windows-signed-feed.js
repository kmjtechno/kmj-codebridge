import { createHash, createPublicKey } from "node:crypto";
import {
  downloadPinnedHttpsBytes,
  releaseManifestSchema,
  verifyReleaseManifest,
} from "./update.js";

const FEED = "https://kmjtechno.com/codebridge/releases/stable";
const OWNER_KEY_ID = "kmj-release-2026";
const OWNER_FINGERPRINT =
  "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8";
const SHA = /^[a-f0-9]{40}$/;

function blocked(code) {
  throw new Error(code);
}

function checkState(accepted, runningRevision) {
  if (
    !accepted ||
    !Number.isSafeInteger(accepted.sequence) ||
    accepted.sequence < 1 ||
    typeof accepted.revision !== "string" ||
    !SHA.test(accepted.revision) ||
    typeof runningRevision !== "string" ||
    !SHA.test(runningRevision)
  )
    blocked("WINDOWS_UPDATE_TRUSTED_BASELINE_REQUIRED");
}

// A pure decision after signature verification. This is not an activation
// receipt or an authorization to write the Windows updater watermark.
export function planVerifiedWindowsRelease(
  manifest,
  { accepted, runningRevision, nodeMajor },
) {
  checkState(accepted, runningRevision);
  const verified = releaseManifestSchema.parse(manifest);
  const archive =
    FEED +
    "/" +
    verified.revision +
    "/kmj-codebridge-" +
    verified.version +
    "-" +
    verified.revision.slice(0, 12) +
    ".tar.gz";
  if (
    verified.channel !== "stable" ||
    verified.keyId !== OWNER_KEY_ID ||
    verified.archive !== archive ||
    verified.nodeMajor !== nodeMajor
  )
    blocked("WINDOWS_UPDATE_CHANNEL_OR_RUNTIME_REJECTED");
  if (verified.sequence < accepted.sequence)
    blocked("WINDOWS_UPDATE_SEQUENCE_REPLAY");
  if (
    verified.sequence === accepted.sequence &&
    verified.revision !== accepted.revision
  )
    blocked("WINDOWS_UPDATE_SEQUENCE_COLLISION");
  if (runningRevision !== accepted.revision)
    blocked("WINDOWS_UPDATE_BASELINE_RECONCILIATION_REQUIRED");
  return {
    state:
      verified.sequence === accepted.sequence
        ? "CURRENT_ACCEPTED_REVISION"
        : "NEW_SIGNED_RELEASE_CANDIDATE",
    sequence: verified.sequence,
    revision: verified.revision,
    runningRevision,
    archiveSha256: verified.sha256,
    archiveBytes: verified.bytes,
    activationAttempted: false,
    archiveVerified: false,
    healthyActivationVerified: false,
  };
}

function ownerPublicKey(pem) {
  if (
    typeof pem !== "string" ||
    pem.length > 8192 ||
    !pem.startsWith("-----BEGIN PUBLIC KEY-----") ||
    pem.includes("PRIVATE KEY")
  )
    blocked("WINDOWS_UPDATE_OWNER_KEY_REQUIRED");
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    blocked("WINDOWS_UPDATE_OWNER_KEY_UNTRUSTED");
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex") !== OWNER_FINGERPRINT
  )
    blocked("WINDOWS_UPDATE_OWNER_KEY_UNTRUSTED");
  return key.export({ type: "spki", format: "pem" });
}

// Local trusted updater use only. No remote path, URL, signer or sequence-floor
// override. The caller must load the public key and accepted baseline from a
// separately ACL-protected local store, never from a chat or gateway request.
export async function inspectWindowsSignedFeed({
  trustedPublicKeyPem,
  accepted,
  runningRevision,
}) {
  checkState(accepted, runningRevision);
  const key = ownerPublicKey(trustedPublicKeyPem);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 24) blocked("WINDOWS_UPDATE_NODE_INCOMPATIBLE");
  const [raw, signature] = await Promise.all([
    downloadPinnedHttpsBytes(FEED + "/latest/release-manifest.json"),
    downloadPinnedHttpsBytes(FEED + "/latest/release-manifest.sig", {
      maxBytes: 1024,
    }),
  ]);
  const text = signature.toString("ascii").trim();
  if (
    !/^[A-Za-z0-9_-]{86}$/.test(text) ||
    Buffer.from(text, "base64url").toString("base64url") !== text
  )
    blocked("WINDOWS_UPDATE_SIGNATURE_INVALID");
  const manifest = verifyReleaseManifest(raw, text, {
    [OWNER_KEY_ID]: key,
  });
  return planVerifiedWindowsRelease(manifest, {
    accepted,
    runningRevision,
    nodeMajor,
  });
}
