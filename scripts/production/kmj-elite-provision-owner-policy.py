#!/usr/bin/env python3
"""Owner-only, fail-closed ONE-TIME KMJ-elite Ed25519 custody enrollment.

Only execute from root-private staging after a pinned SSH host-key transfer.
Never signs, starts a service, or changes the running gateway. No secrets print.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import stat
import subprocess
import sys

HOST = 'kmj-elite'
USER = 'kmjsigner'
HOME = Path('/var/lib/kmj-codebridge-signer')
INBOX = Path('/root/.kmj-codebridge-owner-custody-20261123')
CONFIG = HOME / '.config' / 'kmj-codebridge'
KEY = CONFIG / 'kmj-release-original.pem'
PUB = CONFIG / 'kmj-release-original.pub'
POLICY = CONFIG / 'auto-sign-policy.json'
SRC = HOME / 'source' / 'kmj-codebridge'
WRAPPER = Path('/usr/local/libexec/kmj-codebridge-elite-signer/production/elite-onehost-release.mjs')
PIN = '2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8'

class Blocked(Exception):
    pass

def guard(condition, code):
    if not condition:
        raise Blocked(code)

def check_file(p, owner, minlen=1, maxlen=8192):
    st = p.lstat()
    guard(stat.S_ISREG(st.st_mode) and st.st_uid == owner and st.st_nlink == 1
          and not st.st_mode & 0o022 and minlen <= st.st_size <= maxlen,
          'FILE_TRUST_NOT_PROVED')
    return st

def trusted_dir(p, owner, allow_create=False):
    if not p.exists() and not p.is_symlink():
        guard(allow_create, 'PRIVATE_DIRECTORY_MISSING')
        p.mkdir(mode=0o700)
        os.chown(p, owner, -1)
    st = p.lstat()
    guard(stat.S_ISDIR(st.st_mode) and st.st_uid == owner
          and st.st_mode & 0o077 == 0 and not p.is_symlink(),
          'PRIVATE_DIRECTORY_UNTRUSTED')

def run(argv, *, username=None, timeout=90, stdout=True):
    cmd = ['/usr/sbin/runuser', '-u', username, '--'] + argv if username else argv
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE if stdout else subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                           env={'PATH':'/usr/bin:/bin','HOME':str(HOME) if username else '/root',
                                'LANG':'C','LC_ALL':'C','GIT_TERMINAL_PROMPT':'0'})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked('PREREQUISITE_EXECUTION_FAILED') from None
    guard(p.returncode == 0, 'PREREQUISITE_EXECUTION_FAILED')
    return p.stdout if stdout else b''

def spki_sha256(path, private):
    args = ['/usr/bin/openssl','pkey']
    if not private:
        args.append('-pubin')
    args += ['-in', str(path), '-pubout', '-outform', 'DER', '-passin', 'pass:']
    der = run(args, timeout=15)
    guard(40 <= len(der) <= 1000, 'OWNER_KEY_DER_INVALID')
    return hashlib.sha256(der).hexdigest()

def copy_private(src, dest, owner):
    """Create-only, bounded, no-follow input/output, then fsync before ownership transfer."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd_in = os.open(src, flags)
    try:
        before = os.fstat(fd_in)
        guard(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
              and 1 <= before.st_size <= 8192, 'STAGED_KEY_FILE_UNTRUSTED')
        data = bytearray()
        while len(data) < before.st_size:
            part = os.read(fd_in, before.st_size - len(data))
            guard(bool(part), 'STAGED_KEY_SHORT_READ')
            data.extend(part)
        after = os.fstat(fd_in)
        guard((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns) ==
              (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),
              'STAGED_KEY_CHANGED')
    finally:
        os.close(fd_in)
    guard(not dest.exists() and not dest.is_symlink(), 'KEY_CUSTODY_ALREADY_PRESENT')
    fd_out = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd_out, 0o600)
        os.fchown(fd_out, owner, -1)
        written = 0
        while written < len(data):
            n = os.write(fd_out, data[written:])
            guard(n>0, 'PROTECTED_WRITE_FAILED')
            written += n
        os.fsync(fd_out)
    finally:
        os.close(fd_out)
    for i in range(len(data)):
        data[i] = 0
    check_file(dest,owner)

