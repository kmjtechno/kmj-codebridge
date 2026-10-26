#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  beginDeviceEnrollment,
  pollDeviceEnrollment,
} from "../src/enrollment.js";
import { assertEnrollmentServerReady } from "../src/enrollment-readiness.js";
import { reserveEnrollmentOutput } from "../src/enrollment-output.js";

const [base, device, projectId, projectRoot, output] = process.argv.slice(2);
if (!base || !device || !projectId || !projectRoot || !output) {
  console.error(
    "Usage: node scripts/enroll-device.js <https-base> <device-id> <project-id> <project-root> <private-output>",
  );
  process.exit(2);
}
let reservedOutput;
try {
  const root = fs.realpathSync(projectRoot);
  const request = {
    device: {
      id: device,
      name: os.hostname().slice(0, 128),
      platform: process.platform,
      arch: process.arch,
    },
    project: {
      id: projectId,
      name: path.basename(root).slice(0, 128),
    },
    permissions: ["read", "write", "execute"],
  };
  // Reserve before sending a one-time approval request. A missing, occupied,
  // or unwritable destination must fail without consuming a device grant.
  reservedOutput = reserveEnrollmentOutput(output);
  await assertEnrollmentServerReady(base);
  console.log("ENROLLMENT_SERVER_COMPATIBILITY=PASS_NOT_DEVICE_READY");
  const handle = await beginDeviceEnrollment(base, request);
  console.log("ENROLLMENT_STAGE=REQUEST_CREATED");
  console.log("KMJ CodeBridge device approval required.");
  console.log(
    `Open: ${handle.verification_uri_complete ?? handle.verification_uri}`,
  );
  console.log(`Pairing code: ${handle.user_code}`);
  console.log("Waiting for approval. No device credential will be printed.");

  let interval = handle.interval * 1000;
  let approved;
  while (Date.now() < handle.expires_at_ms) {
    await delay(interval);
    const result = await pollDeviceEnrollment(base, handle, request);
    if (result.state === "pending") continue;
    if (result.state === "slow_down") {
      interval = Math.min(interval + 5000, 30000);
      continue;
    }
    approved = result;
    break;
  }
  if (!approved) throw Error("ENROLLMENT_EXPIRED");
  console.log("ENROLLMENT_STAGE=APPROVAL_RECEIVED");

  reservedOutput.commit({
    gateway: approved.gateway ?? null,
    agent: approved.agent,
    projects: approved.projects,
    permissions: approved.permissions,
    credential_expires_at: approved.credential_expires_at ?? null,
  });
  reservedOutput = undefined;
  console.log("ENROLLMENT_STAGE=PRIVATE_GRANT_SAVED");
  console.log("Device approved and enrollment credential stored securely.");
} catch (error) {
  reservedOutput?.abort();
  // Print a bounded diagnostic code only. Never print verifier, device code,
  // response body, request URL with secrets, or the device bearer credential.
  const safeCode =
    error?.name === "CodeBridgeError" &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,72}$/.test(error.code)
      ? error.code
      : error?.name === "ZodError"
        ? "ENROLLMENT_RESPONSE_SCHEMA"
        : error?.message === "ENROLLMENT_EXPIRED"
          ? "ENROLLMENT_EXPIRED"
          : "ENROLLMENT_NETWORK_OR_RUNTIME";
  console.error("Enrollment failed: " + safeCode);
  console.error(
    "No credential was printed. Inspect browser approval and Main Platform pairing state.",
  );
  process.exitCode = 1;
}
