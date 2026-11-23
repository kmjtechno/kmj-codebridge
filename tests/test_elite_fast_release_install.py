"""Pure/temporary-filesystem tests; never install real root scripts."""
from __future__ import annotations
import hashlib
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MOD = Path(__file__).resolve().parents[1] / 'scripts/production/elite_fast_release_install.py'
spec = importlib.util.spec_from_file_location('kmj_elite_fast_release_install', MOD)
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


class TestOwnerInstaller(unittest.TestCase):
    def test_untrusted_source_uri_is_denied(self):
        for uri in ['http://raw.githubusercontent.com/kmjtechno/x',
                    'https://evil.example/key',
                    'https://raw.githubusercontent.com/otherorg/key']:
            with self.assertRaisesRegex(install.Blocked, 'PINNED_SOURCE_URI_REQUIRED'):
                install.pinned_bytes(uri, '0' * 64, 1000)

    def test_bytes_are_verified_before_install(self):
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def geturl(self): return 'https://raw.githubusercontent.com/kmjtechno/safe'
            def read(self, n): return b'A' * 500
        uri = 'https://raw.githubusercontent.com/kmjtechno/repo/123'
        with patch.object(install, 'urlopen', return_value=Reply()):
            with self.assertRaisesRegex(install.Blocked, 'PINNED_SOURCE_SHA_MISMATCH'):
                install.pinned_bytes(uri, '0' * 64, 1000)
            self.assertEqual(install.pinned_bytes(uri, hashlib.sha256(b'A' * 500).hexdigest(), 1000), b'A' * 500)

    def test_create_once_and_refuse_conflicting_file(self):
        # Simulate root ownership ONLY in the test fixture; the production
        # installer still requires real st_uid == 0 on all installed files.
        real_lstat = Path.lstat
        def root_owned_lstat(path):
            st = real_lstat(path)
            return SimpleNamespace(st_mode=st.st_mode, st_uid=0,
                                   st_nlink=st.st_nlink, st_size=st.st_size)
        with tempfile.TemporaryDirectory() as d, patch.object(install.Path, 'lstat', root_owned_lstat):
            target = Path(d) / 'operator'
            self.assertEqual(install.install_or_identical(target, b'hello', True), 'CREATED')
            self.assertEqual(install.install_or_identical(target, b'hello', True), 'ALREADY_IDENTICAL')
            with self.assertRaisesRegex(install.Blocked, 'EXISTING_FILE_HASH_CONFLICT'):
                install.install_or_identical(target, b'HELLO', True)
            self.assertEqual(target.read_bytes(), b'hello')

    def test_installer_pin_matches_reviewed_dispatcher(self):
        dispatcher = MOD.parent / 'elite_fast_release.py'
        self.assertEqual(hashlib.sha256(dispatcher.read_bytes()).hexdigest(),
                         install.CODEBRIDGE_OPERATOR_SHA256)

    def test_symlink_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p/'original').write_bytes(b'safe')
            (p/'link').symlink_to(p/'original')
            with self.assertRaisesRegex(install.Blocked, 'EXISTING_FILE_UNTRUSTED'):
                install.install_or_identical(p/'link', b'safe')
            self.assertEqual((p/'original').read_bytes(), b'safe')

    def test_missing_owner_confirmation_is_rejected(self):
        with patch.object(install, 'root_elite'), patch.object(install, 'pinned_bytes') as fetch:
            with self.assertRaisesRegex(install.Blocked, 'OWNER_APPLY_CONFIRMATION_REQUIRED'):
                install.main(['--reviewed-codebridge-sha', 'a'*40, '--apply'])
            fetch.assert_not_called()

    def test_dry_run_never_installs(self):
        with patch.object(install, 'root_elite'), \
             patch.object(install, 'pinned_bytes', side_effect=[b'x'*200, b'y'*200]), \
             patch.object(install, 'install_or_identical') as write:
            self.assertEqual(install.main(['--reviewed-codebridge-sha', 'a'*40]), 0)
            write.assert_not_called()


if __name__ == '__main__':
    unittest.main()
