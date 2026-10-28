import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Exercise the actual Bash rollback function in isolation with inert mocks.
// This is not a staging deployment or an owner approval. No root, systemd,
// network, Nginx config, production pointer, or local file writes.
const source = readFileSync(
  new URL(
    "../examples/main-platform-staging/d32/guarded-stage.sh",
    import.meta.url,
  ),
  "utf8",
);
const match = source.match(/(cleanup\(\)\{\n[\s\S]*?\n\})\ntrap cleanup EXIT/);

test(
  "real staging rollback keeps concurrent pointers and config untouched",
  { skip: process.platform === "win32" },
  () => {
    assert.ok(match, "reviewed cleanup implementation must be extractable");
    const cases = [
      {
        name: "no cutover happened",
        applied: "0",
        pointer: "/old",
        hash: "original",
        marker: "",
        writes: false,
      },
      {
        name: "original release and config already intact",
        applied: "1",
        pointer: "/old",
        hash: "original",
        marker: "STAGING_UI_ROLLBACK=NOT_NEEDED_ORIGINAL_INTACT",
        writes: false,
      },
      {
        name: "another deploy owns staging pointer",
        applied: "1",
        pointer: "/other-release",
        hash: "candidate",
        marker:
          "STAGING_UI_ROLLBACK=BLOCKED_CONCURRENT_POINTER_REQUIRES_OPERATOR",
        writes: false,
      },
      {
        name: "another deploy changed Nginx config",
        applied: "1",
        pointer: "/new",
        hash: "third-party",
        marker:
          "STAGING_UI_ROLLBACK=BLOCKED_CONCURRENT_CONFIG_REQUIRES_OPERATOR",
        writes: false,
      },
      {
        name: "candidate cutover needs rollback",
        applied: "1",
        pointer: "/new",
        hash: "candidate",
        marker: "STAGING_UI_ROLLBACK=PASS",
        writes: true,
      },
      {
        name: "config changed but symlink still original",
        applied: "1",
        pointer: "/old",
        hash: "candidate",
        marker: "STAGING_UI_ROLLBACK=PASS",
        writes: true,
      },
    ];
    for (const scenario of cases) {
      // Mock every command capable of modifying system state; any unexpected
      // command fails. Bash sees only synthetic scalar paths and hash output.
      const harness = [
        "set -u",
        "work=/inert",
        "link=/inert-link",
        "target=/inert-nginx-config",
        "oldapp=/old",
        "app=/new",
        "config_hash=original",
        "candidate_hash=candidate",
        "applied=" + scenario.applied,
        "CURRENT_POINTER=" + JSON.stringify(scenario.pointer),
        "CURRENT_HASH=" + JSON.stringify(scenario.hash),
        "readlink(){ printf '%s\\n' \"$CURRENT_POINTER\"; }",
        'sha256sum(){ printf \'%s  %s\\n\' "$CURRENT_HASH" "$1"; }',
        "install(){ printf 'MUTATION_INSTALL\\n'; }",
        "ln(){ printf 'MUTATION_LINK\\n'; }",
        "mv(){ printf 'MUTATION_MOVE\\n'; }",
        "nginx(){ printf 'MUTATION_NGINX\\n'; }",
        "systemctl(){ printf 'MUTATION_SYSTEMCTL\\n'; }",
        match[1],
        "cleanup",
      ].join("\n");
      const result = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      });
      assert.equal(result.status, 0, scenario.name + ": " + result.stderr);
      if (scenario.marker)
        assert.ok(result.stdout.includes(scenario.marker), scenario.name);
      const mutated = result.stdout.includes("MUTATION_");
      assert.equal(
        mutated,
        scenario.writes,
        scenario.name + ": " + result.stdout,
      );
      if (scenario.writes)
        assert.ok(result.stdout.includes("MUTATION_MOVE"), scenario.name);
    }
  },
);
