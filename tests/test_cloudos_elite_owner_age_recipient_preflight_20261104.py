#!/usr/bin/env python3
"""Offline unit tests for root public-only AGE recipient preflight."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / "scripts/operations" /
          "kmj_elite_cloudos_age_owner_recipient_preflight_20261104.py")
spec = importlib.util.spec_from_file_location("kmj_age_preflight", SOURCE)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

AGE_KEY = "age1gde3ncmahlqd9gg50tanl99r960llztrhfapnmx853s4tjum03uqfssgdh"


class OwnerAgeRecipientReadOnlyTests(unittest.TestCase):
    def test_exact_public_recipient_parses(self):
        self.assertEqual(mod.safe_recipient((AGE_KEY + "\n").encode()), AGE_KEY)

    def test_dangerous_and_multiline_recipient_refused(self):
        for entry in (
            b"AGE-SECRET-KEY-1KTYK6RVLN5TAPE7VF6FQQSKZ9HWWCDSKUGXXNUQDWZ7XXT5YK5LSF3UTKQ\n",
            (AGE_KEY + "\n" + AGE_KEY).encode(),
            (AGE_KEY + "\r\n").encode(),
            (AGE_KEY + " \n").encode(),
            ("#" + AGE_KEY).encode(),
            AGE_KEY.upper().encode(),
            b"ssh-ed25519 AAAATEST comment\n",
        ):
            with self.subTest(entry=entry[:22]):
                with self.assertRaises(mod.Blocked):
                    mod.safe_recipient(entry)

    def test_age_public_encryption_in_memory_only(self):
        def stub(argv, *, input, capture_output, timeout, check):
            self.assertEqual(argv[0], "/usr/bin/age")
            self.assertEqual(argv[1:3], ["-e", "-r"])
            self.assertEqual(argv[3], AGE_KEY)
            self.assertTrue(capture_output)
            self.assertTrue(input.startswith(b"KMJ-CLOUDOS-OWNER"))
            self.assertLessEqual(timeout, 15)
            return subprocess.CompletedProcess(
                args=argv, returncode=0,
                stdout=b"age-encryption.org/v1\n-> X25519 test\n--- \n" + b"encryptedbinary",
                stderr=b"",
            )

        with patch.object(mod.subprocess, "run", side_effect=stub):
            mod.verify_public_encrypt("/usr/bin/age", AGE_KEY)

    def test_failed_age_encryption_not_a_valid_recipient(self):
        for bad in (
            subprocess.CompletedProcess(args=[], returncode=1,
                                        stdout=b"", stderr=b"private detail"),
            subprocess.CompletedProcess(args=[], returncode=0,
                                        stdout=b"plain text", stderr=b""),
        ):
            with patch.object(mod.subprocess, "run", return_value=bad):
                with self.assertRaisesRegex(
                    mod.Blocked, "AGE_PUBLIC_RECIPIENT_ENCRYPTION_FAILED"):
                    mod.verify_public_encrypt("/usr/bin/age", AGE_KEY)

    def test_zero_mutation_and_private_identity_unproven(self):
        s = SOURCE.read_text()
        self.assertIn('ELITE_N2_AGE_OWNER_PRIVATE_IDENTITY=NOT_INSPECTED_MUST_STAY_OFF_ELITE', s)
        self.assertIn("OWNER_INDEPENDENT_PRIVATE_KEY_RECOVERY=NOT_VERIFIED", s)
        self.assertIn("N2_CONSISTENT_FULL_DISK_BACKUP=NOT_ATTEMPTED", s)
        self.assertIn("INDEPENDENT_N2_DISPOSABLE_BOOT_RESTORE=NOT_VERIFIED", s)
        self.assertIn("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", s)
        self.assertNotIn("age-keygen", s)
        self.assertNotIn("gcloud compute", s)
        self.assertNotIn("systemctl", s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
