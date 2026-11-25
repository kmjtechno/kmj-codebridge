import fs from "node:fs";
import path from "node:path";
import { enrolledAgentSchema } from "../src/config.js";
import { provisionReceiptKey } from "../src/hosted-receipt-key.js";

try {
  const [configFile, destination, confirmation, ...extra] =
    process.argv.slice(2);
  if (
    extra.length ||
    confirmation !== "OWNER_APPROVES_LOCAL_RECEIPT_KEY" ||
    !configFile ||
    !destination ||
    !path.isAbsolute(configFile)
  )
    throw Error();
  if (process.platform === "win32") throw Error();
  const stat = fs.lstatSync(configFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 65536
  )
    throw Error();
  const config = enrolledAgentSchema.parse(
    JSON.parse(fs.readFileSync(configFile, "utf8")),
  );
  if (path.resolve(destination) === fs.realpathSync(configFile)) throw Error();
  console.log(JSON.stringify(await provisionReceiptKey(config, destination)));
} catch {
  console.error("HOSTED_RECEIPT_KEY_PROVISIONING_BLOCKED");
  process.exitCode = 1;
}
