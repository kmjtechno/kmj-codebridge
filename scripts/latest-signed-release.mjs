#!/usr/bin/env node
// Resolve the revision of the newest owner-signed stable release recorded in
// releases/stable/<revision>/release-manifest.json (highest sequence wins).
// The VPS smoke compares the LIVE gateway commit against this revision, so
// docs/tests/metadata-only merges after a release never make the gate red,
// while a gateway that lags the newest signed release still fails.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;

export function latestSignedRelease(root = "releases/stable") {
  let best = null;
  for (const dir of readdirSync(root)) {
    if (!FULL_SHA.test(dir)) continue;
    const file = join(root, dir, "release-manifest.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (manifest.revision !== dir) throw new Error("RELEASE_REVISION_DIR_MISMATCH");
    if (!Number.isInteger(manifest.sequence) || manifest.sequence < 1) {
      throw new Error("RELEASE_SEQUENCE_INVALID");
    }
    if (best && manifest.sequence === best.sequence) {
      throw new Error("RELEASE_SEQUENCE_DUPLICATE");
    }
    if (!best || manifest.sequence > best.sequence) {
      best = { sequence: manifest.sequence, revision: manifest.revision };
    }
  }
  if (!best) throw new Error("RELEASE_NONE_FOUND");
  return best;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { sequence, revision } = latestSignedRelease(process.argv[2] ?? undefined);
    console.log(`LATEST_SIGNED_RELEASE sequence=${sequence} revision=${revision}`);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_OUTPUT, `revision=${revision}\nsequence=${sequence}\n`);
    }
  } catch (error) {
    console.error("LATEST_SIGNED_RELEASE=FAIL " + (error?.message ?? "UNKNOWN"));
    process.exit(1);
  }
}
