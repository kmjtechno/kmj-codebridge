import fs from "node:fs";
import path from "node:path";
import { enrolledAgentSchema } from "../src/config.js";
import { provisionReceiptKey } from "../src/hosted-receipt-key.js";
import { privateWindowsReceiptPath } from "../src/receipt-windows-custody.js";
import { loadPilotSigner } from "../src/hosted-metering-pilot.js";
import { signerEnrollmentMessage } from "../src/receipt-enrollment-proof.js";

try {
  const [configFile, destination, confirmation, challengeFile, ...extra] =
    process.argv.slice(2);
  if (
    extra.length ||
    confirmation !== "OWNER_APPROVES_LOCAL_RECEIPT_KEY" ||
    !configFile ||
    !destination ||
    !path.isAbsolute(configFile)
  )
    throw Error();
  const windows = process.platform === "win32";
  const stat = fs.lstatSync(configFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (windows
      ? !privateWindowsReceiptPath(configFile)
      : stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) ||
    stat.size > 65536
  )
    throw Error();
  const config = enrolledAgentSchema.parse(
    JSON.parse(fs.readFileSync(configFile, "utf8")),
  );
  if (path.resolve(destination) === fs.realpathSync(configFile)) throw Error();
  const result = await provisionReceiptKey(config, destination);
  if (!challengeFile) {
    console.log(JSON.stringify(result));
  } else {
    const info = fs.lstatSync(challengeFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
      throw Error();
    const challenge = JSON.parse(fs.readFileSync(challengeFile, "utf8"));
    const message = signerEnrollmentMessage(
      challenge,
      config,
      result.publicKey,
    );
    const signer = await loadPilotSigner({
      ...config,
      hostedReceiptKeyFile: destination,
    });
    console.log(
      JSON.stringify({
        public_key: result.publicKey,
        signature: signer(message),
        confirm: "APPROVE_DEVICE_RECEIPT_SIGNER",
      }),
    );
  }
} catch {
  console.error("HOSTED_RECEIPT_KEY_PROVISIONING_BLOCKED");
  process.exitCode = 1;
}
