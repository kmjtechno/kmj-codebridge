import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p520 = fs.readFileSync(
  path.join(
    base,
    "scripts/windows/KMJ-P520-TO-ELITE-ORIGINAL-KEY-ONECLICK.ps1",
  ),
  "utf8",
);
const elitePath = path.join(
  base,
  "scripts/production/kmj-elite-provision-owner-policy.py",
);
const elite = fs.readFileSync(elitePath, "utf8");

test("one-click custody pins the reviewed helper byte-for-byte", () => {
  const sourceHash = createHash("sha256")
    .update(fs.readFileSync(elitePath))
    .digest("hex");
  assert.match(p520, new RegExp(sourceHash));
  assert.match(p520, /REMOTE_ENROLLMENT_HELPER_PIN_MISMATCH/);
  assert.match(p520, /raw\.githubusercontent\.com/);
  assert.match(p520, /kmj-elite-provision-owner-policy\.py/);
});

test("P520 rejects unpinned SSH Ed25519 host identity", () => {
  const hostPin = "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI";
  assert.ok(p520.includes(hostPin));
  assert.match(p520, /ELITE_SSH_HOST_PIN_MISMATCH/);
  assert.match(p520, /StrictHostKeyChecking=yes/);
  assert.match(p520, /HostKeyAlgorithms=ssh-ed25519/);
  assert.doesNotMatch(p520, /StrictHostKeyChecking=no/);
  assert.doesNotMatch(p520, /UserKnownHostsFile=\/dev\/null/);
});

test("private key cannot be replaced by a new identity", () => {
  const releasePin =
    "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8";
  assert.ok(elite.includes(releasePin));
  assert.match(elite, /spki_sha256\(priv,True\) == PIN/);
  assert.match(elite, /spki_sha256\(pub,False\) == PIN/);
  assert.match(elite, /os\.O_NOFOLLOW/);
  assert.match(elite, /os\.O_EXCL/);
  assert.match(elite, /SIGNER_ENROLLMENT_ALREADY_PRESENT/);
});

test("policy is time-limited, owner-approved and nonroot", () => {
  assert.match(elite, /dt\.timedelta\(days=29\)/);
  assert.match(elite, /AUTO_SIGN_REVIEWED_MAIN_ONLY/);
  assert.match(elite, /owner-host-auto-sign-stable-only/);
  assert.match(elite, /'maxSequence':40/);
  assert.match(elite, /os\.fchmod\(fd,0o600\)/);
  assert.match(elite, /username=USER/);
});

test("enrollment never invokes signing or publication", () => {
  assert.match(elite, /--inspect/);
  assert.doesNotMatch(elite, /['"]--sign-once['"]/);
  assert.doesNotMatch(elite, /['"]--once['"]/);
  assert.doesNotMatch(p520, /-o\s+StrictHostKeyChecking=no/);
  assert.match(p520, /SIGNING=NOT_STARTED/);
  assert.match(p520, /PRODUCTION_MUTATION=NONE/);
});

test("PowerShell 5.1 ssh-keyscan stderr banner is non-fatal while checks stay strict", () => {
  assert.match(p520, /Start-Process -FilePath \$scanBinary/);
  assert.match(
    p520,
    /-RedirectStandardOutput \$scanOut -RedirectStandardError \$scanErr/,
  );
  assert.match(p520, /\$scanProc\.ExitCode -ne 0/);
  assert.match(p520, /Get-Content -LiteralPath \$scanOut/);
  assert.match(p520, /\$entries\.Count -ne 1/);
  assert.match(p520, /ssh-keygen\.exe -l -f \$kh -E sha256/);
  assert.doesNotMatch(
    p520,
    /ssh-keyscan\.exe -T 8 -t ed25519 \$hostIp 2>\$null/,
  );
});

test("P520 Git keyscan KEX workaround preserves SSH identity checks", () => {
  assert.match(p520, /Join-Path \$gitRoot 'usr\\bin\\ssh-keyscan\.exe'/);
  assert.match(
    p520,
    /Join-Path \$env:ProgramFiles 'Git\\usr\\bin\\ssh-keyscan\.exe'/,
  );
  assert.match(p520, /GIT_FOR_WINDOWS_KEYSCAN_REQUIRED/);
  assert.match(p520, /GIT_KEYSCAN_SYMLINK_REJECTED/);
  assert.match(p520, /Start-Process -FilePath \$scanBinary/);
  assert.match(p520, /\$scanProc\.ExitCode -ne 0/);
  assert.match(p520, /\$entries\.Count -ne 1/);
  assert.match(p520, /ELITE_SSH_HOST_PIN_MISMATCH/);
  assert.doesNotMatch(p520, /StrictHostKeyChecking=no/);
});

test("P520 scratch cleanup is noninteractive", () => {
  assert.match(p520, /kmj-elite-custody-/);
  assert.match(p520, /New-Item -ItemType Directory -Path \$work/);
  assert.match(p520, /Remove-Item -LiteralPath \$work -Recurse -Force/);
});
