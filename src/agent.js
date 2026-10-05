import { requestRenewal } from "./renewal.js";
import { readJsonLimited } from "./http.js";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agentSchema } from "./config.js";
import { JobRunner } from "./jobs.js";
import { AutopilotJournal } from "./autopilot.js";
import { AuditLedger } from "./audit.js";
import { supervisorRequest } from "./supervisor-client.js";
import { createDispatcher } from "./tools.js";
import { verifyEntitlement } from "./license.js";
import { fail, publicError } from "./errors.js";
import { acquireAgentLock, releaseAgentLock } from "./agent-lock.js";
import { VERSION } from "./version.js";
export async function startAgent(rawConfig) {
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
    runner = new JobRunner(path.join(state, "jobs"));
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
  const supervisor = c.supervisorSocket
    ? {
        request: (request) => supervisorRequest(c.supervisorSocket, request),
      }
    : null;
  const dispatch = createDispatcher(
    c,
    runner,
    licenseProvider,
    autopilot,
    supervisor,
    audit,
  );
  const controller = new AbortController();
  let stopped = false;
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
  const markConnected = () => {
    if (connected) return;
    connected = true;
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
    if (!response.ok) throw Error("GATEWAY_REQUEST_FAILED");
    markConnected();
    return readJsonLimited(response.body);
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
          let result;
          try {
            const output = await dispatch(
              work.tool,
              work.args,
              work.permissions,
            );
            result = {
              content: [{ type: "text", text: JSON.stringify(output) }],
            };
          } catch (e) {
            result = {
              isError: true,
              content: [{ type: "text", text: JSON.stringify(publicError(e)) }],
            };
          }
          await post("/agent/result", { id: work.id, result });
        }
      } catch {
        if (stopped) break;
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
      controller.abort();
      await loop;
      await runner.close();
      releaseAgentLock(agentLock);
    },
  };
}
