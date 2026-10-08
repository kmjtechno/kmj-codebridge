import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const script = fs.readFileSync("scripts/auto-update-development.sh", "utf8");
test("fixed CI ref refresh verifies fetched heads before atomic tracking-ref updates", (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixed ref refresh");
  const match = script.match(
    /refresh_fixed_private_ci_refs\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY\n\}/,
  );
  assert.ok(match, "fixed guarded refresh helper exists");
  const prelude = `
import os, stat, subprocess, pwd, grp, fcntl, json
from types import SimpleNamespace
class Meta:
    st_uid=0; st_gid=0; st_nlink=1; st_size=64
    st_mode=stat.S_IFDIR | 0o755
fixture_stat=lambda p: SimpleNamespace(st_uid=(1001 if os.environ.get('SERVICE_OWNER') and '/kmj-main-platform' in p else 0), st_gid=(1001 if os.environ.get('SERVICE_OWNER') and '/kmj-main-platform' in p else 0), st_dev=1, st_ino=1, st_mtime_ns=1, st_ctime_ns=1, st_nlink=1, st_size=64, st_mode=(stat.S_IFREG|0o666 if os.environ.get('UNSAFE_CONFIG') and p.endswith('/config') else stat.S_IFREG|0o600 if p.endswith('/config') or p.endswith('/.ci.lock') else stat.S_IFDIR|0o755))
project_mode = None
git_modes = {}
project_reads = 0
locked = False
def fixture_lstat(p):
    global project_reads
    if p == '/srv/kmj-codebridge-projects/kmj-main-platform':
        error=os.environ.get('PROJECT_ERROR')
        if error=='missing': raise FileNotFoundError(2, 'private error')
        if error=='denied': raise PermissionError(13, 'private error')
        if error=='other': raise OSError(5, 'private error')
        result=fixture_stat(p)
        kind=os.environ.get('PROJECT_TYPE')
        if kind: result.st_mode=(stat.S_IFLNK if kind=='link' else stat.S_IFREG)|0o755
        result.st_mode |= int(os.environ.get('PROJECT_WRITE', '0'), 8) | int(os.environ.get('PROJECT_SPECIAL','0'),8)
        if project_mode is not None: result.st_mode = project_mode
        project_reads += 1
        if os.environ.get('PROJECT_RACE') and project_reads > 1: result.st_ino=2
        return result
    result=fixture_stat(p)
    if p.endswith('/.git') or p.endswith('/.git/config'):
        label='GIT' if p.endswith('/.git') else 'CONFIG'
        if os.environ.get(label+'_MISSING'): raise FileNotFoundError(2, 'private error')
        if os.environ.get(label+'_ROOT'): result.st_uid=0; result.st_gid=0
        if os.environ.get(label+'_GID'): result.st_gid=1002
        if os.environ.get(label+'_LINK'): result.st_mode=stat.S_IFLNK|0o755
        if os.environ.get(label+'_NLINK'): result.st_nlink=2
        if os.environ.get(label+'_SIZE'): result.st_size=65537
        result.st_mode |= int(os.environ.get(label+'_WRITE','0'),8)
        if label in git_modes: result.st_mode=git_modes[label]
        if os.environ.get(label+'_UID_RACE') and project_reads>1: result.st_uid=1002
    return result
os.lstat=fixture_lstat
os.open=lambda p, *a, **k: 10 if p == '/srv/kmj-codebridge-projects/kmj-main-platform' else 11 if p.endswith('/.git') else 12 if p=='config' else 9
os.close=lambda *a: None
os.stat=lambda p, **kw: fixture_lstat('/srv/kmj-codebridge-projects/kmj-main-platform/.git/'+p)
os.fstat=lambda fd: fixture_lstat('/srv/kmj-codebridge-projects/kmj-main-platform') if fd==10 else fixture_lstat('/srv/kmj-codebridge-projects/kmj-main-platform/.git') if fd==11 else fixture_lstat('/srv/kmj-codebridge-projects/kmj-main-platform/.git/config') if fd==12 else SimpleNamespace(st_uid=0, st_gid=0, st_nlink=1, st_mode=stat.S_IFREG|0o600)
def chmod(fd, mode):
    global project_mode
    assert fd in [10,11,12] and locked
    before=os.fstat(fd)
    assert mode==stat.S_IMODE(before.st_mode)&~0o020
    if fd==10: project_mode=stat.S_IFDIR|mode
    else: git_modes['GIT' if fd==11 else 'CONFIG']=stat.S_IFDIR|mode if fd==11 else stat.S_IFREG|mode
    print('CHMOD='+str(fd))
os.fchmod=chmod
pwd.getpwuid=lambda uid: SimpleNamespace(pw_name='untrusted' if os.environ.get('UNTRUSTED_OWNER') else 'kmjrunner' if uid else 'root', pw_uid=uid, pw_gid=uid, pw_dir='/home/kmjrunner' if uid else '/root')
def lock(*a):
    global locked
    if os.environ.get('BUSY'): raise BlockingIOError()
    locked=True
fcntl.flock=lock
grp.getgrgid=lambda gid: SimpleNamespace(gr_mem=['different'] if os.environ.get('GROUP_OTHER') else [])
pwd.getpwall=lambda: [SimpleNamespace(pw_uid=(1001 if os.environ.get('SERVICE_OWNER') else 0), pw_gid=(1001 if os.environ.get('SERVICE_OWNER') else 0)), *([SimpleNamespace(pw_uid=1002, pw_gid=(1001 if os.environ.get('SERVICE_OWNER') else 0))] if os.environ.get('PRIMARY_OTHER') else [])]
pwd.getpwnam=lambda name: SimpleNamespace(pw_uid=0 if name=='root' else 1001 if name=='kmjrunner' else 1002)
refs={}
old='e'*40
owner_sha='8ebbb6f1999309875b6f6b0c6d25c21847fff3ff'
website='70a5efb9a43103cd17be15d056e166cb19813efe'
def stub(args, **kw):
    if args[0]=='/usr/bin/systemctl':
        assert args==['/usr/bin/systemctl','show','kmj-codebridge-kmj-main-platform.service','--property=LoadState','--property=User','--no-pager']
        return SimpleNamespace(returncode=0,stdout='LoadState='+os.environ.get('WRITE_LOAD','loaded')+'\\nUser='+os.environ.get('WRITE_USER','root')+'\\n')
    assert kw['user']==(1001 if os.environ.get('SERVICE_OWNER') else 0) and kw['group']==kw['user'] and kw['extra_groups']==[]
    assert kw['env']['GIT_CONFIG_GLOBAL']=='/dev/null'
    assert kw['stderr']==subprocess.DEVNULL
    assert 'core.hooksPath=/dev/null' in args and 'maintenance.auto=false' in args and 'gc.auto=0' in args
    a=args[args.index('-C')+2:]
    result=''; rc=0
    if a[:3]==['remote','get-url','origin']: result=os.environ.get('ORIGIN','git@github.com:kmjtechno/kmj-main-platform.git'); rc=int(os.environ.get('ORIGIN_EXIT','0'))
    elif a[0]=='rev-parse':
        ref=a[-1]
        result=refs.get(ref, old)
    elif a[0]=='show-ref': rc=0 if os.environ.get('TEMP_EXISTS') else 1
    elif a[0]=='fetch':
        if os.environ.get('PROJECT_WRITE')=='020': assert project_mode is not None and not project_mode & 0o022
        assert '--no-tags' in a and '--no-recurse-submodules' in a and '--no-write-fetch-head' in a
        assert a[-2]=='origin' and '+' not in a[-1]
        src,dst=a[-1].split(':'); refs[dst]=os.environ.get('FETCHED',owner_sha if 'owner-tier' in src else website); rc=int(os.environ.get('FETCH_FAIL','0'))
    elif a[0]=='merge-base': rc=int(os.environ.get('NON_FF','0'))
    elif a[0]=='update-ref':
        if a[1]=='-d':
            assert refs.get(a[2])==a[3]
            refs.pop(a[2],None); print('DELETED='+a[2])
        else:
            assert a[3]==old
            rc=int(os.environ.get('CAS_FAIL','0'))
            if not rc: print('UPDATED='+a[1]+'='+a[2])
    else: raise AssertionError(a)
    return SimpleNamespace(returncode=rc,stdout=result+'\\n')
subprocess.run=stub
`;
  const run = (env = {}) =>
    spawnSync("python3", ["-c", prelude + match[1]], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ...env },
    });
  for (const env of [
    { FETCHED: "a".repeat(40) },
    { ORIGIN: "https://secret@evil.invalid/repo" },
    { BUSY: "1" },
    { NON_FF: "1" },
    { CAS_FAIL: "1" },
    { UNSAFE_CONFIG: "1" },
    { UNTRUSTED_OWNER: "1" },
  ]) {
    const result = run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /UPDATED=|secret|evil/);
  }
  for (const [env, step] of [
    [{ UNSAFE_CONFIG: "1" }, "GIT_CONFIG"],
    [{ UNTRUSTED_OWNER: "1" }, "PROJECT_ACCOUNT"],
    [{ ORIGIN_EXIT: "128" }, "ORIGIN_READ"],
    [{ ORIGIN: "https://secret@evil.invalid/repo" }, "ORIGIN_ALLOWLIST"],
  ]) {
    const result = run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes(
        `AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_UNTRUSTED_STEP=${step}`,
      ),
    );
    assert.doesNotMatch(result.stdout, /UPDATED=|secret|evil/);
  }
  for (const [env, step] of [
    [{ PROJECT_ERROR: "missing" }, "PROJECT_LSTAT_MISSING"],
    [{ PROJECT_ERROR: "denied" }, "PROJECT_LSTAT_PERMISSION_DENIED"],
    [{ PROJECT_ERROR: "other" }, "PROJECT_LSTAT_OTHER_ERROR"],
    [{ PROJECT_TYPE: "link" }, "PROJECT_DIRECTORY_SYMLINK"],
    [{ PROJECT_TYPE: "file" }, "PROJECT_DIRECTORY_OTHER_TYPE"],
    [{ PROJECT_WRITE: "002" }, "PROJECT_MODE_WORLD_WRITE"],
    [{ PROJECT_WRITE: "022" }, "PROJECT_MODE_GROUP_AND_WORLD_WRITE"],
  ]) {
    const result = run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes(
        `AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_UNTRUSTED_STEP=${step}`,
      ),
    );
    assert.doesNotMatch(result.stdout, /UPDATED=|private error/);
  }
  for (const env of [
    { PROJECT_WRITE: "020", UNSAFE_CONFIG: "1" },
    { PROJECT_WRITE: "020", UNTRUSTED_OWNER: "1" },
    { PROJECT_WRITE: "022" },
    { PROJECT_WRITE: "020", BUSY: "1" },
    { PROJECT_WRITE: "020", PROJECT_RACE: "1" },
  ]) {
    const result = run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CHMOD=|UPDATED=/);
  }
  const hardened = run({
    PROJECT_WRITE: "020",
    SERVICE_OWNER: "1",
    WRITE_USER: "kmjrunner",
    PROJECT_SPECIAL: "2000",
  });
  assert.equal(hardened.status, 0, hardened.stderr);
  assert.match(hardened.stdout, /CHMOD=10/);
  assert.match(hardened.stdout, /AUTO_UPDATE_PRIVATE_CI_PROJECT_HARDENED=1/);
  assert.match(hardened.stdout, /PR322_REF_REFRESHED=1/);
  for (const [env, markers] of [
    [
      { SERVICE_OWNER: "1", GIT_ROOT: "1", CONFIG_ROOT: "1" },
      [
        "GIT_DIRECTORY_OWNER=ROOT",
        "GIT_CONFIG_OWNER=ROOT",
        "GIT_CONFIG_GID=MATCHES_PRIMARY",
      ],
    ],
    [{ CONFIG_GID: "1" }, ["GIT_CONFIG_GID=DIFFERS"]],
    [{ CONFIG_LINK: "1" }, ["GIT_CONFIG_TYPE=SYMLINK"]],
    [
      { GIT_LINK: "1" },
      ["GIT_DIRECTORY_TYPE=SYMLINK", "GIT_CONFIG_READ=BLOCKED_DIRECTORY"],
    ],
    [{ CONFIG_MISSING: "1" }, ["GIT_CONFIG_READ=MISSING"]],
    [
      { CONFIG_NLINK: "1", CONFIG_SIZE: "1" },
      ["GIT_CONFIG_NLINK=INVALID", "GIT_CONFIG_SIZE=INVALID"],
    ],
  ]) {
    const result = run(env);
    assert.equal(result.status, 0, result.stderr);
    for (const marker of markers)
      assert.ok(result.stdout.includes("AUTO_UPDATE_PRIVATE_CI_" + marker));
    assert.doesNotMatch(result.stdout, /UPDATED=|CHMOD=|private error/);
  }
  const three = {
    SERVICE_OWNER: "1",
    WRITE_USER: "kmjrunner",
    PROJECT_WRITE: "020",
    GIT_WRITE: "020",
    CONFIG_WRITE: "020",
  };
  for (const extra of [
    { GROUP_OTHER: "1" },
    { PRIMARY_OTHER: "1" },
    { GIT_WRITE: "022" },
    { CONFIG_WRITE: "002" },
    { CONFIG_UID_RACE: "1" },
    { WRITE_USER: "different" },
  ]) {
    const result = run({ ...three, ...extra });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CHMOD=|UPDATED=/);
  }
  const closed = run(three);
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(closed.stdout.match(/CHMOD=\d+/g), [
    "CHMOD=10",
    "CHMOD=11",
    "CHMOD=12",
  ]);
  assert.match(closed.stdout, /AUTO_UPDATE_PRIVATE_CI_GIT_METADATA_HARDENED=1/);
  assert.match(closed.stdout, /PR337_REF_REFRESHED=1/);
  const failedFetch = run({ FETCH_FAIL: "1" });
  assert.equal(failedFetch.status, 0, failedFetch.stderr);
  assert.match(
    failedFetch.stdout,
    /DELETED=refs\/codebridge-private-ci-refresh\/pr322/,
  );
  assert.doesNotMatch(failedFetch.stdout, /UPDATED=/);
  const existingTemp = run({ TEMP_EXISTS: "1" });
  assert.equal(existingTemp.status, 0, existingTemp.stderr);
  assert.doesNotMatch(existingTemp.stdout, /UPDATED=|DELETED=/);
  const dropped = run({ SERVICE_OWNER: "1" });
  assert.equal(dropped.status, 0, dropped.stderr);
  assert.match(dropped.stdout, /PR322_REF_REFRESHED=1/);
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.match(
    success.stdout,
    /UPDATED=refs\/remotes\/origin\/feat\/codebridge-owner-tier=8ebbb6/,
  );
  assert.match(
    success.stdout,
    /UPDATED=refs\/remotes\/origin\/fix\/public-marketing-standalone-nav-20261008=70a5ef/,
  );
});
