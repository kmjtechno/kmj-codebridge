"""Offline no-root fixtures for the owner-controlled Elite gate upgrader."""
import hashlib
import importlib.util
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/production/owner_upgrade_elite_signer_ci_20261123.py'
spec = importlib.util.spec_from_file_location('elite_signer_upgrade', SOURCE)
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class GuardedSource(unittest.TestCase):
    def test_new_sources_are_sha_pinned_to_reviewed_gate_and_wrapper(self):
        for name, _, old_sha, new_sha in upgrade.FILES:
            with self.subTest(name=name):
                source = (ROOT / 'scripts/release-ci-gate.mjs' if name == 'release-ci-gate.mjs'
                          else ROOT / 'scripts/production/elite-onehost-release.mjs')
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), new_sha)
                self.assertNotEqual(old_sha, new_sha)
        self.assertEqual(len(upgrade.FILES), 2)

    def test_source_identity_and_sha_checks(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'code.mjs'
            data = b'owner-reviewed bytes' * 20
            p.write_bytes(data)
            correct = hashlib.sha256(data).hexdigest()
            self.assertEqual(upgrade.verified_bytes(p, os.getuid(), correct), data)
            with self.assertRaisesRegex(upgrade.Blocked, 'SOURCE_SHA_MISMATCH'):
                upgrade.verified_bytes(p, os.getuid(), hashlib.sha256(b'bad').hexdigest())
            link = Path(folder) / 'link.mjs'
            link.symlink_to(p)
            with self.assertRaises(OSError):
                upgrade.verified_bytes(link, os.getuid(), correct)

    def test_exclusive_write_never_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'backup'
            upgrade.exclusive_write(p, b'preserved data', 0o600)
            with self.assertRaises(FileExistsError):
                upgrade.exclusive_write(p, b'overwrite not allowed', 0o600)
            self.assertEqual(p.read_bytes(), b'preserved data')
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)

    def test_exact_apply_arguments_and_no_unauthorized_root_side_effect(self):
        with self.assertRaisesRegex(upgrade.Blocked, 'ARGUMENTS_REJECTED'):
            upgrade.main(['--apply'])
        with patch.object(upgrade.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(upgrade.Blocked, 'ROOT_ELITE_ONLY'):
                upgrade.main(['--apply', upgrade.CONFIRM])

    def test_source_never_reads_key_or_mutates_signer_state(self):
        raw = SOURCE.read_text('utf8')
        self.assertNotIn('sign-once', raw)
        self.assertNotIn('--once', raw)
        self.assertNotIn('systemctl', raw)
        self.assertNotIn('git reset', raw)
        self.assertNotIn('git clean', raw)
        self.assertIn('os.O_NOFOLLOW', raw)
        self.assertIn('os.O_EXCL', raw)
        self.assertIn('os.replace', raw)
        self.assertIn('SIGNER_SINGLE_FLIGHT_LOCK_PRESENT', raw)
        self.assertIn('SIGNER_POSTFLIGHT_INSPECT_BLOCKED', raw)
        self.assertIn('RECOVERY_REVIEW_REQUIRED', raw)


if __name__ == '__main__':
    unittest.main()
