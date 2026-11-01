import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail } from "./errors.js";
import { ReleaseStore } from "./release-store.js";
import {
  downloadPinnedHttpsBytes,
  releaseDirectoryName,
  verifyReleaseManifest,
} from "./update.js";
import {
  activateReleaseWithHealthCheck,
  prepareVerifiedRelease,
} from "./update-orchestrator.js";
import { acquireUpdateMaintenance } from "./update-maintenance.js";
import { SUPERVISOR_SOCKET, supervisorRequest } from "./supervisor-client.js";

const version = z
  .string()
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const absolutePath = z.string().refine((value) => path.isAbsolute(value));
const releaseUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Requires canonical HTTPS");

export const stableUpdateConfigSchema = z
  .object({
    schema: z.literal(1),
    channel: z.enum(["stable", "beta"]).default("stable"),
    manifestUrl: releaseUrl,
    signatureUrl: releaseUrl,
    trustedKeys: z
      .record(z.string().min(32))
      .refine(
        (keys) =>
          Object.keys(keys).length > 0 &&
          Object.keys(keys).length <= 10 &&
          Object.values(keys).every(
            (key) => !key.includes("PRIVATE KEY") && key.length <= 8192,
          ),
        "Public release keys only",
      ),
    installRoot: absolutePath,
    stateDir: absolutePath,
    agentStateDir: absolutePath,
    workDir: absolutePath,
    supervisorSocket: z.literal(SUPERVISOR_SOCKET).default(SUPERVISOR_SOCKET),
    health: z
      .object({
        attempts: z.number().int().min(1).max(20).default(10),
        delayMs: z.number().int().min(100).max(60000).default(1000),
      })
      .default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      new URL(config.manifestUrl).origin !== new URL(config.signatureUrl).origin
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manifest and signature must share one origin",
      });
    if (path.resolve(config.stateDir) === path.resolve(config.agentStateDir))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Updater state must be isolated from agent state",
      });
  });

const acceptedStateSchema = z
  .object({
    schema: z.literal(1),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    version,
    revision,
    acceptedAt: z.string().datetime({ offset: true }),
  })
  .strict();

function secureDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
  )
    fail("UPDATE_STATE_ROOT_INVALID");
  return path.resolve(target);
}

function existingDirectory(target, code) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
    return path.resolve(target);
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code);
  }
}

function acceptedStateFile(stateDir) {
  return path.join(stateDir, "stable-update-state.json");
}

