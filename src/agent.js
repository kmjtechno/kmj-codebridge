import { requestRenewal } from "./renewal.js";
import { readJsonLimited } from "./http.js";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agentSchema } from "./config.js";
import { AgentUpdateGuard } from "./update-maintenance.js";
import { JobRunner } from "./jobs.js";
import { AutopilotJournal } from "./autopilot.js";
import { startOptionalAutopilotContinuationBridge } from "./autopilot-continuation-bridge.js";
import { startAutopilotGateWorker } from "./autopilot-gate-worker.js";
import { startIsolatedRepairWorker } from "./autopilot-repair-worker.js";
import { startGitHubCiWatchWorker } from "./autopilot-ci-watch-worker.js";
import { WorktreeLanes } from "./worktree-lanes.js";
import { startLocalAutopilotDraftWorker } from "./autopilot-local-worker.js";
import { createLocalModelClient } from "./local-model.js";
import { AuditLedger } from "./audit.js";
import {
  supervisorRequest,
  windowsSupervisorRequest,
} from "./supervisor-client.js";
import { createDispatcher } from "./tools.js";
import {
  createToolGuardHost,
  registerReadOnlyProjectGuard,
} from "./tool-guard-host.js";
import { verifyEntitlement } from "./license.js";
import { fail, publicError } from "./errors.js";
import { acquireAgentLock, releaseAgentLock } from "./agent-lock.js";
import {
  AgentConnectionRecorder,
  gatewayFailureCode,
} from "./agent-connection-status.js";
import { VERSION } from "./version.js";
export async function startAgent(
  rawConfig,
  { createUpdateGuard = (options) => new AgentUpdateGuard(options) } = {},
) {
  const c = agentSchema.parse(rawConfig);
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
  if (new Set(c.projects.map((p) => p.id)).size !== c.projects.length)
    fail("DUPLICATE_PROJECT");
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const state = fs.realpathSync(c.stateDir);
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
  const licenseState = path.join(state, "license-state.json");
  let trusted = fs.existsSync(licenseState)
    ? JSON.parse(fs.readFileSync(licenseState, "utf8"))
    : { sequence: -1, lastTime: 0 };
  const licenseProvider = () => {
    if (c.license.mode === "free")
      return {
        features: ["read", "write", "execute"],
        limits: { concurrent_jobs: 1 },
      };
    const now = Math.floor(Date.now() / 1000);
    if (now + 60 < trusted.lastTime) fail("LICENSE_CLOCK_ROLLBACK");
    const token = fs.readFileSync(c.license.tokenFile, "utf8").trim();
    const p = verifyEntitlement(
      token,
      c.license.keys,
      { tenant: c.tenant, device: c.id },
      now,
    );
    if (p.sequence < trusted.sequence) fail("LICENSE_REPLAY");
    trusted = {
      sequence: p.sequence,
      lastTime: Math.max(now, trusted.lastTime),
    };
    const tmp = licenseState + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(trusted), { mode: 0o600 });
    fs.renameSync(tmp, licenseState);
    return p;
  };
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
    lanes: new WorktreeLanes(state),
  });
  const repairWorker = startIsolatedRepairWorker({
    activity,
    canStart: () => activity.canStart(),
    projects: c.projects,
    journal: autopilot,
    runner,
    licenseProvider,
    lanes: new WorktreeLanes(state),
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
  workers = [gateWorker, repairWorker, ciWatchWorker, localDraftWorker];
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
        authorization: `Bearer ${c.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
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
    if (now + 60 < trusted.lastTime) return;
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
        trusted.sequence,
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
            try {
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
            await post("/agent/result", { id: work.id, result });
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
    close: async () => {
      stopped = true;
      activity.close();
      controller.abort();
      await loop;
      await gateWorker.close();
      await localDraftWorker.close();
      await repairWorker.close();
      await ciWatchWorker.close();
      continuationBridge.close();
      await runner.close();
      releaseAgentLock(agentLock);
    },
  };
}
