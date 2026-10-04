#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  beginDeviceEnrollment,
  pollDeviceEnrollment,
} from "../src/enrollment.js";

const [base, device, projectId, projectRoot, output] = process.argv.slice(2);
if (!base || !device || !projectId || !projectRoot || !output) {
  console.error(
    "Usage: node scripts/enroll-device.js <https-base> <device-id> <project-id> <project-root> <private-output>",
  );
  process.exit(2);
}
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
  const handle = await beginDeviceEnrollment(base, request);
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

  const parent = fs.realpathSync(path.dirname(path.resolve(output)));
  const target = path.join(parent, path.basename(output));
  const fd = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        gateway: approved.gateway ?? null,
        agent: approved.agent,
        projects: approved.projects,
        permissions: approved.permissions,
        credential_expires_at: approved.credential_expires_at ?? null,
      }) + "\n",
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  console.log("Device approved and enrollment credential stored securely.");
} catch (error) {
  console.error(
    "Enrollment failed. Approval may be missing, expired, denied, or the server contract may be unavailable.",
  );
  process.exitCode = 1;
}
