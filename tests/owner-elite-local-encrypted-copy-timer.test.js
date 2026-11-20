import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/production/owner_elite_local_encrypted_copy_timer.py";
const script = fs.readFileSync(SCRIPT, "utf8");

function py(body) {
  const src = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("r", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}`;
  const r = spawnSync("python3", ["-I", "-B", "-c", src], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("dry run by default; only --apply accepted", () => {
  const r = py(`
def a(v):
    try:
        return m.parse_args(v)
    except m.Blocked as e:
        return e.args[0]
print(json.dumps({"none": a([]), "apply": a(["--apply"]), "bad": a(["--force"]), "dup": a(["--apply", "--apply"])}))`);
  assert.equal(r.none, false);
  assert.equal(r.apply, true);
  assert.equal(r.bad, "UNKNOWN_ARGUMENT");
  assert.equal(r.dup, "UNKNOWN_ARGUMENT");
});

test("installed script is local-only: no network, no ssh/rsync, no key use, no deletes beyond its own partial", () => {
  const s = py(`print(json.dumps(m.SCRIPT))`);
  assert.match(s, /age -R "\$rcp"/);
  assert.match(s, /OFFSITE_REAL=NO_SAME_VPS_ONLY/);
  assert.match(s, /test "\$\(hostname\)" = KMJ-elite/);
  assert.doesNotMatch(
    s,
    /rsync|\bssh\b|\bscp\b|sftp|curl|wget|34\.63\.5\.14|offsite-push|known_hosts|age -d|--decrypt|pg_restore|psql|systemctl|rm -rf/,
  );
  // The only rm is for its own *.partial temp file.
  const rms = s.match(/\brm\b[^\n]*/g) || [];
  assert.deepEqual(rms, ['rm -f -- "$tmp"']);
});

test("units are hardened, daily, and do not alter existing units", () => {
  const u = py(`print(json.dumps([m.SERVICE_UNIT, m.TIMER_UNIT]))`);
  assert.match(u[0], /NoNewPrivileges=yes/);
  assert.match(u[0], /ProtectSystem=strict/);
  assert.match(
    u[0],
    /ReadWritePaths=\/var\/backups\/kmj-elite-offsite-encrypted \/run\/lock/,
  );
  assert.match(u[1], /Persistent=true/);
  assert.match(u[1], /OnCalendar=\*-\*-\* 04:30:00 UTC/);
  assert.doesNotMatch(
    script,
    /kmj-elite-offsite-backup|kmj-elite-daily-backup\.(service|timer)\W*(stop|disable|mask)/,
  );
});

test("pinned host, root check, no-overwrite, one fixed systemctl only", () => {
  assert.match(script, /\.lower\(\) == "kmj-elite"/);
  assert.match(script, /NOT_ROOT/);
  assert.match(script, /EXISTING_FILE_DIFFERS/);
  assert.match(script, /O_NOFOLLOW/);
  assert.deepEqual(
    [...script.matchAll(/systemctl\("([a-z-]+)"/g)].map((x) => x[1]),
    ["daemon-reload", "enable"],
  );
  assert.doesNotMatch(script, /shell=True|os\.system|urllib|socket\.create/);
});

test("without root it blocks before changing anything", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const r = spawnSync("python3", ["-I", "-B", SCRIPT, "--apply"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED_NOT_ROOT/);
  assert.match(r.stdout, /NOTHING_CHANGED/);
});
