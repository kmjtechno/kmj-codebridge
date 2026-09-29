import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
const [destination, project] = process.argv.slice(2);
try {
  if (!destination || !project)
    throw Error(
      "Usage: npm run init -- /outside-project/config-dir /absolute/project",
    );
  const root = fs.realpathSync(project),
    requested = path.resolve(destination),
    dest = path.join(
      fs.realpathSync(path.dirname(requested)),
      path.basename(requested),
    ),
    rel = path.relative(root, dest);
  if (
    !path.isAbsolute(project) ||
    !rel ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  )
    throw Error("Configuration must be outside the project.");
  fs.mkdirSync(dest, { recursive: false, mode: 0o700 });
  const user = randomBytes(32).toString("hex"),
    agent = randomBytes(32).toString("hex");
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  const write = (name, data) =>
    fs.writeFileSync(
      path.join(dest, name),
      typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  write("gateway.json", {
    host: "127.0.0.1",
    port: 8787,
    users: [
      {
        id: "owner",
        tenant: "kmj",
        tokenHash: hash(user),
        devices: { device1: ["project1"] },
        permissions: ["read", "write", "execute"],
      },
    ],
    agents: [{ id: "device1", tenant: "kmj", tokenHash: hash(agent) }],
  });
  write("agent.json", {
    gateway: "http://127.0.0.1:8787",
    token: agent,
    id: "device1",
    tenant: "kmj",
    stateDir: path.join(dest, "state"),
    projects: [{ id: "project1", root, writable: false, gates: {} }],
    license: { mode: "free" },
  });
  write("client-token.txt", user + "\n");
  console.log(
    "Created gateway.json, agent.json and client-token.txt. Protect this directory; no credentials printed. Projects start read-only.",
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
