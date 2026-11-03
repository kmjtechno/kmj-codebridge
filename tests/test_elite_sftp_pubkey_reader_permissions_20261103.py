#!/usr/bin/env python3
"""Regression: public-only uploader key readable by unprivileged SSHD UID.

All file operations use isolated temporary directories. No real /etc/ssh,
production account, cloud resource, network, or private SSH key accessed.
"""
from __future__ import annotations

import base64
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / "scripts/operations" /
          "kmj_elite_cloudos_sftp_pubkey_enroll_20261103.py")
spec = importlib.util.spec_from_file_location("elite_sftp_pubkey", SOURCE)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


class PublicKeyReaderPermissions(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="kmj-sftp-key-test-")
        self.addCleanup(self.root.cleanup)
        self.ssh = Path(self.root.name) / "ssh"
        self.ssh.mkdir()
        key_blob = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
        self.line = ("ssh-ed25519 " + base64.b64encode(key_blob).decode() +
                     " " + mod.COMMENT + "\n").encode()
        self.canonical, self.fingerprint = mod.parse_public(self.line.decode())
        self.assertEqual(self.line, self.canonical)

    def open_dir(self, parent, name):
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                       dir_fd=parent)

    def read_test_file(self, directory, basename, *, mode=None):
        fd = os.open(basename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            s = os.fstat(fd)
            self.assertTrue(stat.S_ISREG(s.st_mode))
            if mode is not None:
                self.assertEqual(stat.S_IMODE(s.st_mode), mode)
            return os.read(fd, 4096)
        finally:
            os.close(fd)

    def fake_host(self):
        return (os.open(self.ssh, os.O_RDONLY | os.O_DIRECTORY),
                self.canonical)

    def test_install_sets_readable_nonwritable_modes_despite_umask_077(self):
        prior = os.umask(0o077)
        try:
            with (patch.object(mod, "host", side_effect=self.fake_host),
                  patch.object(mod, "sshd_policy", return_value=None),
                  patch.object(mod, "checked_dir", side_effect=self.open_dir),
                  patch.object(mod, "checked_file", side_effect=self.read_test_file)):
                mod.status(install=True, expected_fp=self.fingerprint)
            auth_dir = self.ssh / "authorized_keys"
            auth_file = auth_dir / mod.UPLOADER
            self.assertEqual(stat.S_IMODE(auth_dir.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE(auth_file.stat().st_mode), 0o644)
            self.assertEqual(auth_file.read_bytes(), self.canonical)
            self.assertFalse(auth_file.stat().st_mode & 0o222)
        finally:
            os.umask(prior)

    def test_same_key_is_idempotent_and_different_key_refuses_overwrite(self):
        with (patch.object(mod, "host", side_effect=self.fake_host),
              patch.object(mod, "sshd_policy", return_value=None),
              patch.object(mod, "checked_dir", side_effect=self.open_dir),
              patch.object(mod, "checked_file", side_effect=self.read_test_file)):
            mod.status(install=True, expected_fp=self.fingerprint)
            mod.status(install=True, expected_fp=self.fingerprint)
            target = self.ssh / "authorized_keys" / mod.UPLOADER
            original = target.read_bytes()
            with self.assertRaises(mod.Blocked):
                mod.status(install=True, expected_fp="SHA256:" + "A" * 43)
            self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
