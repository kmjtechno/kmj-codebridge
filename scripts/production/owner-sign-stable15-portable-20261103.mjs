// KMJ CodeBridge owner-local, offline Ed25519 signer. No network, shell or uploads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const release = Object.freeze({
  revision: "1d216841f9b2a3aaa80fa42d6a24ab62fd23da2f",
  archive: "kmj-codebridge-0.3.2-1d216841f9b2.tar.gz",
  sha256: "5e6ee32b002055e40461f6debd2daa0ebfb31356512c86cbcbdf38c13bd4f00c",
  bytes: 1983917, version: "0.3.2", sequence: 15, keyId: "kmj-release-2026",
});
const home = process.env.USERPROFILE || os.homedir();
const outputDir = path.join(home, "KMJ-CodeBridge-Signed15");
const seen = new Set();
const found = [];
function inspectKey(file) {
  try {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size < 50 || s.size > 16384) return;
    const real = fs.realpathSync(file);
    const id = real.toLowerCase();
    if (!seen.has(id)) { seen.add(id); found.push(real); }
  } catch { }
}
function locateKey() {
  [
    process.env.CODEBRIDGE_RELEASE_KEY_FILE,
    path.join(home, "kmj-release.pem"),
    ...["Desktop", "Downloads", "Documents", "OneDrive", "KMJ", ".kmj"].map(x => path.join(home, x, "kmj-release.pem")),
    "E:\\KMJ\\kmj-release.pem",
  ].filter(Boolean).forEach(inspectKey);
  if (found.length) return found;
  const skip = new Set(["AppData", "node_modules", ".git", ".cache", "Temp", "OneDriveTemp", "Cache"]);
  const dirs = [home, "E:\\KMJ", "C:\\KMJ"]
    .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
    .map(d => [d, 0]);
  let entriesVisited = 0;
  while (dirs.length && entriesVisited < 10000) {
    const [dir, depth] = dirs.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++entriesVisited > 10000) break;
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 5 && !skip.has(e.name)) dirs.push([p, depth + 1]);
      } else if (e.isFile() && e.name.toLowerCase() === "kmj-release.pem") {
        inspectKey(p);
      }
    }
  }
  return found;
}
try {
  const keys = locateKey();
  if (keys.length !== 1) throw Error(keys.length ? "MULTIPLE_STABLE_KEYS_REVIEW_REQUIRED" : "STABLE_KEY_NOT_FOUND_ON_P520");
  const privateKey = createPrivateKey(fs.readFileSync(keys[0]));
  if (privateKey.asymmetricKeyType !== "ed25519") throw Error("NOT_ED25519");
  const publicKey = createPublicKey(privateKey);
  const publicFingerprint = createHash("sha256").update(publicKey.export({type:"spki",format:"der"})).digest("hex");
  const manifest = {
    schema:1, product:"KMJ CodeBridge", channel:"stable", sequence:release.sequence,
    version:release.version, revision:release.revision,
    archive:"https://kmjtechno.com/codebridge/releases/stable/" + release.revision + "/" + release.archive,
    sha256:release.sha256, bytes:release.bytes, nodeMajor:24,
    publishedAt:new Date().toISOString(), keyId:release.keyId,
  };
  const raw = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const signature = sign(null, raw, privateKey);
  if (signature.length !== 64 || !verify(null, raw, publicKey, signature)) throw Error("LOCAL_CRYPTO_VERIFY_FAILED");
  const files = [
    ["release-manifest.json", raw],
    ["release-manifest.sig", Buffer.from(signature.toString("base64url") + "\n")],
  ];
  fs.mkdirSync(outputDir, { recursive:true, mode:0o700 });
  if (files.some(([name]) => fs.existsSync(path.join(outputDir, name)))) throw Error("SIGNED_OUTPUT_ALREADY_EXISTS_NO_OVERWRITE");
  for (const [name, value] of files) {
    const fd = fs.openSync(path.join(outputDir, name), "wx", 0o600);
    try { fs.writeSync(fd, value); } finally { fs.closeSync(fd); }
  }
  console.log("KMJ_SIGNING=LOCAL_PASS");
  console.log("KEY_ID=" + release.keyId);
  console.log("KEY_SPKI_SHA256=" + publicFingerprint);
  console.log("SIGNED_SEQUENCE=" + release.sequence);
  console.log("SIGNED_ARCHIVE_SHA256=" + release.sha256);
  console.log("SIGNED_MANIFEST_SHA256=" + createHash("sha256").update(raw).digest("hex"));
  console.log("SIGNED_OUTPUT_DIR=" + outputDir);
  console.log("ELITE_TRUST_AND_PUBLICATION=NOT_YET_VERIFIED");
} catch (error) {
  const acceptable = new Set(["MULTIPLE_STABLE_KEYS_REVIEW_REQUIRED", "STABLE_KEY_NOT_FOUND_ON_P520", "NOT_ED25519", "LOCAL_CRYPTO_VERIFY_FAILED", "SIGNED_OUTPUT_ALREADY_EXISTS_NO_OVERWRITE"]);
  console.error("KMJ_SIGNING=" + (acceptable.has(error?.message) ? error.message : "LOCAL_SIGNING_FAILED"));
  process.exitCode = 2;
}
