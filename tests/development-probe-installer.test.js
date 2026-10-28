import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../scripts/production/", import.meta.url));
const script = path.join(root, "install-development-probe.sh");
const unit = path.join(root, "kmj-codebridge-development-ci.service");
const helper = path.join(root, "kmj-codebridge-dev-probe.py");
const sha = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("owner-only installer pins the exact merged non-root unit and helper", () => {
  assert.equal(
    sha(unit),
    "b851bb24cc5a846e3fc95a96893483f0dfd6540c91bc37d93a4f91aefd0ef53b",
  );
  assert.equal(
    sha(helper),
    "1191b0ebff956e64da17e52b6dd65b43afe3c80bdad21900a4c719d941da5be7",
  );
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /--inspect/);
  assert.match(source, /--install/);
  assert.match(source, /KMJ-elite/);
  assert.match(source, /\/root\/kmj-approved/);
  assert.match(source, /systemctl daemon-reload/);
  assert.doesNotMatch(
    source,
    /\bsystemctl\s+(?:start|enable|restart|isolate)\b/,
  );
  assert.doesNotMatch(source, /\b(?:curl|wget|sudo|ssh|iptables|ufw)\s/);
  assert.doesNotMatch(source, /main-platform-production-release\.json/);
  assert.match(source, /KMJ_AUTONOMOUS_CODING=NOT_ENABLED/);
});

test(
  "inspect mode is non-mutating and rejects a modified unit before privileged operations",
  { skip: process.platform === "win32" },
  () => {
    execFileSync("bash", ["-n", script], { timeout: 5000 });
    const clean = spawnSync("bash", [script, "--inspect"], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /KMJ_DEV_SOURCE_PIN=PASS/);
    assert.match(clean.stdout, /INSPECT_ONLY/);

    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "kmj-dev-installer-test-"),
    );
    try {
      for (const file of [script, unit, helper]) {
        fs.copyFileSync(file, path.join(dir, path.basename(file)));
      }
      fs.appendFileSync(
        path.join(dir, path.basename(unit)),
        "# tampered unit\n",
      );
      const bad = spawnSync(
        "bash",
        [path.join(dir, path.basename(script)), "--inspect"],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /BLOCKED_UNIT_PIN/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("installer publishes with atomic no-clobber links and preserves partial-state review", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /if ! ln -T -- "\\$helper_tmp" "\\$helper_target"/);
  assert.match(source, /if ! ln -T -- "\\$unit_tmp" "\\$unit_target"/);
  assert.doesNotMatch(source, /^\\s*mv\\s+-T\\s+--/m);
  assert.match(source, /BLOCKED_%s/);
  assert.match(source, /PARTIAL_INSTALL_REVIEW_REQUIRED/);
  assert.match(source, /PUBLISHED_HELPER_PIN/);
  assert.match(source, /PUBLISHED_UNIT_PIN/);
});

test(
  "Linux same-directory no-clobber publication refuses competing files and symlinks",
  { skip: process.platform !== "linux" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-dev-no-clobber-"));
    const publish = (src, dest) =>
      spawnSync("ln", ["-T", "--", src, dest], {
        encoding: "utf8",
        timeout: 5000,
      });
    try {
      const src = path.join(dir, "staged");
      const dest = path.join(dir, "installed");
      const victim = path.join(dir, "victim");
      fs.writeFileSync(src, "PINNED_NEW_CONTENT");
      fs.writeFileSync(victim, "PRESERVE_VICTIM");

      // A competing file may arrive after any earlier absence precheck.
      assert.equal(fs.existsSync(dest), false);
      fs.writeFileSync(dest, "PRESERVE_EXISTING");
      assert.notEqual(publish(src, dest).status, 0);
      assert.equal(fs.readFileSync(dest, "utf8"), "PRESERVE_EXISTING");
      fs.unlinkSync(dest);

      // A competing symlink must neither be followed nor replaced.
      fs.symlinkSync(victim, dest);
      assert.notEqual(publish(src, dest).status, 0);
      assert.equal(fs.readlinkSync(dest), victim);
      assert.equal(fs.readFileSync(victim, "utf8"), "PRESERVE_VICTIM");
      fs.unlinkSync(dest);

      // First successful atomic create wins; later candidates cannot replace.
      assert.equal(publish(src, dest).status, 0);
      const other = path.join(dir, "other");
      fs.writeFileSync(other, "UNAPPROVED_OTHER_CONTENT");
      assert.notEqual(publish(other, dest).status, 0);
      assert.equal(fs.readFileSync(dest, "utf8"), "PINNED_NEW_CONTENT");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
