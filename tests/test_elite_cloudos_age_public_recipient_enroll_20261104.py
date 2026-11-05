"""Offline, tempdir-only regression for public-only AGE enrollment script."""
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

S = Path(__file__).resolve().parents[1] / "scripts" / "operations" / "kmj_elite_cloudos_age_public_recipient_enroll_20261104.py"
spec = importlib.util.spec_from_file_location("age_enroll", S)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
PUBLIC = "age1gde3ncmahlqd9gg50tanl99r960llztrhfapnmx853s4tjum03uqfssgdh"

class SafeEnrollmentTests(unittest.TestCase):
    def test_public_only_and_digest(self):
        got = mod.validate_public(PUBLIC)
        self.assertEqual(got[0], PUBLIC)
        self.assertEqual(len(got[1]), 64)
        self.assertEqual(mod.validate_public(PUBLIC, got[1])[1], got[1])
        for bad in ("AGE-SECRET-KEY-1...", PUBLIC.upper(), PUBLIC+"\n", PUBLIC+" ", "age1short"):
            with self.assertRaises(mod.Blocked):
                mod.validate_public(bad)
        with self.assertRaisesRegex(mod.Blocked, "SHA256_MISMATCH"):
            mod.validate_public(PUBLIC, "0"*64)

    def test_new_public_file_atomic_strict_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            fd = os.open(d, mod.O_DIR)
            try:
                mod.install_new(fd, PUBLIC)
                target = Path(d) / mod.TARGET
                self.assertEqual(target.read_text(), PUBLIC+"\n")
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                self.assertEqual(target.stat().st_nlink, 1)
                self.assertEqual(sorted(x.name for x in Path(d).iterdir()), [mod.TARGET])
                with self.assertRaises(FileExistsError):
                    mod.install_new(fd, PUBLIC)
                self.assertEqual(target.read_text(), PUBLIC+"\n")
                self.assertEqual(sorted(x.name for x in Path(d).iterdir()), [mod.TARGET])
            finally:
                os.close(fd)

    def test_bad_write_never_installs_destination(self):
        with tempfile.TemporaryDirectory() as d:
            fd = os.open(d, mod.O_DIR)
            try:
                with mock.patch.object(mod.os, "write", return_value=0):
                    with self.assertRaisesRegex(mod.Blocked, "SHORT_WRITE"):
                        mod.install_new(fd, PUBLIC)
                self.assertEqual(list(Path(d).iterdir()), [])
            finally:
                os.close(fd)

    def test_crypto_failure_does_not_pass(self):
        with mock.patch.object(mod, "age_binary", return_value="/usr/bin/age"):
            for rc, output in ((1,b""),(0,b"wrong")):
                with self.subTest(rc=rc, output=output), mock.patch.object(mod.subprocess,"run",return_value=mock.Mock(returncode=rc,stdout=output)):
                    with self.assertRaisesRegex(mod.Blocked,"AGE_PUBLIC_ENCRYPTION_FAILED"):
                        mod.verify_encrypt(PUBLIC)
            with mock.patch.object(mod.subprocess,"run",return_value=mock.Mock(returncode=0,stdout=b"age-encryption.org/v1\n"+b"x"*90)):
                mod.verify_encrypt(PUBLIC)

    def test_host_guard_is_fail_closed(self):
        with mock.patch.object(mod.os,"geteuid",return_value=1000):
            with self.assertRaisesRegex(mod.Blocked,"EXACT_ELITE_ROOT_REQUIRED"):
                mod.root_host()

    def test_never_operates_on_secret_material(self):
        src = S.read_text()
        self.assertNotIn("age-keygen", src)
        self.assertNotIn("AGE-SECRET-KEY-1example", src)
        self.assertNotIn("shell=True",src)
        self.assertNotIn("gcloud",src)
        self.assertNotIn("systemctl",src)

if __name__ == "__main__":
    unittest.main()
