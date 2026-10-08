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
parent_reads = 0
def fixture_lstat(p):
    global project_reads, parent_reads
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
    if p.endswith('/packed-refs') or p.endswith('/public-marketing-standalone-nav-20261008'): result.st_mode=stat.S_IFREG|0o600
    if p in ref_owners: result.st_uid=result.st_gid=ref_owners[p]
    if os.environ.get('REF_PRIVATE') and (p.endswith('/refs/remotes/origin/fix') or p.endswith('/public-marketing-standalone-nav-20261008')):
        if p not in ref_owners: result.st_uid=0; result.st_gid=0
        if p.endswith('/refs/remotes/origin/fix'): result.st_mode=stat.S_IFDIR|0o700
    if p.endswith('/refs/remotes/origin/fix') and os.environ.get('REF_LINK'): result.st_mode=stat.S_IFLNK|0o755
    if p=='/srv/kmj-codebridge-projects':
        parent_reads += 1
        if os.environ.get('SERVICE_PARENT'): result.st_uid=1001; result.st_gid=1001
        if os.environ.get('PARENT_OTHER'): result.st_uid=1002; result.st_gid=1002
        if os.environ.get('PARENT_WRITE'): result.st_mode |= 0o020
        if os.environ.get('PARENT_WORLD'): result.st_mode |= 0o002
        if os.environ.get('PARENT_LINK'): result.st_mode=stat.S_IFLNK|0o755
        if os.environ.get('PARENT_RACE') and parent_reads>2: result.st_ino=2
    if p=='/srv' and os.environ.get('UPPER_OTHER'): result.st_uid=1001
    if os.environ.get('PROOF_COMBINED'):
        if p=='/srv/kmj-codebridge-projects': result.st_uid=1001; result.st_gid=1001
        if p=='/srv': result.st_mode |= 0o020
        if p=='/': result.st_mode=stat.S_IFLNK|0o755
        if p=='/var/lib/kmj-codebridge-ci': raise FileNotFoundError(2,'private ancestor error')
    if os.environ.get('PROOF_LOCK_INVALID') and p.endswith('/.ci.lock'): result.st_nlink=2
    if os.environ.get('PROOF_LOCK_PUBLIC') and p.endswith('/.ci.lock'): result.st_mode |= 0o004
    if os.environ.get('PROOF_LOCK_FIFO') and p.endswith('/.ci.lock'): result.st_mode=stat.S_IFIFO|0o600
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
os.open=lambda p, *a, **k: 10 if p == '/srv/kmj-codebridge-projects/kmj-main-platform' else 11 if p.endswith('/.git') else 12 if p=='config' else 13 if p=='/var/lib/kmj-codebridge-ci' else 14 if p=='/srv/kmj-codebridge-projects' else 15 if p=='/srv' else 16 if p=='/' else {'refs':20,'remotes':21,'origin':22,'fix':23,'objects':24,'public-marketing-standalone-nav-20261008':25}.get(p,9)
os.close=lambda *a: None
ref_paths={20:'/srv/kmj-codebridge-projects/kmj-main-platform/.git/refs',21:'/srv/kmj-codebridge-projects/kmj-main-platform/.git/refs/remotes',22:'/srv/kmj-codebridge-projects/kmj-main-platform/.git/refs/remotes/origin',23:'/srv/kmj-codebridge-projects/kmj-main-platform/.git/refs/remotes/origin/fix',24:'/srv/kmj-codebridge-projects/kmj-main-platform/.git/objects',25:'/srv/kmj-codebridge-projects/kmj-main-platform/.git/refs/remotes/origin/fix/public-marketing-standalone-nav-20261008'}
ref_owners={}
os.stat=lambda p, **kw: fixture_lstat(ref_paths.get(kw.get('dir_fd'),'/srv/kmj-codebridge-projects/kmj-main-platform/.git')+'/'+p)
os.fstat=lambda fd: fixture_lstat(ref_paths[fd]) if fd in ref_paths else fixture_lstat('/srv/kmj-codebridge-projects/kmj-main-platform') if fd==10 else fixture_lstat('/srv/kmj-codebridge-projects/kmj-main-platform/.git') if fd==11 else fixture_lstat('/srv/kmj-codebridge-projects/kmj-main-platform/.git/config') if fd==12 else fixture_lstat('/var/lib/kmj-codebridge-ci') if fd==13 else fixture_lstat('/srv/kmj-codebridge-projects') if fd==14 else fixture_lstat('/srv') if fd==15 else fixture_lstat('/') if fd==16 else fixture_lstat('/var/lib/kmj-codebridge-ci/.ci.lock')
def chmod(fd, mode):
    global project_mode
    assert fd in [10,11,12] and locked
    before=os.fstat(fd)
    assert mode==stat.S_IMODE(before.st_mode)&~0o020
    if fd==10: project_mode=stat.S_IFDIR|mode
    else: git_modes['GIT' if fd==11 else 'CONFIG']=stat.S_IFDIR|mode if fd==11 else stat.S_IFREG|mode
    print('CHMOD='+str(fd))