// The anti-rollback watermark is security state, not an optional cache.
// A dangling symlink must never be mistaken for an absent state file.
export function readAcceptedUpdateState(stateDir) {
  const file = acceptedStateFile(stateDir);
  let before;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("UPDATE_STATE_INVALID");
  }
  const trusted = (stat) =>
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    stat.size > 0 &&
    stat.size <= 4096 &&
    (process.platform === "win32" ||
      (stat.uid === process.getuid() && (stat.mode & 0o077) === 0));
  if (!trusted(before)) fail("UPDATE_STATE_INVALID");
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const after = fs.fstatSync(fd);
    if (
      !trusted(after) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    )
      fail("UPDATE_STATE_INVALID");
    return acceptedStateSchema.parse(JSON.parse(fs.readFileSync(fd, "utf8")));
  } catch {
    fail("UPDATE_STATE_INVALID");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncUpdaterStateDirectory(stateDir) {
  // The lock and the accepted sequence must both survive a POSIX crash.
  // Windows activation is not supported by this updater.
  if (process.platform === "win32") return;
  const dirFd = fs.openSync(
    stateDir,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

export function writeAcceptedUpdateState(stateDir, manifest, now = Date.now()) {
  const state = acceptedStateSchema.parse({
    schema: 1,
    sequence: manifest.sequence,
    version: manifest.version,
    revision: manifest.revision,
    acceptedAt: new Date(now).toISOString(),
  });
  // The exported writer must enforce its own state-root policy, even when
  // called without runStableUpdate's outer maintenance lease.
  secureDirectory(stateDir);
  // Atomic mkdir serializes writers across processes. Never remove an
  // existing/abandoned lock automatically: it requires owner reconciliation.
  const lock = path.join(stateDir, ".stable-update-state.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch {
    fail("UPDATE_STATE_LOCKED");
  }
  // Persist the lock before any watermark replacement. If this fails, the
  // lock remains for owner reconciliation rather than permitting a retry.
  fsyncUpdaterStateDirectory(stateDir);
  let temp = null;
  let renamed = false;
  let durable = false;
  try {
    // Read and compare while holding the lock, not before acquiring it.
    const accepted = readAcceptedUpdateState(stateDir);
    if (
      accepted &&
      (state.sequence < accepted.sequence ||
        (state.sequence === accepted.sequence &&
          (state.revision !== accepted.revision ||
            state.version !== accepted.version)))
    )
      fail("UPDATE_STATE_ROLLBACK_REJECTED");
    const file = acceptedStateFile(stateDir);
    temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    temp = null;
    renamed = true;
    // The rename is not durable until the parent directory is synced.
    fsyncUpdaterStateDirectory(stateDir);
    durable = true;
    return state;
  } finally {
    if (temp !== null) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The original failure still rejects the update; do not remove an
        // unverified pathname by following a symlink or retrying elsewhere.
      }
    }
    // A failed post-rename directory fsync is an ambiguous durability state.
    // Keep the lock so no automatic retry can silently lower the watermark.
    if (!renamed || durable) {
      fs.rmdirSync(lock);
      fsyncUpdaterStateDirectory(stateDir);
    }
  }
}

function markerFor(store, releaseName) {
  const target = path.join(store.releases, releaseName);
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("UPDATE_RELEASE_NOT_FOUND");
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(target, ".codebridge-release.json"), "utf8"),
    );
    if (
      marker?.schema !== 1 ||
      !Number.isSafeInteger(marker.sequence) ||
      marker.sequence < 0 ||
      !version.safeParse(marker.version).success ||
      !revision.safeParse(marker.revision).success ||
      !/^[a-f0-9]{64}$/.test(marker.sha256 ?? "")
    )
      fail("UPDATE_RELEASE_MARKER_INVALID");
    return { ...marker, target };
  } catch (error) {
    if (error?.code === "UPDATE_RELEASE_MARKER_INVALID") throw error;
    fail("UPDATE_RELEASE_MARKER_INVALID");
  }
}

function releaseMatchesManifest(marker, manifest) {
  return Boolean(
    marker &&
      marker.sequence === manifest.sequence &&
      marker.version === manifest.version &&
      marker.revision === manifest.revision &&
      marker.sha256 === manifest.sha256,
  );
}

function assertMaintenanceRuntime(store, releaseName) {
  try {
    const file = path.join(store.releases, releaseName, "package.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
      fail("UPDATE_RUNTIME_MAINTENANCE_UNSUPPORTED");
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (pkg.codebridgeAgentUpdateProtocol !== 1)
      fail("UPDATE_RUNTIME_MAINTENANCE_UNSUPPORTED");
  } catch {
    fail("UPDATE_RUNTIME_MAINTENANCE_UNSUPPORTED");
  }
}

function currentReleaseMarker(store) {
  const current = store.status().current;
  return current ? markerFor(store, current) : null;
}

function reusableRelease(store, manifest) {
  const name = releaseDirectoryName(manifest);
  const marker = markerFor(store, name);
  if (!marker) return null;
  if (!releaseMatchesManifest(marker, manifest))
    fail("UPDATE_RELEASE_MARKER_INVALID");
  return { name, target: marker.target, reused: true };
}

function connectionEvidence(stateDir) {
  const file = path.join(stateDir, "connection.json");
  if (!fs.existsSync(file)) return null;
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    const time = Date.parse(body?.connectedAt ?? "");
    if (!Number.isFinite(time)) return null;
    return { ...body, time };
  } catch {
    return null;
  }
}

export function freshAuthenticatedConnection(
  stateDir,
  notBefore,
  expectedManifest = null,
) {
  const evidence = connectionEvidence(stateDir);
  if (!evidence || evidence.time < notBefore) return false;
  if (!expectedManifest) return true;
  return Boolean(
    evidence.version === expectedManifest.version &&
      evidence.release?.sequence === expectedManifest.sequence &&
      evidence.release?.version === expectedManifest.version &&
      evidence.release?.revision === expectedManifest.revision &&
      evidence.release?.sha256 === expectedManifest.sha256,
  );
}