def create_policy(owner):
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    expires = now + dt.timedelta(days=29)
    obj = {
      'schema':1,
      'enabled':True,
      'repo':'kmjtechno/kmj-codebridge',
      'profile':'owner-host-auto-sign-stable-only',
      'ownerConsent':'AUTO_SIGN_REVIEWED_MAIN_ONLY',
      'keyId':'kmj-release-2026',
      'approvedAt':now.strftime('%Y-%m-%dT%H:%M:%SZ'),
      'expiresAt':expires.strftime('%Y-%m-%dT%H:%M:%SZ'),
      'maxSequence':40,
      'repoPath':str(SRC),
      'keyFile':str(KEY),
      'publicKeyFile':str(PUB),
    }
    blob = (json.dumps(obj,sort_keys=True,indent=2)+'\n').encode('utf8')
    guard(not POLICY.exists() and not POLICY.is_symlink(), 'OWNER_POLICY_ALREADY_PRESENT')
    fd = os.open(POLICY, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(fd,owner,-1)
        os.fchmod(fd,0o600)
        count = 0
        while count < len(blob):
            n = os.write(fd,blob[count:])
            guard(n>0,'POLICY_WRITE_FAILED')
            count+=n
        os.fsync(fd)
    finally:
        os.close(fd)
    check_file(POLICY,owner,minlen=20)
    fd=os.open(CONFIG,os.O_DIRECTORY|os.O_RDONLY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def main():
    guard(os.geteuid()==0 and socket.gethostname().split('.')[0].lower()==HOST,
          'ELITE_ROOT_REQUIRED')
    info = pwd.getpwnam(USER)
    guard(info.pw_uid != 0 and info.pw_dir == str(HOME) and info.pw_shell.endswith('/nologin'),
          'SIGNER_IDENTITY_MISMATCH')
    uid=info.pw_uid
    trusted_dir(Path('/root'),0)
    trusted_dir(INBOX,0)
    priv=INBOX/'kmj-release.pem'
    pub=INBOX/'kmj-release-2026.pub'
    check_file(priv,0)
    check_file(pub,0)
    guard(spki_sha256(priv,True) == PIN, 'OWNER_PRIVATE_SPki_MISMATCH')
    guard(spki_sha256(pub,False) == PIN, 'OWNER_PUBLIC_SPki_MISMATCH')
    print('ORIGINAL_ED25519_PAIR=PINNED_PASS',flush=True)
    trusted_dir(HOME,uid)
    guard(not POLICY.exists() and not POLICY.is_symlink()
          and not KEY.exists() and not KEY.is_symlink()
          and not PUB.exists() and not PUB.is_symlink(),
          'SIGNER_ENROLLMENT_ALREADY_PRESENT')
    # Fresh isolated source checkout, no checkout of repository file contents or hooks.
    source_parent=HOME/'source'
    trusted_dir(source_parent,uid,allow_create=True)
    guard(not SRC.exists() and not SRC.is_symlink(), 'SIGNER_REPO_ALREADY_PRESENT')
    run(['/usr/bin/git','-c','core.hooksPath=/dev/null','clone','--no-checkout',
         '--single-branch','--branch','main','https://github.com/kmjtechno/kmj-codebridge.git',
         str(SRC)],username=USER,timeout=180,stdout=False)
    current=run(['/usr/bin/git','-C',str(SRC),'rev-parse','refs/remotes/origin/main'],
                username=USER,timeout=20).decode().strip()
    remote=run(['/usr/bin/git','ls-remote','https://github.com/kmjtechno/kmj-codebridge.git',
                'refs/heads/main'],username=USER,timeout=20).decode().strip().split()
    guard(len(remote)==2 and remote[0]==current and remote[1]=='refs/heads/main',
          'MAIN_SHA_MOVED_RETRY_AFTER_REVIEW')
    print('SIGNER_SOURCE_MAIN_FREEZE=PASS',flush=True)
    trusted_dir(HOME/'.config',uid,allow_create=True)
    trusted_dir(CONFIG,uid,allow_create=True)
    created=[]
    try:
        copy_private(priv,KEY,uid); created.append(KEY)
        copy_private(pub,PUB,uid); created.append(PUB)
        create_policy(uid); created.append(POLICY)
    except Exception:
        # Create-only rollback of files created by this process; preserve original inbox.
        for f in reversed(created):
            try: f.unlink()
            except OSError: pass
        raise
    # Remove root-private staging copies once signer files are committed.
    priv.unlink(); pub.unlink()
    print('OWNER_POLICY=CREATED_29_DAY',flush=True)
    print('KEY_CUSTODY=NONROOT_0600',flush=True)
    print('OWNER_PRIVATE_KEY_EXPORTED_TO_CHAT=NO',flush=True)
    # The already observed Elite Main Platform agent's Node24 binary is used
    # only if its proc pointer still exists; no PATH fallback or version bypass.
    node = Path('/proc/1627302/exe')
    guard(node.exists(), 'PINNED_AGENT_NODE24_PROCESS_NOT_FOUND')
    node_path = str(node.resolve())
    ver = run([node_path,'--version'],timeout=8).decode().strip()
    guard(ver.startswith('v24.'), 'PINNED_AGENT_NODE24_REQUIRED')
    print('NODE24=PASS',flush=True)
    guard(WRAPPER.exists(), 'ELITE_ONEHOST_SIGNER_NOT_INSTALLED')
    report = run([node_path,str(WRAPPER),'--inspect'],username=USER,timeout=20).decode()
    guard('ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN' in report and
          'SIGNED_DEPLOY_TIMER=ACTIVE' in report,
          'SIGNER_INSPECT_NOT_READY')
    print('ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN',flush=True)
    print('SIGNED_DEPLOY_TIMER=ACTIVE',flush=True)
    print('SIGNER_ENROLLMENT=PASS_INSPECT_ONLY',flush=True)
    # No signing, GitHub PR, publisher or gateway cutover is performed here.
    try:
        (INBOX/'kmj-elite-provision-owner-policy.py').unlink()
        INBOX.rmdir()
    except OSError:
        pass

if __name__ == '__main__':
    try:
        main()
    except (Blocked,OSError,KeyError,ValueError,TypeError):
        print('SIGNER_ENROLLMENT=BLOCKED_REVIEW_REQUIRED')
        sys.exit(2)
