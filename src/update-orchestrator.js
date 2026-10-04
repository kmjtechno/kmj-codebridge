import fs from "node:fs";
import { fail } from "./errors.js";
import {
  downloadVerifiedReleaseArchive,
  extractVerifiedRuntimeArchive,
  verifyReleaseManifest,
} from "./update.js";

function requireStore(store) {
  if (
    !store ||
    typeof store.staging !== "function" ||
    typeof store.finalize !== "function"
  )
    fail("UPDATE_STORE_INVALID");
}

function removePath(target) {
  if (!target || typeof target !== "string") return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {}
}

export async function prepareVerifiedRelease({
  rawManifest,
  signature,
  trustedKeys,
  minimumSequence = -1,
  store,
  workDir,
  verifyManifest = verifyReleaseManifest,
  download = downloadVerifiedReleaseArchive,
  extract = extractVerifiedRuntimeArchive,
  preflight = async () => true,
}) {
  requireStore(store);

  const manifest = verifyManifest(rawManifest, signature, trustedKeys, {
    minimumSequence,
  });
  const staged = store.staging(manifest);
  let archivePath = null;

  try {
    const archive = await download(manifest, workDir);
    if (!archive || typeof archive.path !== "string")
      fail("UPDATE_DOWNLOAD_FAILED");
    archivePath = archive.path;

    extract(archivePath, staged.staging, manifest);
    if (
      typeof preflight !== "function" ||
      (await preflight({
        manifest,
        stagingDir: staged.staging,
        archivePath,
      })) !== true
    )
      fail("UPDATE_PREFLIGHT_FAILED");
    const release = store.finalize(manifest, staged.staging);
    removePath(archivePath);
    archivePath = null;
    return { manifest, release };
  } catch (error) {
    removePath(archivePath);
    removePath(staged?.staging);
    throw error;
  }
}

function rollbackOrFail(store) {
  try {
    return store.rollback();
  } catch {
    fail("UPDATE_ROLLBACK_FAILED");
  }
}

async function waitForHealth({ healthCheck, attempts, delayMs, sleep }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await healthCheck()) return true;
    } catch {}
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return false;
}

function validateActivationDependencies({
  store,
  releaseName,
  restart,
  healthCheck,
  attempts,
  delayMs,
  sleep,
}) {
  if (
    !store ||
    typeof store.status !== "function" ||
    typeof store.activate !== "function" ||
    typeof store.rollback !== "function"
  )
    fail("UPDATE_STORE_INVALID");
  if (
    typeof releaseName !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$/.test(
      releaseName,
    )
  )
    fail("UPDATE_RELEASE_NAME_INVALID");
  if (
    typeof restart !== "function" ||
    typeof healthCheck !== "function" ||
    typeof sleep !== "function"
  )
    fail("UPDATE_ORCHESTRATOR_INVALID");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20)
    fail("UPDATE_HEALTH_POLICY_INVALID");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000)
    fail("UPDATE_HEALTH_POLICY_INVALID");
}

export async function activateReleaseWithHealthCheck({
  store,
  releaseName,
  restart,
  healthCheck,
  attempts = 5,
  delayMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  validateActivationDependencies({
    store,
    releaseName,
    restart,
    healthCheck,
    attempts,
    delayMs,
    sleep,
  });

  const before = store.status();
  const activation = store.activate(releaseName);

  try {
    await restart();
  } catch {
    if (activation.changed && before.current) {
      rollbackOrFail(store);
      try {
        await restart();
      } catch {
        fail("UPDATE_ROLLBACK_RESTART_FAILED");
      }
      const recovered = await waitForHealth({
        healthCheck,
        attempts,
        delayMs,
        sleep,
      });
      if (!recovered) fail("UPDATE_ROLLBACK_HEALTH_FAILED");
      fail("UPDATE_ACTIVATION_ROLLED_BACK");
    }
    fail("UPDATE_ACTIVATION_RESTART_FAILED");
  }

  const healthy = await waitForHealth({
    healthCheck,
    attempts,
    delayMs,
    sleep,
  });
  if (healthy) {
    return {
      changed: activation.changed,
      current: activation.current,
      previous: activation.previous,
      healthy: true,
    };
  }

  if (!activation.changed || !before.current)
    fail("UPDATE_ACTIVATION_HEALTH_FAILED");

  rollbackOrFail(store);
  try {
    await restart();
  } catch {
    fail("UPDATE_ROLLBACK_RESTART_FAILED");
  }

  const recovered = await waitForHealth({
    healthCheck,
    attempts,
    delayMs,
    sleep,
  });
  if (!recovered) fail("UPDATE_ROLLBACK_HEALTH_FAILED");
  fail("UPDATE_ACTIVATION_ROLLED_BACK");
}