export function defaultStableUpdatePreflight(
  { stagingDir },
  {
    run = execFileSync,
    npmPath = path.join(
      path.dirname(process.execPath),
      process.platform === "win32" ? "npm.cmd" : "npm",
    ),
  } = {},
) {
  for (const relative of [
    "package.json",
    "package-lock.json",
    "src/cli.js",
    "src/agent.js",
    "src/supervisor.js",
    "src/supervisor-client.js",
  ]) {
    const file = path.join(stagingDir, relative);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile())
      fail("UPDATE_PREFLIGHT_FAILED");
  }

  try {
    run(
      npmPath,
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: stagingDir,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: {
          PATH: [
            path.dirname(process.execPath),
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
          ].join(path.delimiter),
          HOME: stagingDir,
          npm_config_cache: path.join(stagingDir, ".npm-cache"),
          LANG: "C.UTF-8",
        },
      },
    );

    for (const relative of [
      "src/cli.js",
      "src/agent.js",
      "src/supervisor.js",
      "src/supervisor-client.js",
    ])
      run(process.execPath, ["--check", path.join(stagingDir, relative)], {
        cwd: stagingDir,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
  } catch {
    fail("UPDATE_PREFLIGHT_FAILED");
  }

  const modules = path.join(stagingDir, "node_modules");
  if (
    !fs.existsSync(modules) ||
    !fs.lstatSync(modules).isDirectory() ||
    fs.lstatSync(modules).isSymbolicLink()
  )
    fail("UPDATE_PREFLIGHT_FAILED");
  return true;
}