os.fchmod=chmod
def chown(fd, uid, gid):
    assert fd in [23,25] and locked
    assert uid==gid==1001
    before=os.fstat(fd)
    assert before.st_uid==before.st_gid==0
    ref_owners[ref_paths[fd]]=uid
    print('CHOWN='+str(fd))
os.fchown=chown
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
owner_sha='d1b6f237fe85ae8516cfb3ce6d183ad3aeeb6764'
website='25950caa017fcb70d87564f3a817d6280a841cae'
def stub(args, **kw):
    if args[0]=='/usr/bin/python3':
        assert args[:3]==['/usr/bin/python3','-I','-c']
        assert kw['user']==(1001 if os.environ.get('SERVICE_OWNER') else 0) and kw['group']==kw['user'] and kw['extra_groups']==[]
        assert kw['env']['GIT_CONFIG_GLOBAL']=='/dev/null' and kw['stderr']==subprocess.DEVNULL
        result='REF_FIX_PARENT_ACCESS=DENIED\\nREF_FIX_PARENT_WRITE_ACCESS=DENIED\\nREF_WEBSITE_ACCESS=PERMISSION_DENIED\\n'
        return SimpleNamespace(returncode=0,stdout=result)
    if args[0]=='/usr/bin/systemctl':
        assert args==['/usr/bin/systemctl','show','kmj-codebridge-kmj-main-platform.service','--property=LoadState','--property=User','--no-pager']
        return SimpleNamespace(returncode=0,stdout='LoadState='+os.environ.get('WRITE_LOAD','loaded')+'\\nUser='+os.environ.get('WRITE_USER','root')+'\\n')
    assert kw['user']==(1001 if os.environ.get('SERVICE_OWNER') else 0) and kw['group']==kw['user'] and kw['extra_groups']==[]
    assert kw['env']['GIT_CONFIG_GLOBAL']=='/dev/null'
    assert kw['stderr'] in [subprocess.DEVNULL,subprocess.PIPE]
    assert 'core.hooksPath=/dev/null' in args and 'maintenance.auto=false' in args and 'gc.auto=0' in args
    a=args[args.index('-C')+2:]
    result=''; rc=0
    if a[:3]==['remote','get-url','origin']: result=os.environ.get('ORIGIN','git@github.com:kmjtechno/kmj-main-platform.git'); rc=int(os.environ.get('ORIGIN_EXIT','0'))
    elif a[0]=='rev-parse':
        ref=a[-1]
        result=refs.get(ref, old)
        if ref.startswith('refs/remotes/') and os.environ.get('TRACKING_FAIL'): rc=128
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
            rc=int(os.environ.get('CLEANUP_FAIL','0'))
            if not rc: refs.pop(a[2],None); print('DELETED='+a[2])
        else:
            assert a[3]==old
            rc=int(os.environ.get('CAS_FAIL','0'))
            if not rc: print('UPDATED='+a[1]+'='+a[2])
    else: raise AssertionError(a)
    return SimpleNamespace(returncode=rc,stdout=result+'\\n',stderr=os.environ.get('GIT_STDERR',''))
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
  const batch = run({
    SERVICE_OWNER: "1",
    PROOF_COMBINED: "1",
    GROUP_OTHER: "1",
    WRITE_USER: "different",
  });
  assert.equal(batch.status, 0, batch.stderr);
  for (const marker of [
    "TRUST_PROJECT_PARENT_OWNER=MATCHES_PROJECT",
    "TRUST_SRV_MODE=GROUP_WRITE",
    "TRUST_ROOT_TYPE=SYMLINK",
    "TRUST_BASE_READ=MISSING",
    "TRUST_LOCK_READ=BLOCKED_BASE",
    "TRUST_GROUP=OTHER_MEMBERS",
    "TRUST_WRITER_LOAD=LOADED",
    "TRUST_WRITER_UID=DIFFERS",
  ])
    assert.ok(
      batch.stdout.includes("AUTO_UPDATE_PRIVATE_CI_" + marker),
      marker,
    );
  assert.doesNotMatch(batch.stdout, /CHMOD=|UPDATED=|private ancestor error/);
  assert.match(
    fs.readFileSync("scripts/one-click-main-platform.sh", "utf8"),
    /install -d -m 0755 -o "\$SERVICE_USER" -g "\$SERVICE_USER" "\$\(dirname "\$TARGET"\)"/,
  );
  const invalidLock = run({ PROOF_LOCK_INVALID: "1" });
  assert.match(invalidLock.stdout, /TRUST_LOCK_NLINK=INVALID/);
  assert.doesNotMatch(invalidLock.stdout, /UPDATED=|CHMOD=/);
  const publicLock = run({ PROOF_LOCK_PUBLIC: "1" });
  assert.match(publicLock.stdout, /TRUST_LOCK_PRIVATE_MODE=INVALID/);
  assert.doesNotMatch(publicLock.stdout, /UPDATED=|CHMOD=/);
  const fifoLock = run({ PROOF_LOCK_FIFO: "1" });
  assert.match(fifoLock.stdout, /TRUST_LOCK_TYPE=OTHER/);
  assert.doesNotMatch(fifoLock.stdout, /UPDATED=|CHMOD=/);
  const serviceParent = run({
    SERVICE_OWNER: "1",
    SERVICE_PARENT: "1",
    PROJECT_WRITE: "020",
    GIT_WRITE: "020",
    CONFIG_WRITE: "020",
    WRITE_USER: "kmjrunner",
  });
  assert.match(serviceParent.stdout, /PR337_REF_REFRESHED=1/);
  assert.deepEqual(serviceParent.stdout.match(/CHMOD=\d+/g), [
    "CHMOD=10",
    "CHMOD=11",
    "CHMOD=12",
  ]);
  for (const extra of [
    { PARENT_OTHER: "1" },
    { PARENT_WRITE: "1" },
    { PARENT_WORLD: "1" },
    { PARENT_LINK: "1" },
    { PARENT_RACE: "1" },
    { UPPER_OTHER: "1" },
  ]) {
    const refused = run({
      SERVICE_OWNER: "1",
      SERVICE_PARENT: "1",
      PROJECT_WRITE: "020",
      WRITE_USER: "kmjrunner",
      ...extra,
    });
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stdout, /REF_REFRESH_DEFERRED_UNTRUSTED/);
    assert.doesNotMatch(refused.stdout, /CHMOD=|UPDATED=/);
  }
  const rootSourceForeignParent = run({
    SERVICE_PARENT: "1",
    PROJECT_WRITE: "020",
  });
  assert.equal(
    rootSourceForeignParent.status,
    0,
    rootSourceForeignParent.stderr,
  );
  assert.match(
    rootSourceForeignParent.stdout,
    /REF_REFRESH_DEFERRED_UNTRUSTED/,
  );
  assert.doesNotMatch(rootSourceForeignParent.stdout, /CHMOD=|UPDATED=/);
  for (const [message, kind] of [
    ["Permissions 0644 for '/private/key' are too open.", "KEY_PERMISSIONS"],
    ["Permission denied (publickey).", "PUBLICKEY_DENIED"],
    ["Could not resolve hostname private-host", "DNS_FAILED"],
    ["Host key verification failed.", "HOSTKEY_VERIFICATION_FAILED"],
    [
      "fatal: cannot lock ref private/ref: Permission denied",
      "GIT_PERMISSION_DENIED",
    ],
  ]) {
    const failure = run({ FETCH_FAIL: "128", GIT_STDERR: message });
    assert.match(failure.stdout, /REF_FAILURE_STAGE=FETCH/);
    assert.match(failure.stdout, /REF_FAILURE_EXIT=EXIT_128/);
    assert.ok(failure.stdout.includes("REF_FAILURE_KIND=" + kind));
    assert.doesNotMatch(
      failure.stdout,
      /\/private\/key|private-host|private\/ref|0644/,
    );
  }
  for (const [env, stage] of [
    [{ TEMP_EXISTS: "1" }, "TEMPORARY_REF_EXISTS"],
    [{ FETCHED: "a".repeat(40) }, "EXPECTED_SHA"],
    [{ NON_FF: "1" }, "ANCESTRY"],
    [{ CAS_FAIL: "1" }, "TRACKING_REF_CAS"],
    [{ CLEANUP_FAIL: "128" }, "CLEANUP_REF_CAS"],
  ]) {
    const failure = run(env);
    assert.equal(failure.status, 0, failure.stderr);
    assert.ok(failure.stdout.includes("REF_FAILURE_STAGE=" + stage), stage);
  }
  const repairedRefOwner = run({
    SERVICE_OWNER: "1",
    WRITE_USER: "kmjrunner",
    REF_PRIVATE: "1",
  });
  assert.equal(repairedRefOwner.status, 0, repairedRefOwner.stderr);
  assert.deepEqual(repairedRefOwner.stdout.match(/CHOWN=\d+/g), [
    "CHOWN=25",
    "CHOWN=23",
  ]);
  assert.match(
    repairedRefOwner.stdout,
    /AUTO_UPDATE_PRIVATE_CI_REF_OWNER_REPAIRED=1/,
  );
  assert.match(repairedRefOwner.stdout, /PR337_REF_REFRESHED=1/);
  assert.doesNotMatch(repairedRefOwner.stdout, /CHMOD=/);
  const unreadableRef = run({
    SERVICE_OWNER: "1",
    TRACKING_FAIL: "1",
    REF_PRIVATE: "1",
    GIT_STDERR: "fatal: Needed a single revision",
  });
  assert.equal(unreadableRef.status, 0, unreadableRef.stderr);
  for (const marker of [
    "REF_FAILURE_STAGE=TRACKING_REF_READ",
    "REF_FAILURE_KIND=REVISION_UNAVAILABLE",
    "REF_FIX_PARENT_READ=OK",
    "REF_FIX_PARENT_OWNER=ROOT",
    "REF_FIX_PARENT_ACCESS=DENIED",
    "REF_FIX_PARENT_WRITE_ACCESS=DENIED",
  ])
    assert.ok(unreadableRef.stdout.includes(marker), marker);
  assert.doesNotMatch(unreadableRef.stdout, /UPDATED=|CHMOD=|Needed a single/);
  const linkedRef = run({
    SERVICE_OWNER: "1",
    TRACKING_FAIL: "1",
    REF_LINK: "1",
  });
  assert.equal(linkedRef.status, 0, linkedRef.stderr);
  assert.match(linkedRef.stdout, /REF_FIX_PARENT_TYPE=SYMLINK/);
  assert.match(linkedRef.stdout, /REF_WEBSITE_READ=BLOCKED_DIRECTORY/);
  assert.match(linkedRef.stdout, /REF_PACKED_READ=OK/);
  assert.match(linkedRef.stdout, /OBJECT_ROOT_READ=OK/);
  assert.match(linkedRef.stdout, /OBJECT_PACK_READ=OK/);
  assert.match(linkedRef.stdout, /OBJECT_INFO_READ=OK/);
  assert.doesNotMatch(linkedRef.stdout, /REF_WEBSITE_READ=OK|UPDATED=|CHMOD=/);
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
    /UPDATED=refs\/remotes\/origin\/feat\/codebridge-owner-tier=d1b6f2/,
  );
  assert.match(
    success.stdout,
    /UPDATED=refs\/remotes\/origin\/fix\/public-marketing-standalone-nav-20261008=25950c/,
  );
});

