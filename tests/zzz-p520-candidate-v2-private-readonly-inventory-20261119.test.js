import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyFile,
  classifyPolicy,
} from "../scripts/windows/P520-V2-PRIVATE-RECOVERY-INVENTORY-20261119.mjs";

const stat = (kind = "file", size = 1024) => ({
  isFile: () => kind === "file",
  isSymbolicLink: () => kind === "symlink",
  nlink: 1,
  size,
});
const onP520 =
  process.platform === "win32" &&
  os.hostname().toUpperCase() === "DESKTOP-5FVJMET";

test("V2 inventory treats missing and unsafe cipher as non-evidence", () => {
  assert.equal(classifyFile(null), "MISSING");
  assert.equal(classifyFile(stat("symlink")), "UNSAFE_OR_INVALID");
  assert.equal(classifyFile(stat("directory")), "UNSAFE_OR_INVALID");
  assert.equal(classifyFile({ ...stat(), nlink: 2 }), "UNSAFE_OR_INVALID");
  assert.equal(classifyFile(stat("file", 127), 256), "UNSAFE_OR_INVALID");
  assert.equal(classifyFile(stat("file", 1024), 256), "PRESENT_UNATTESTED");
});

test("V2 inventory requires exact immutable image digest, no auto-pin", () => {
  const digest = "a".repeat(64);
  assert.equal(classifyPolicy(null, ""), "MISSING_OR_UNTRUSTED");
  assert.equal(
    classifyPolicy(stat("file", 64), digest),
    "FORMAT_PASS_NOT_OWNER_ATTESTED",
  );
  assert.equal(
    classifyPolicy(stat("file", 65), digest + "\n"),
    "FORMAT_PASS_NOT_OWNER_ATTESTED",
  );
  assert.equal(
    classifyPolicy(stat("file", 66), digest + "\r\n"),
    "FORMAT_PASS_NOT_OWNER_ATTESTED",
  );
  assert.equal(classifyPolicy(stat("file", 64), "z".repeat(64)), "MALFORMED");
  assert.equal(
    classifyPolicy(stat("file", 66), digest + "  "),
    "MALFORMED",
  );
  assert.equal(
    classifyPolicy(stat("symlink", 64), digest),
    "MISSING_OR_UNTRUSTED",
  );
});

test(
  "P520 owner-host exact candidate V2 private inventory is read-only",
  { skip: !onP520 },
  () => {
    const script = fileURLToPath(
      new URL(
        "../scripts/windows/P520-V2-PRIVATE-RECOVERY-INVENTORY-20261119.mjs",
        import.meta.url,
      ),
    );
    const r = spawnSync(process.execPath, [script, "--inspect"], {
      encoding: "utf8",
      timeout: 25000,
      windowsHide: true,
      maxBuffer: 16384,
    });
    const rows = String(r.stdout ?? "").split(/\r?\n/);
    const safeMarkers = [
      "P520_V2_CANDIDATE_SHA=",
      "P520_V2_CIPHER=",
      "P520_V2_CIPHER_PARTIAL=",
      "P520_V2_OWNER_IMAGE_POLICY=",
      "P520_V2_LOCAL_PINNED_IMAGE=",
      "P520_V2_INVENTORY=",
    ];
    for (const prefix of safeMarkers) {
      const marker = rows.find((line) => line.startsWith(prefix));
      assert.ok(marker, "P520_MISSING_DIAGNOSTIC_" + prefix);
      console.log(marker);
    }
    assert.ok(rows.includes("P520_V2_ARCHIVE_SHA_READBACK=NOT_EXECUTED"));
    assert.ok(rows.includes("P520_V2_PHYSICAL_PG_UPLOADS_RESTORE=NOT_EXECUTED"));
    assert.ok(rows.includes("PRODUCTION_APPROVAL=NOT_GRANTED"));
    assert.ok(rows.includes("P520_V2_INVENTORY=READ_ONLY_COMPLETE"));
    assert.equal(r.status, 0, "P520_V2_INVENTORY_READONLY_FAILED");
  },
);