// The signed manifest's `nodeMajor` is the only compatibility contract the
// runtime verifies before activation: it is not advisory metadata. A release
// staged and activated on a host whose actual interpreter is a different
// major version would not merely warn (npm's own engines check is a
// non-fatal warning, and nothing else in this pipeline inspects the running
// Node version) — it would replace the known-good `current` symlink with a
// release this exact host cannot run, bricking the service until someone
// manually intervenes. This check is deliberately cheap and runs immediately
// after signature/channel verification, before any archive download, so an
// incompatible host fails closed without spending bandwidth or touching the
// release store.
export function currentNodeMajor(rawVersion = process.versions.node) {
  const major = Number(String(rawVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 1)
    fail("UPDATE_NODE_VERSION_INVALID");
  return major;
}

function assertNodeCompatible(manifest, nodeMajor) {
  if (manifest.nodeMajor !== nodeMajor) fail("UPDATE_NODE_INCOMPATIBLE");
}

async function fixedAgentRestart(socketPath, request = supervisorRequest) {
  const result = await request(
    socketPath,
    { op: "restart", service: "agent" },
    { timeoutMs: 5000 },
  );
  if (!result?.accepted || result.service !== "agent")
    fail("UPDATE_ACTIVATION_RESTART_FAILED");
}

export async function runStableUpdate(
  rawConfig,
  {
    fetchBytes = downloadPinnedHttpsBytes,
    verifyManifest = verifyReleaseManifest,
    createStore = (config) =>
      new ReleaseStore({
        installRoot: config.installRoot,
        stateDir: config.stateDir,
      }),
    prepare = prepareVerifiedRelease,
    activate = activateReleaseWithHealthCheck,
    restartRequest = supervisorRequest,
    acquireMaintenance = (config) =>
      acquireUpdateMaintenance(config, {
        status: () =>
          restartRequest(config.supervisorSocket, {
            op: "status",
            service: "agent",
          }),
      }),
    preflight = defaultStableUpdatePreflight,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nodeMajor = currentNodeMajor(),
  } = {},
) {
  const config = stableUpdateConfigSchema.parse(rawConfig);
  secureDirectory(config.stateDir);
  secureDirectory(config.workDir);
  const agentStateDir = existingDirectory(
    config.agentStateDir,
    "UPDATE_AGENT_STATE_INVALID",
  );

  const maintenance = acquireMaintenance(config);
  try {
    const store = createStore(config);
    const accepted = readAcceptedUpdateState(config.stateDir);
    const currentMarker = currentReleaseMarker(store);
    const minimumSequence = Math.max(
      accepted?.sequence ?? -1,
      currentMarker?.sequence ?? -1,
    );

    const [rawManifest, rawSignature] = await Promise.all([
      fetchBytes(config.manifestUrl, { maxBytes: 65536 }),
      fetchBytes(config.signatureUrl, { maxBytes: 1024 }),
    ]);
    let signature;
    try {
      signature = new TextDecoder("utf-8", { fatal: true })
        .decode(rawSignature)
        .trim();
    } catch {
      fail("UPDATE_SIGNATURE_INVALID");
    }

    const manifest = verifyManifest(
      rawManifest,
      signature,
      config.trustedKeys,
      {
        minimumSequence: -1,
      },
    );
    if (manifest.channel !== config.channel) fail("UPDATE_CHANNEL_MISMATCH");
    assertNodeCompatible(manifest, nodeMajor);

    if (manifest.sequence < minimumSequence) fail("UPDATE_ROLLBACK_REJECTED");
    if (manifest.sequence === minimumSequence) {
      if (releaseMatchesManifest(currentMarker, manifest))
        return {
          updated: false,
          current: releaseDirectoryName(manifest),
          sequence: manifest.sequence,
          version: manifest.version,
        };
      fail("UPDATE_ROLLBACK_REJECTED");
    }

    let release = reusableRelease(store, manifest);
    if (!release) {
      const prepared = await prepare({
        rawManifest,
        signature,
        trustedKeys: config.trustedKeys,
        minimumSequence: -1,
        store,
        workDir: config.workDir,
        verifyManifest: () => manifest,
        preflight,
      });
      release = prepared.release;
    }

    assertMaintenanceRuntime(store, release.name);
    await maintenance.drain();
    const activationStart = now();
    const activation = await activate({
      store,
      releaseName: release.name,
      restart: () => {
        maintenance.assertHeld?.();
        return fixedAgentRestart(config.supervisorSocket, restartRequest);
      },
      healthCheck: async () =>
        freshAuthenticatedConnection(agentStateDir, activationStart, manifest),
      rollbackHealthCheck: async () =>
        Boolean(currentMarker) &&
        freshAuthenticatedConnection(
          agentStateDir,
          activationStart,
          currentMarker,
        ),
      attempts: config.health.attempts,
      delayMs: config.health.delayMs,
      sleep,
    });

    writeAcceptedUpdateState(config.stateDir, manifest, now());
    return {
      updated: activation.changed,
      current: activation.current,
      previous: activation.previous,
      healthy: activation.healthy,
      sequence: manifest.sequence,
      version: manifest.version,
      reused: Boolean(release.reused),
    };
  } finally {
    maintenance.close();
  }
}

export async function runStableRollback(
  rawConfig,
  {
    createStore = (config) =>
      new ReleaseStore({
        installRoot: config.installRoot,
        stateDir: config.stateDir,
      }),
    restartRequest = supervisorRequest,
    acquireMaintenance = (config) =>
      acquireUpdateMaintenance(config, {
        status: () =>
          restartRequest(config.supervisorSocket, {
            op: "status",
            service: "agent",
          }),
      }),
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const config = stableUpdateConfigSchema.parse(rawConfig);
  secureDirectory(config.stateDir);
  const agentStateDir = existingDirectory(
    config.agentStateDir,
    "UPDATE_AGENT_STATE_INVALID",
  );
  const maintenance = acquireMaintenance(config);
  try {
    const store = createStore(config);
    const before = store.status();
    if (!before.previous) fail("UPDATE_ROLLBACK_UNAVAILABLE");

    const previousMarker = markerFor(store, before.previous);
    if (!previousMarker) fail("UPDATE_ROLLBACK_UNAVAILABLE");
    assertMaintenanceRuntime(store, before.previous);
    await maintenance.drain();
    const rollbackStart = now();
    const result = store.rollback();
    try {
      await fixedAgentRestart(config.supervisorSocket, restartRequest);
    } catch {
      store.rollback();
      await fixedAgentRestart(config.supervisorSocket, restartRequest);
      fail("UPDATE_ROLLBACK_RESTART_FAILED");
    }

    for (let attempt = 0; attempt < config.health.attempts; attempt += 1) {
      if (
        freshAuthenticatedConnection(
          agentStateDir,
          rollbackStart,
          previousMarker,
        )
      ) {
        return { rolledBack: true, ...result };
      }
      if (attempt + 1 < config.health.attempts)
        await sleep(config.health.delayMs);
    }

    store.rollback();
    await fixedAgentRestart(config.supervisorSocket, restartRequest);
    fail("UPDATE_ROLLBACK_HEALTH_FAILED");
  } finally {
    maintenance.close();
  }
}
