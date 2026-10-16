import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import {
  createWindowsSupervisorConfigSchema,
  createWindowsSupervisorHandler,
  startWindowsSupervisor,
  verifyTokenFileAcl,
} from "./windows-supervisor.js";

// Entry used by `node src/cli.js windows-supervisor <config.json>`. It refuses
// to run anywhere but Windows, refuses a token file whose ACL is broad, and
// never prints configuration or secret values.
export async function runWindowsSupervisorCli(configFile, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") fail("SUPERVISOR_UNSUPPORTED");
  const schema = createWindowsSupervisorConfigSchema(path.win32);
  const config = schema.parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
  const acl = await verifyTokenFileAcl(config.tokenFile, deps.acl);
  if (!acl.ok) fail("SUPERVISOR_TOKEN_ACL_UNSAFE");
  const token = fs.readFileSync(config.tokenFile, "utf8").trim();
  const handler = createWindowsSupervisorHandler({ config, ...deps.handler });
  return await (deps.start ?? startWindowsSupervisor)({
    pipePath: `\\\\.\\pipe\\${config.pipeName}`,
    token,
    handler,
  });
}
