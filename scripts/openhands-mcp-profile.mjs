#!/usr/bin/env node
// A read-only profile printout; no network or host inspection.
import { createOpenHandsCanvasHandoff } from "../src/openhands-canvas-interop.js";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/openhands-mcp-profile.mjs");
  process.exitCode = 2;
} else {
  console.log(JSON.stringify(createOpenHandsCanvasHandoff(), null, 2));
}