test("source identity probe blocks symlink descendants without reading ref bytes", (t) => {
  if (process.platform === "win32") return t.skip("POSIX source access probe");
  const body = script.match(/probe = [^\n]+\+ """([\s\S]*?)"""/)?.[1];
  assert.ok(body, "fixed source identity probe exists");
  const temporary = fs.mkdtempSync("/tmp/kmj-ref-access-");
  try {
    const repository = temporary + "/.git";
    fs.mkdirSync(repository + "/refs/remotes/origin", { recursive: true });
    fs.mkdirSync(temporary + "/outside", { recursive: true });
    fs.writeFileSync(
      temporary + "/outside/public-marketing-standalone-nav-20261008",
      "PRIVATE_REF_CONTENT",
    );
    fs.symlinkSync(
      temporary + "/outside",
      repository + "/refs/remotes/origin/fix",
    );
    fs.writeFileSync(repository + "/packed-refs", "PRIVATE_PACKED_CONTENT");
    const paths = [
      ["REF_ROOT", repository + "/refs"],
      ["REF_REMOTES", repository + "/refs/remotes"],
      ["REF_ORIGIN", repository + "/refs/remotes/origin"],
      ["REF_FIX_PARENT", repository + "/refs/remotes/origin/fix"],
      [
        "REF_WEBSITE",
        repository +
          "/refs/remotes/origin/fix/public-marketing-standalone-nav-20261008",
      ],
      ["REF_PACKED", repository + "/packed-refs"],
    ];
    const source = body.replace(
      "'/srv/kmj-codebridge-projects/kmj-main-platform/.git'",
      JSON.stringify(repository),
    );
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import os,stat\npaths=" + JSON.stringify(paths) + "\n" + source,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /REF_FIX_PARENT_ACCESS=SYMLINK/);
    assert.match(result.stdout, /REF_WEBSITE_ACCESS=BLOCKED_DIRECTORY/);
    assert.match(result.stdout, /REF_PACKED_ACCESS=ALLOWED/);
    assert.doesNotMatch(
      result.stdout,
      /PRIVATE_REF_CONTENT|PRIVATE_PACKED_CONTENT/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
