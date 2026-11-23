import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test(
  "Windows OpenSSH -F resolves strict known_hosts config from a path with spaces",
  { skip: process.platform !== "win32" },
  () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "kmj ssh config spaces-"));
    try {
      const known = path.join(work, "known_hosts").replaceAll("\\", "/");
      const config = path.join(work, "ssh_config");
      fs.writeFileSync(
        config,
        [
          "Host 203.0.113.55",
          "  HostName 203.0.113.55",
          "  User root",
          "  HostKeyAlias 203.0.113.55",
          `  UserKnownHostsFile "${known}"`,
          "  StrictHostKeyChecking yes",
          "  HostKeyAlgorithms ssh-ed25519",
          "  GlobalKnownHostsFile none",
          "  UpdateHostKeys no",
          "  BatchMode no",
          "",
        ].join("\n"),
        "ascii",
      );
      const result = spawnSync(
        "ssh.exe",
        ["-G", "-F", config, "root@203.0.113.55"],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const lines = result.stdout.split(/\r?\n/);
      assert.ok(lines.includes(`userknownhostsfile ${known}`));
      assert.ok(lines.includes("stricthostkeychecking true"));
      assert.ok(lines.includes("globalknownhostsfile none"));
      assert.ok(lines.includes("hostkeyalias 203.0.113.55"));
      assert.ok(lines.includes("hostkeyalgorithms ssh-ed25519"));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
);
