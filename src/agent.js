import { requestRenewal } from "./renewal.js";
import {
  loadPilotSigner,
  pilotReceiptMessage,
} from "./hosted-metering-pilot.js";
import { readJsonLimited } from "./http.js";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { enrolledAgentSchema } from "./config.js";
import { resolveAgentGatewayCredential } from "./agent-gateway-credential.js";
import { AgentUpdateGuard } from "./update-maintenance.js";
import { JobRunner } from "./jobs.js";
import { AutopilotJournal } from "./autopilot.js";
import { startOptionalAutopilotContinuationBridge } from "./autopilot-continuation-bridge.js";
import { startAutopilotGateWorker } from "./autopilot-gate-worker.js";
import { startWorkspaceJobWorker } from "./workspace-job-worker.js";
import { startIsolatedRepairWorker } from "./autopilot-repair-worker.js";
import { startGitHubCiWatchWorker } from "./autopilot-ci-watch-worker.js";
import { WorktreeLanes } from "./worktree-lanes.js";
import { startLocalAutopilotDraftWorker } from "./autopilot-local-worker.js";
import {
  startLocalFirstCodingWorker,
  codingRouteApproved,
} from "./autopilot-coding-worker.js";
import { createVerifiedFreeCloudCodingModel } from "./cloud-coding-model.js";
import { createConfiguredFreeLlmApiClient } from "./freellmapi-runtime.js";
import { createLocalModelClient } from "./local-model.js";
import { AuditLedger } from "./audit.js";
import {
  supervisorRequest,
  windowsSupervisorRequest,
  ELITE_CLOUDOS_SUPERVISOR_SOCKET,
  ELITE_DEV_SUPERVISOR_SOCKET,
} from "./supervisor-client.js";
import { createDispatcher } from "./tools.js";
import {
  createToolGuardHost,
  registerReadOnlyProjectGuard,
} from "./tool-guard-host.js";
import { createLicenseProvider } from "./license-provider.js";
import { fail, publicError } from "./errors.js";
import { acquireAgentLock, releaseAgentLock } from "./agent-lock.js";
import { singleFlightClose } from "./single-flight-close.js";
import {
  AgentConnectionRecorder,
  gatewayFailureCode,
} from "./agent-connection-status.js";
import { VERSION } from "./version.js";

// Must stay above the gateway's AGENT_POLL_WAIT_CAP_MS (src/gateway.js), or an
// idle long poll is aborted and counted as a connection failure.
export const AGENT_REQUEST_TIMEOUT_MS = 20000;
// Exact project-binding guard shared by startup and hermetic profile tests.
// A dedicated socket never authorizes access to a different enrolled project.
export function assertSupervisorProjectSocketScope(config) {
  const scopes = [
    [
      ELITE_CLOUDOS_SUPERVISOR_SOCKET,
      "kmj-cloudos",
      "ELITE_CLOUDOS_SUPERVISOR_PROJECT_MISMATCH",
    ],
    [
      ELITE_DEV_SUPERVISOR_SOCKET,
      "kmj-codebridge",
      "ELITE_DEV_SUPERVISOR_PROJECT_MISMATCH",
    ],
  ];
  for (const [socket, project, reason] of scopes) {
    if (
      config.supervisorSocket === socket &&
      (config.projects?.length !== 1 || config.projects[0]?.id !== project)
    )
      throw new Error(reason);
  }
}

// Operator-selected via a root-owned systemd drop-in. No private enrollment
// file rewrite is necessary: this exact read-only socket is usable ONLY by
// the separately enrolled Elite kmjdev development agent. Neither generic
// environment paths nor agent-controlled project settings are accepted.
export function resolveEliteDevSupervisorSocket(
  config,
  {
    env = process.env,
    platform = process.platform,
    stat = fs.lstatSync,
    uid = process.getuid?.(),
    gid = process.getgid?.(),
  } = {},
) {
  const flag = env.KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND;
  if (flag === undefined) return config.supervisorSocket;
  if (
    flag !== "1" ||
    platform !== "linux" ||
    config.id !== "kmj-codebridge-elite" ||
    config.projects?.length !== 1 ||
    config.projects[0]?.id !== "kmj-codebridge" ||
    (config.supervisorSocket &&
      config.supervisorSocket !== ELITE_DEV_SUPERVISOR_SOCKET) ||
    config.supervisorPipe ||
    config.supervisorTokenFile ||
    !Number.isSafeInteger(uid) ||
    uid === 0 ||
    !Number.isSafeInteger(gid)
  )
    throw new Error("ELITE_DEV_SUPERVISOR_BINDING_DENIED");
  // The fixed socket MUST already be installed under the dedicated
  // kmjdev identity. Do not allow startup to silently fall back to Main
  // Platform or CloudOS when the socket is absent or malformed.
  try {
    const parent = stat("/run/kmj-codebridge-dev");
    const socket = stat(ELITE_DEV_SUPERVISOR_SOCKET);
    if (
      !parent.isDirectory() ||
      parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0 ||
      !socket.isSocket() ||
      socket.uid !== uid ||
      socket.gid !== gid ||
      socket.nlink !== 1 ||
      (socket.mode & 0o777) !== 0o600
    )
      throw new Error("INVALID_DEV_SOCKET");
  } catch {
    throw new Error("ELITE_DEV_SUPERVISOR_BINDING_UNAVAILABLE");
  }
  return ELITE_DEV_SUPERVISOR_SOCKET;
}

