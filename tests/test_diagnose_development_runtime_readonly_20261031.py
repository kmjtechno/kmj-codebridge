from __future__ import annotations
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/production/diagnose-development-runtime-readonly-20261031.py'
spec = importlib.util.spec_from_file_location('d3doctor', SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Result:
    def __init__(self, out='', err='', code=0):
        self.stdout, self.stderr, self.returncode = out, err, code

class Contract(unittest.TestCase):
    def baseline(self):
        return '\n'.join(k+'='+v for k,v in m.EXPECTED.items())+'\n'

    def test_unit_schema_exact_and_all_properties(self):
        self.assertEqual(len(m.EXPECTED),16)
        self.assertEqual(m.parse_systemd(self.baseline()),m.EXPECTED)
        for k in m.EXPECTED:
            t=dict(m.EXPECTED);t[k]+='tampered'
            f=lambda _:Result('\n'.join(x+'='+y for x,y in t.items())+'\n')
            state, keys=m.probe_systemd(f)
            self.assertIn(k,keys)
            self.assertEqual(state,'FAILED_OR_ACTIVE_UNIT' if k=='ActiveState' else 'POLICY_DRIFT')

    def test_malformed_never_approves(self):
        for invalid in (self.baseline()+'User=root\n',self.baseline().replace('User=','Invalid='),
                        self.baseline().replace('NoNewPrivileges=yes','NoNewPrivileges=yes\r'),
                        self.baseline().replace('ProtectHome=yes','ProtectHome='+('x'*1000)),
                        self.baseline()[:-1]+'\n\n',self.baseline().replace('User=kmjdevci\n','')):
            self.assertIsNone(m.parse_systemd(invalid))
            self.assertEqual(m.probe_systemd(lambda _:Result(invalid))[0],'MALFORMED')

    def test_git_commands_are_exact_and_no_secrets_in_results(self):
        seen=[]
        def run(args):
            seen.append(args)
            if args[-3:] == ['rev-parse','--verify','HEAD']:
                return Result('a'*40+'\n')
            if 'cat-file' in args:return Result('', 'secret-key-path /root/private')
            if 'show-ref' in args:return Result('')
            raise AssertionError(args)
        result=m.probe_git(run)
        self.assertEqual(result,{'HEAD':'PASS','OBJECT':'PASS','MAIN_REF':'PASS'})
        self.assertEqual(len(seen),3)
        for args in seen:
            self.assertEqual(args[:6],['/usr/sbin/runuser','-u','kmjdevci','--','/usr/bin/git','-c'])
            self.assertIn('-C',args)
            self.assertNotIn('bash',args)
        self.assertNotIn('secret',str(result))

    def test_denied_git_shortcircuits(self):
        seen=[]
        def run(args):
            seen.append(args)
            return Result('', '/var/private/credential: Permission denied',128)
        r=m.probe_git(run)
        self.assertEqual(len(seen),1)
        self.assertEqual(r['HEAD'],'ACCESS_DENIED')
        self.assertEqual(r['OBJECT'],'NOT_CHECKED')
        self.assertNotIn('credential',str(r))


    def test_pack_access_is_fixed_bounded_and_readonly(self):
        import contextlib
        import stat
        from types import SimpleNamespace
        name = 'pack-' + 'a'*40 + '.pack'
        seen = []
        def lstat(path):
            seen.append(('lstat', path))
            is_file = path.endswith('.pack')
            return SimpleNamespace(
                st_mode=(stat.S_IFREG | 0o440) if is_file else (stat.S_IFDIR | 0o750),
                st_nlink=1,
            )
        def scandir(path):
            self.assertEqual(path, m.PACK_DIR)
            return contextlib.nullcontext([SimpleNamespace(name=name)])
        def run(args):
            seen.append(('run', args))
            self.assertEqual(args[:5],
                ['/usr/sbin/runuser', '-u', 'kmjdevci', '--', '/usr/bin/test'])
            self.assertEqual(args[5], '-r')
            self.assertEqual(args[6], m.PACK_DIR + '/' + name)
            return Result()
        self.assertEqual(m.probe_pack_access(run, lstat, scandir), 'PASS')
        self.assertEqual(len([v for v in seen if v[0] == 'run']), 1)
        self.assertNotIn('secret', str(seen))

    def test_pack_access_rejects_untrusted_and_denied_without_mutation(self):
        import contextlib
        import stat
        from types import SimpleNamespace
        name = 'pack-' + 'b'*40 + '.idx'
        def scandir(_):
            return contextlib.nullcontext([SimpleNamespace(name=name)])
        def lstat(path):
            return SimpleNamespace(st_mode=(stat.S_IFREG | 0o440)
                                   if path.endswith('.idx') else (stat.S_IFDIR | 0o750),
                                   st_nlink=1)
        self.assertEqual(m.probe_pack_access(
            lambda _: Result('', 'private path', 1), lstat, scandir),
            'SOME_UNREADABLE')
        def symlink(path):
            if path.endswith('.idx'):
                return SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_nlink=1)
            return lstat(path)
        self.assertEqual(m.probe_pack_access(
            lambda _: self.fail('must not execute'), symlink, scandir),
            'UNTRUSTED_ENTRY')
        def unsafe_directory(path):
            if path.endswith('/.git'):
                return SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_nlink=1)
            return lstat(path)
        self.assertEqual(m.probe_pack_access(
            lambda _: self.fail('must not execute'), unsafe_directory, scandir),
            'UNTRUSTED_PATH')
        self.assertEqual(m.probe_pack_access(
            lambda _: self.fail('must not execute'), lstat,
            lambda _: contextlib.nullcontext([SimpleNamespace(name=name)] * 129)),
            'TOO_MANY_ENTRIES')
        # Unknown names must count too: the original len(files) check allowed
        # arbitrarily large directories to be scanned without a bound.
        self.assertEqual(m.probe_pack_access(
            lambda _: self.fail('must not execute'), lstat,
            lambda _: contextlib.nullcontext(
                [SimpleNamespace(name='ignored-%03d' % i) for i in range(129)])),
            'TOO_MANY_ENTRIES')

    def test_wrong_user_host_or_arbitrary_arguments_rejected(self):
        with patch.object(m.sys,'argv',['probe','--any']):
            self.assertEqual(m.main(),2)
        with patch.object(m.sys,'argv',['probe']), patch.object(m.os,'geteuid',return_value=123):
            self.assertEqual(m.main(),2)
        with patch.object(m.sys,'argv',['probe']), patch.object(m.os,'geteuid',return_value=0),patch.object(m.socket,'gethostname',return_value='other'):
            self.assertEqual(m.main(),2)

    def test_git_probe_forbids_lazy_fetch_and_user_config(self):
        with patch.object(m.subprocess, 'run', return_value=Result()) as execute:
            m.fixed_run(['/usr/bin/git', '--version'])
        kw = execute.call_args.kwargs
        self.assertFalse(kw['check'])
        self.assertEqual(kw['env']['GIT_NO_LAZY_FETCH'], '1')
        self.assertEqual(kw['env']['GIT_NO_REPLACE_OBJECTS'], '1')
        self.assertEqual(kw['env']['GIT_CONFIG_GLOBAL'], '/dev/null')
        self.assertEqual(kw['env']['GIT_CONFIG_NOSYSTEM'], '1')
        self.assertEqual(kw['env']['GIT_TERMINAL_PROMPT'], '0')
        self.assertEqual(kw['env']['GIT_OPTIONAL_LOCKS'], '0')
        self.assertEqual(kw['stdin'], m.subprocess.DEVNULL)

    def test_diagnostic_never_runs_mutating_command(self):
        calls=[]
        def run(args):
            calls.append(args)
            return Result(self.baseline()) if args[0]=='/usr/bin/systemctl' else Result('', 'Permission denied',128)
        result=m.inspect(run)
        self.assertEqual(result['SYSTEMD_STATUS'],'MATCH')
        self.assertEqual(result['GIT_HEAD'],'ACCESS_DENIED')
        self.assertEqual(result['ROOT_OR_REPO_MUTATED'],'NO')
        self.assertEqual(result['WORKER_STARTED'],'NO')
        self.assertEqual(result['PRODUCTION_DEPLOYED'],'NO')
        for args in calls:
            self.assertTrue(args[0] in ('/usr/bin/systemctl','/usr/sbin/runuser'))
            self.assertFalse(any(x in args for x in ('chmod','chown','start','restart','reset','clean','install','push')))
        raw=SOURCE.read_text()
        self.assertNotIn('shell=True',raw)
        self.assertNotIn('os.chmod(',raw)
        self.assertNotIn('os.chown(',raw)
        self.assertNotIn('os.write(',raw)

if __name__=='__main__':unittest.main()
