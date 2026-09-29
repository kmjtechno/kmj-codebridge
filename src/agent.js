import { readJsonLimited } from "./http.js";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agentSchema } from "./config.js";
import { JobRunner } from "./jobs.js";
import { createDispatcher } from "./tools.js";
import { verifyEntitlement } from "./license.js";
import { fail, publicError } from "./errors.js";
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
  const lock = path.join(state, "agent.lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    fail("AGENT_ALREADY_RUNNING_OR_STALE_LOCK");
  }
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  let runner;
  try {
    runner = new JobRunner(path.join(state, "jobs"));
  } catch (e) {
    fs.unlinkSync(lock);
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
  const dispatch = createDispatcher(c, runner, licenseProvider);
  const controller = new AbortController();
  let stopped = false;
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
    return readJsonLimited(response.body);
  };
  const loop = (async () => {
    let failures = 0;
    while (!stopped) {
      try {
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
        failures = Math.min(failures + 1, 6);
      }
      if (!stopped)
        try {
          await delay(Math.min(10000, c.pollMs * 2 ** failures), undefined, {
            signal: controller.signal,
          });
        } catch {
          break;
        }
    }
  })();
  return {
    close: async () => {
      stopped = true;
      controller.abort();
      await loop;
      await runner.close();
      fs.unlinkSync(lock);
    },
  };
}