export async function startAgent(
  rawConfig,
  { createUpdateGuard = (options) => new AgentUpdateGuard(options) } = {},
) {
  const c = enrolledAgentSchema.parse(rawConfig);
  const dedicatedSocket = resolveEliteDevSupervisorSocket(c);
  if (dedicatedSocket !== undefined) c.supervisorSocket = dedicatedSocket;
  // Validate the gateway's credential source before acquiring an agent lock,
  // starting workers, or contacting the network. No credential is logged.
  const gatewayCredential = await resolveAgentGatewayCredential(c);
  const receiptSigner = await loadPilotSigner(c);
  const url = new URL(c.gateway);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    fail("HTTPS_REQUIRED");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail("INVALID_GATEWAY_URL");
  if (c.license.mode === "free" && c.projects.length !== 1)
    fail("FREE_PROJECT_LIMIT");
  if (
    c.license.mode === "signed" &&
    c.license.fallbackToFree === true &&
    c.projects.length !== 1
  )
    fail("FREE_PROJECT_LIMIT");
  if (new Set(c.projects.map((p) => p.id)).size !== c.projects.length)
    fail("DUPLICATE_PROJECT");
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const state = fs.realpathSync(c.stateDir);
  let laneBase;
  if (c.laneBaseDir !== undefined) {
    fs.mkdirSync(c.laneBaseDir, { recursive: true, mode: 0o700 });
    laneBase = fs.realpathSync(c.laneBaseDir);
  }
  if (c.license.mode === "signed")
    c.license.tokenFile = fs.realpathSync(c.license.tokenFile);
  for (const project of c.projects) {
    const root = fs.realpathSync(project.root);
    if (c.license.mode === "signed") {
      const tokenPath = fs.realpathSync(c.license.tokenFile);
      const tokenRel = path.relative(root, tokenPath);
      if (
        !tokenRel ||
        (!tokenRel.startsWith(".." + path.sep) &&
          tokenRel !== ".." &&
          !path.isAbsolute(tokenRel))
      )
        fail("LICENSE_INSIDE_PROJECT");
    }
    const rel = path.relative(root, state);
    if (
      !rel ||
      (!rel.startsWith(".." + path.sep) &&
        rel !== ".." &&
        !path.isAbsolute(rel))
    )
      fail("STATE_INSIDE_PROJECT");
    if (laneBase) {
      // Lane base must be disjoint from every project tree in both directions.
      for (const [a, b] of [
        [root, laneBase],
        [laneBase, root],
      ]) {
        const r = path.relative(a, b);
        if (
          !r ||
          (!r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r))
        )
          fail("LANE_BASE_INSIDE_PROJECT");
      }
    }
  }
  const agentLock = acquireAgentLock(state);
  let runner;
  let autopilot;
  let audit;
  try {
    runner = new JobRunner(path.join(state, "jobs"), {
      archiveMaxEntries: c.jobArchiveMaxEntries,
    });
    autopilot = new AutopilotJournal(path.join(state, "autopilot"));
    audit = new AuditLedger(path.join(state, "audit"));
  } catch (e) {
    if (runner) await runner.close();
    releaseAgentLock(agentLock);
    throw e;
  }
  const licenseProvider = createLicenseProvider(c, state, {
    // Tamper-evident record of licence state changes, written to every project
    // ledger with the existing audit schema (no tool input or token content).
    onTransition: ({ to, code }) => {
      for (const project of c.projects)
        audit.append(project.id, {
          device: c.id,
          tool: "license_state",
          access: "read",
          risk: "READ",
          phase: "result",
          outcome: to === "ACTIVE" || to === "GRACE" ? "succeeded" : "failed",
          error: code ?? undefined,
        });
    },
  });
  assertSupervisorProjectSocketScope(c);
  if (c.supervisorSocket && (c.supervisorPipe || c.supervisorTokenFile))
    throw new Error(
      "Configure either the Linux supervisor socket or the Windows pipe, not both.",
    );
  if (Boolean(c.supervisorPipe) !== Boolean(c.supervisorTokenFile))
    throw new Error(
      "supervisorPipe and supervisorTokenFile must be configured together.",
    );
  const supervisor = c.supervisorSocket
    ? {
        request: (request) => supervisorRequest(c.supervisorSocket, request),
      }
    : c.supervisorPipe
      ? {
          request: (request) =>
            windowsSupervisorRequest(
              { pipePath: c.supervisorPipe, tokenFile: c.supervisorTokenFile },
              request,
            ),
        }
      : null;
  let localModelClient;
  const localModel = () => (localModelClient ??= createLocalModelClient());
  let workerHandles = null;
  let workers = [];
  const activity = createUpdateGuard({
    stateDir: state,
    agentOwner: agentLock.owner,
    isIdle: () =>
      runner.active.size === 0 &&
      runner.pending.size === 0 &&
      workers.every((worker) => worker.isIdle()),
  });

  const toolGuardHost = createToolGuardHost();
  registerReadOnlyProjectGuard(toolGuardHost);
  const dispatch = createDispatcher(
    c,
    runner,
    licenseProvider,
    autopilot,
    supervisor,
    audit,
    localModel,
    () => workerHandles,
    toolGuardHost,
  );
  const gateWorker = startAutopilotGateWorker({
    activity,
    canStart: () => activity.canStart(),
    projects: c.projects,
    journal: autopilot,
    runner,
    licenseProvider,
    // Reuse audited WorktreeLanes boundaries. This never executes another
    // agent's dirty checkout; enabling still requires admin-approved gates.
    lanes: new WorktreeLanes(state, laneBase),
  });
  const repairWorker = startIsolatedRepairWorker({
    activity,
    canStart: () => activity.canStart(),
    projects: c.projects,
    journal: autopilot,
    runner,
    licenseProvider,
    lanes: new WorktreeLanes(state, laneBase),
  });
  const ciWatchWorker = startGitHubCiWatchWorker({
    activity,
    canStart: () => activity.canStart(),
    projects: c.projects,
    journal: autopilot,
    licenseProvider,
  });
  const localDraftWorker = startLocalAutopilotDraftWorker({
    activity,
    canStart: () => activity.canStart(),
    projects: c.projects,
    journal: autopilot,
    licenseProvider,
    localModel,
    runner,
  });
  const codingWorker = startLocalFirstCodingWorker({
    activity,
    canStart: () => activity.canStart(),
    projects: c.projects,
    journal: autopilot,
    runner,
    licenseProvider,
    localModel,
    cloudModel: (project) => {
      const approvedConfig = project.autopilotCodingWorker;
      return createVerifiedFreeCloudCodingModel({
        // Use the SAME owner-controlled zero-cost verifier wiring as the
        // read-only FreeLLMAPI tools. The plain client rejects all routes
        // even when independently attested device proofs are installed.
        // This remains fail-closed if the device's owner-controlled key,
        // pinned route manifest, snapshot or verified free quota is absent.
        createClient: createConfiguredFreeLlmApiClient,
        authorized: () =>
          project.writable === true &&
          project.autopilotCodingWorker === approvedConfig &&
          approvedConfig?.inferenceRoute === "verified-free-cloud-only" &&
          codingRouteApproved(approvedConfig),
      });
    },
    lanes: new WorktreeLanes(state, laneBase),
  });
  // Opt-in Main Platform workspace tool queue. Uses ONLY the device's existing signed-license
  // renewal credential and that endpoint's own origin; no new listener, URL or installer.
  const renewalConfig =
    c.license.mode === "signed" ? c.license.renewal : undefined;
  const workspaceJobWorker = startWorkspaceJobWorker({
    activity,
    projects: c.projects,
    runner,
    licenseProvider,
    origin: renewalConfig ? new URL(renewalConfig.endpoint).origin + "/" : null,
    credential: renewalConfig?.credential ?? null,
  });
  workers = [
    gateWorker,
    workspaceJobWorker,
    repairWorker,
    ciWatchWorker,
    localDraftWorker,
    codingWorker,
  ];
  const continuationBridge = startOptionalAutopilotContinuationBridge({
    journal: autopilot,
    stateDir: state,
    projects: c.projects.map((project) => project.id),
  });
  activity.start();
  const controller = new AbortController();
  let stopped = false;
  workerHandles = {
    gate: gateWorker.enabledProjects,
    repair: repairWorker.enabledProjects,
    githubCiWatch: ciWatchWorker.enabledProjects,
    localDraft: localDraftWorker.enabledProjects,
    coding: codingWorker.enabledProjects,
    continuation: continuationBridge.projects,
    continuationStatus: (project) => continuationBridge.status(project),
    get agentRunning() {
      return !stopped;
    },
  };
  const connectionState = path.join(state, "connection.json");
  const runtimeIdentity = () => {
    const identity = { version: VERSION, release: null };
    try {
      const marker = JSON.parse(
        fs.readFileSync(
          new URL("../.codebridge-release.json", import.meta.url),
          "utf8",
        ),
      );
      if (
        marker?.schema === 1 &&
        marker.version === VERSION &&
        Number.isSafeInteger(marker.sequence) &&
        marker.sequence >= 0 &&
        typeof marker.revision === "string" &&
        /^[a-f0-9]{40}$/.test(marker.revision) &&
        typeof marker.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(marker.sha256)
      )
        identity.release = {
          sequence: marker.sequence,
          version: marker.version,
          revision: marker.revision,
          sha256: marker.sha256,
        };
    } catch {}
    return identity;
  };
  let connected = false;
  const connectionRecorder = new AgentConnectionRecorder(state);
  const markConnected = () => {
    if (connected) return;
    const now = Date.now();
    const tmp = connectionState + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        connectedAt: new Date(now).toISOString(),
        ...runtimeIdentity(),
      }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, connectionState);
    connected = true;
    connectionRecorder.record("CONNECTED");
  };
  const post = async (endpoint, data) => {
    const response = await fetch(new URL(endpoint, c.gateway), {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
      ]),
      redirect: "error",
    });
    if (!response.ok) {
      const error = new Error("GATEWAY_REQUEST_FAILED");
      error.code = gatewayFailureCode(response.status);
      throw error;
    }
    const payload = await readJsonLimited(response.body);
    markConnected();
    return payload;
  };
  let nextRenewal = 0;
  const renew = async () => {
    if (
      c.license.mode !== "signed" ||
      !c.license.renewal ||
      Date.now() < nextRenewal
    )
      return;
    nextRenewal = Date.now() + c.license.renewal.intervalSeconds * 1000;
    const now = Math.floor(Date.now() / 1000);
    if (now + 60 < licenseProvider.trusted().lastTime) return;
    try {
      // Check the installed cache before requesting a strictly newer signed lease.
      // If it is expired, persisted high-water marks still constrain renewal.
      try {
        licenseProvider();
      } catch (e) {
        if (e.code === "LICENSE_CLOCK_ROLLBACK" || e.code === "LICENSE_REPLAY")
          return;
      }
      const renewal = await requestRenewal(
        c.license.renewal,
        c.license.keys,
        { tenant: c.tenant, device: c.id },
        licenseProvider.trusted().sequence,
        { signal: controller.signal },
      );
      const tmp = c.license.tokenFile + ".renew-" + process.pid;
      let fd;
      try {
        fd = fs.openSync(tmp, "wx", 0o600);
        fs.writeFileSync(fd, renewal.token);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, c.license.tokenFile);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
      licenseProvider();
    } catch {
      // An outage never fabricates an entitlement or extends signed grace.
      // Tool dispatch independently revalidates the installed lease.
    }
  };
  const loop = (async () => {
    let failures = 0;
    let needsHealthProbe = true;
    while (!stopped) {
      try {
        await renew();
        if (needsHealthProbe) {
          await post("/agent/health", {});
          needsHealthProbe = false;
        }
        const work = await post("/agent/poll", {});
        failures = 0;
        if (work) {
          await activity.track(async () => {
            let result;
            let receiptMessage;
            try {
              if (work.metering !== undefined) {
                if (!receiptSigner)
                  throw Error("HOSTED_RECEIPT_SIGNER_MISSING");
                receiptMessage = pilotReceiptMessage(work.metering, work, c);
              }
              const output = await activity.run(() =>
                dispatch(work.tool, work.args, work.permissions),
              );
              result = {
                content: [{ type: "text", text: JSON.stringify(output) }],
              };
            } catch (e) {
              result = {
                isError: true,
                content: [
                  { type: "text", text: JSON.stringify(publicError(e)) },
                ],
              };
            }
            await post("/agent/result", {
              id: work.id,
              result,
              ...(receiptMessage && !result.isError
                ? { receiptSignature: receiptSigner(receiptMessage) }
                : {}),
            });
          });
        }
      } catch (error) {
        if (stopped) break;
        connectionRecorder.record(error?.code);
        connected = false;
        needsHealthProbe = true;
        failures = Math.min(failures + 1, 6);
        try {
          await delay(Math.min(10000, c.pollMs * 2 ** failures), undefined, {
            signal: controller.signal,
          });
        } catch {
          break;
        }
      }
    }
  })();
  return {
    close: singleFlightClose(async () => {
      stopped = true;
      activity.close();
      controller.abort();
      await loop;
      await gateWorker.close();
      await workspaceJobWorker.close();
      await localDraftWorker.close();
      await repairWorker.close();
      await ciWatchWorker.close();
      continuationBridge.close();
      await runner.close();
      releaseAgentLock(agentLock);
    }),
  };
}
