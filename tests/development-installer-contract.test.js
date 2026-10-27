import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

const installer = fs.readFileSync(
  new URL(
    "../scripts/production/install-development-nonroot-probe.py",
    import.meta.url,
  ),
  "utf8",
);
const helper = fs.readFileSync(
  new URL("../scripts/production/kmj-codebridge-dev-probe.py", import.meta.url),
);
const unit = fs.readFileSync(
  new URL(
    "../scripts/production/kmj-codebridge-development-ci.service",
    import.meta.url,
  ),
);

test("operator installer is pinned to the exact merged fixed-root probe assets", () => {
  for (const data of [helper, unit]) {
    const sha = createHash("sha256").update(data).digest("hex");
    assert.ok(installer.includes(sha), `Missing exact SHA256 pin ${sha}`);
  }
  assert.match(installer, /os\.geteuid\(\) != 0/);
  assert.match(installer, /EXPECTED_HOST = "kmj-elite"/);
  assert.match(installer, /--install-and-test/);
  assert.match(installer, /O_EXCL/);
  assert.match(installer, /O_NOFOLLOW/);
  assert.match(installer, /"productionChanged": False/);
  assert.match(installer, /"autonomousCodingLive": False/);
  assert.match(installer, /os\.setuid\(identity\.pw_uid\)/);
});

test("restricted dev service has neither root user nor persistent start-on-boot", () => {
  const txt = unit.toString();
  assert.match(txt, /^User=kmjdevci$/m);
  assert.match(txt, /^Group=kmjdevci$/m);
  assert.match(txt, /^ProtectSystem=strict$/m);
  assert.match(txt, /^PrivateNetwork=yes$/m);
  assert.match(txt, /^NoNewPrivileges=yes$/m);
  assert.doesNotMatch(txt, /^WantedBy=/m);
  assert.doesNotMatch(installer, /systemctl["', ]+enable/);
  assert.doesNotMatch(installer, /systemctl["', ]+restart/);
  assert.doesNotMatch(installer, /curl\s*\|\s*(?:sudo\s+)?bash/);
});
