#!/usr/bin/env python3
"""Offline-only safety tests for guarded ELITE sshd on-disk stage.

The tests redirect all hard-coded write destinations to private temporary
directories, mock sshd validation, and never touch real /etc/ssh or services.
"""
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = (
    Path(__file__).resolve().parents[1] /
    "scripts/operations/kmj_elite_cloudos_sshd_sftp_stage_on_disk_20261103.py"
)
spec = importlib.util.spec_from_file_location("cloudos_guarded_stage", SCRIPT)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


class StageSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="kmj-sshd-test-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.sshdir = root / "ssh"
        self.sshdir.mkdir()
        self.config = self.sshdir / "sshd_config"
        self.original = (b"Include /etc/ssh/sshd_config.d/*.conf\n"
                         b"PasswordAuthentication no\n")
        self.config.write_bytes(self.original)
        self.config.chmod(0o600)
        self.backup = root / "private-original.conf"
        self.mode = 0o600
        self.original_stat = self.config.stat()
        self.admin = {("root", "127.0.0.1"): b"unchanged"}
        self.paths = (
            patch.object(mod, "MAIN", str(self.config)),
            patch.object(mod, "SSH_DIR", str(self.sshdir)),
            patch.object(mod, "BACKUP", str(self.backup)),
            patch.object(mod, "read_conf", self.read_fake),
            patch.object(mod, "query", return_value=b""),
        )
        for p in self.paths:
            p.start()
            self.addCleanup(p.stop)

    def read_fake(self):
        return self.config.read_bytes(), self.config.stat()

    def assert_backup(self):
        self.assertEqual(self.backup.read_bytes(), self.original)
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o600)

    def test_stage_validates_candidate_then_postwrite_without_reload(self):
        receipts = []

        def fake_verify(path, admin):
            self.assertEqual(admin, self.admin)
            raw = self.config.read_bytes() if path is None else Path(path).read_bytes()
            self.assertIn(mod.STANZA, raw)
            receipts.append("disk" if path is None else "candidate")

        with patch.object(mod, "verify", side_effect=fake_verify):
            mod.apply(self.original, self.original_stat, self.admin)
        self.assertEqual(receipts, ["candidate", "candidate", "disk"])
        self.assertEqual(self.config.read_bytes(),
                         self.original + mod.STANZA)
        self.assert_backup()

    def test_failing_prewrite_candidate_never_changes_original(self):
        with patch.object(mod, "verify", side_effect=mod.Blocked("TEST_PRE")):
            with self.assertRaises(mod.Blocked):
                mod.apply(self.original, self.original_stat, self.admin)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(self.backup.exists())

    def test_failing_postwrite_check_restores_original(self):
        def fail_disk(path, admin):
            if path is None:
                raise mod.Blocked("TEST_POST")

        with patch.object(mod, "verify", side_effect=fail_disk):
            with self.assertRaisesRegex(mod.Blocked,
                                        "POST_WRITE_FAILURE_ROLLED_BACK"):
                mod.apply(self.original, self.original_stat, self.admin)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assert_backup()

    def test_backup_exists_causes_fail_before_change(self):
        self.backup.write_bytes(b"existing private witness")
        with patch.object(mod, "verify", return_value=None):
            with self.assertRaises(FileExistsError):
                mod.apply(self.original, self.original_stat, self.admin)
        self.assertEqual(self.backup.read_bytes(), b"existing private witness")
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_match_directives_keep_global_environment_hardened(self):
        self.assertIn(b"Match User kmjcloudosbackup", mod.STANZA)
        self.assertNotIn(b"PermitUserEnvironment", mod.STANZA)
        self.assertEqual(mod.EXPECTED["permituserenvironment"], "no")
        self.assertEqual(mod.EXPECTED["forcecommand"], "internal-sftp -d /incoming")
        self.assertEqual(mod.EXPECTED["allowtcpforwarding"], "no")


if __name__ == "__main__":
    unittest.main(verbosity=2)
