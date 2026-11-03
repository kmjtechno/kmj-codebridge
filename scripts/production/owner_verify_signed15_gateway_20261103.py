#!/usr/bin/env python3
"""Read-only, root-owner signed15 post-cutover evidence (no service mutation)."""
import hashlib
import os
from pathlib import Path
import socket
import stat
import sys
import types

# Pinned existing owner cutover script, merged in #814. Import via verified bytes.
BASELINE_BLOB = '56f9e08119e8bb178be16dd213115d8f975b956a'
BASELINE_NAME = 'owner_activate_signed15_gateway_20261103.py'

class Blocked(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Blocked(code)

def load_reference(path):
    path = Path(path)
    for ancestor in [Path('/'), *reversed(path.parent.parents), path.parent]:
        st = os.lstat(ancestor)
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and
                (st.st_mode & 0o022) == 0, 'UNTRUSTED_SOURCE_PARENT')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and
                st.st_nlink == 1 and (st.st_mode & 0o022) == 0 and
                1 <= st.st_size <= 65_536, 'UNTRUSTED_SOURCE')
        data = os.read(fd, 65_537)
        require(len(data) == st.st_size, 'SOURCE_CHANGED')
    finally:
        os.close(fd)
    git_blob = hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()
    require(git_blob == BASELINE_BLOB, 'PINNED_CUTOVER_SOURCE_CHANGED')
    module = types.ModuleType('verified_signed15_cutover_reference')
    module.__file__ = str(path)
    exec(compile(data, str(path), 'exec'), module.__dict__)
    return module

def verify(m):
    require(os.geteuid() == 0 and socket.gethostname().split('.')[0].lower() == 'kmj-elite',
            'ROOT_KMJ_ELITE_REQUIRED')
    require(sys.argv[1:] in ([], ['--inspect']), 'INVALID_ARGUMENTS')
    _, config = m.old_conf_and_gateway_config()
    m.validate_runtime()
    actual = m.regular_owner_file(m.NEW_CONF, max_size=16_384)
    require(actual == m.new_content(config), 'SIGNED15_OVERRIDE_DRIFT')
    require(m.show('LoadState') == 'loaded' and
            m.show('FragmentPath') == str(m.UNIT_PATH), 'GATEWAY_UNIT_UNEXPECTED')
    require(m.show('ActiveState') == 'active' and
            m.show('NeedDaemonReload') == 'no' and
            m.show('User') == 'kmjcode', 'GATEWAY_NOT_READY')
    dropins = m.show('DropInPaths').split()
    require(str(m.OLD_CONF) in dropins and str(m.NEW_CONF) in dropins and
            all(Path(p).name <= m.NEW_CONF.name for p in dropins),
            'ROLLBACK_OR_SIGNED15_OVERRIDE_NOT_EFFECTIVE')
    m.effective_new(m.NEW_DIR, config)
    try:
        pid = int(m.show('MainPID'))
    except ValueError:
        raise Blocked('PID_INVALID') from None
    require(pid > 1 and Path(f'/proc/{pid}/cwd').resolve(strict=True) == m.NEW_DIR,
            'RUNNING_PROCESS_NOT_SIGNED15')
    port = m.gateway_port(config)
    counts = []
    for origin in ('DIRECT', 'LOCAL_NGINX', 'PUBLIC'):
        observed = m.origin_probe(origin, port)
        require(observed['count'] >= 100 and observed['commit'] == m.NEW_SHA,
                origin + '_MCP_SIGNED15_NOT_VERIFIED')
        counts.append(observed['count'])
    require(len(set(counts)) == 1, 'ORIGIN_TOOL_CATALOG_MISMATCH')
    require(m.show('ActiveState') == 'active' and int(m.show('MainPID')) == pid and
            Path(f'/proc/{pid}/cwd').resolve(strict=True) == m.NEW_DIR,
            'PROCESS_CHANGED_DURING_AUDIT')
    print('SIGNED15_POSTCUTOVER=PASS')
    print('SIGNED14_ROLLBACK_PRESERVED=PASS')
    print('DIRECT_LOCAL_PUBLIC_MCP=PASS')
    print('MCP_TOOL_COUNT=' + str(counts[0]))
    print('PRODUCTION_MUTATION=NONE')

if __name__ == '__main__':
    try:
        verify(load_reference(Path(__file__).with_name(BASELINE_NAME)))
    except (Blocked, OSError, ValueError, TypeError, KeyError) as e:
        code = e.args[0] if isinstance(e, Blocked) else 'AUDIT_UNAVAILABLE'
        print('SIGNED15_POSTCUTOVER=BLOCKED:' + str(code))
        raise SystemExit(2)
