"""Offline SFTP encrypted archive -> root vault guarded admission regressions."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

OPS = Path(__file__).resolve().parents[1] / "scripts" / "operations"
sys.path.insert(0, str(OPS))
src = OPS / "kmj_elite_cloudos_n2_root_vault_admit_20261104.py"
spec = importlib.util.spec_from_file_location("n2_admit", src)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
from kmj_elite_cloudos_n2_cold_archive_integrity_20261104 import SCHEMA, RECIPIENT_SHA

CAPTURE = "a" * 32
CIPHER = b"age-encryption.org/v1\n" + b"not-real-cipher-fixture" * 16

class TestSpoolAdmission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.spool, self.vault = root / "spool", root / "vault"
        self.spool.mkdir(mode=0o700)
        self.vault.mkdir(mode=0o700)
        self.source = self.spool / ("n2-cold-" + CAPTURE + ".age")
        self.manifest = self.spool / ("n2-cold-" + CAPTURE + ".json")
        self.sha = hashlib.sha256(CIPHER).hexdigest()
        self.source.write_bytes(CIPHER)
        self.source.chmod(0o600)
        self.fields = dict(
            schema=SCHEMA, capture_id=CAPTURE, project="kmj-techno",
            zone="us-central1-a", instance="kmj-cloudos-kvm-test",
            source_disk_bytes=30*1024**3,
            captured_at_utc="2026-11-04T00:00:00Z",
            capture_method="cold-block-read", source_state_reported="TERMINATED",
            age_recipient_sha256=RECIPIENT_SHA, source_disk_sha256="b"*64,
            ciphertext_bytes=len(CIPHER), ciphertext_sha256=self.sha,
        )
        self.write_manifest()
        self.sfd = os.open(self.spool, a.DIR_FLAGS)
        self.vfd = os.open(self.vault, a.DIR_FLAGS)
        self.addCleanup(os.close, self.vfd)
        self.addCleanup(os.close, self.sfd)

    def write_manifest(self):
        self.manifest.write_text(json.dumps(self.fields) + "\n")
        self.manifest.chmod(0o600)

    def admit(self, commit=False, pin=None):
        return a.admission(self.sfd, self.vfd, os.getuid(), CAPTURE,
                           self.sha if pin is None else pin, promote=commit)

    def test_read_only_inspect_does_not_write(self):
        self.assertEqual(self.admit()["ciphertext_sha256"], self.sha)
        self.assertEqual(list(self.vault.iterdir()), [])

    def test_root_copy_pinned_hash_atomic_no_spool_mutation(self):
        with patch.object(a, "check_space", return_value=None):
            self.assertEqual(self.admit(commit=True)["ciphertext_sha256"], self.sha)
        c = self.vault / self.source.name
        m = self.vault / self.manifest.name
        self.assertEqual(c.read_bytes(), CIPHER)
        self.assertEqual(m.read_bytes(), self.manifest.read_bytes())
        self.assertEqual(stat.S_IMODE(c.stat().st_mode), 0o600)
        self.assertEqual(c.stat().st_nlink, 1)
        self.assertEqual(len(list(self.vault.iterdir())), 2)
        self.assertEqual(self.source.read_bytes(), CIPHER)

    def test_different_pinned_digest_denied(self):
        with self.assertRaisesRegex(a.Blocked, "SOURCE_PIN_MISMATCH"):
            self.admit(commit=True, pin="f"*64)
        self.assertEqual(list(self.vault.iterdir()), [])

    def test_tamper_cleans_temps_leaves_spool(self):
        self.source.write_bytes(CIPHER[:-1] + b"x")
        self.source.chmod(0o600)
        with patch.object(a, "check_space", return_value=None):
            with self.assertRaisesRegex(a.Blocked, "INDEPENDENT_PIN_MISMATCH"):
                self.admit(commit=True)
        self.assertEqual(list(self.vault.iterdir()), [])
        self.assertTrue(self.source.exists())

    def test_fake_header_rejected_even_matching_digest(self):
        data = b"not-an-age-header\n" + b"a" * 230
        self.source.write_bytes(data)
        self.sha = hashlib.sha256(data).hexdigest()
        self.fields["ciphertext_bytes"] = len(data)
        self.fields["ciphertext_sha256"] = self.sha
        self.write_manifest()
        with patch.object(a, "check_space", return_value=None):
            with self.assertRaisesRegex(a.Blocked, "SOURCE_AGE_HEADER_INVALID"):
                self.admit(commit=True)
        self.assertEqual(list(self.vault.iterdir()), [])

    def test_existing_target_no_overwrite(self):
        target = self.vault / self.source.name
        target.write_bytes(b"preserve")
        with self.assertRaisesRegex(a.Blocked, "DESTINATION_ALREADY_EXISTS"):
            self.admit(commit=True)
        self.assertEqual(target.read_bytes(), b"preserve")

    def test_symlink_or_extra_link_denied(self):
        self.source.unlink()
        self.source.symlink_to(self.manifest)
        with self.assertRaises(OSError):
            self.admit()
        self.source.unlink()
        self.source.write_bytes(CIPHER)
        self.source.chmod(0o600)
        os.link(self.source, self.spool / "other-link")
        with self.assertRaisesRegex(a.Blocked, "EXCLUSIVE"):
            self.admit()

    def test_nonprivate_spool_file_denied(self):
        self.source.chmod(0o644)
        with self.assertRaisesRegex(a.Blocked, "EXCLUSIVE"):
            self.admit()

    def test_false_stopped_claim_denied(self):
        self.fields["source_state_reported"] = "RUNNING"
        self.write_manifest()
        with self.assertRaises(a.Blocked):
            self.admit()

    def test_invalid_capture_ids_denied(self):
        for name in ("", "../", "A"*32, "b"*33):
            with self.subTest(name=name), self.assertRaises(a.Blocked):
                a.admission(self.sfd, self.vfd, os.getuid(), name, self.sha, promote=False)

    def test_manifest_publish_failure_rolls_back_final_cipher(self):
        original = os.link
        calls = [0]
        def second_link_fails(*args, **kwargs):
            calls[0] += 1
            if calls[0] == 2:
                raise OSError("simulated manifest publication failure")
            return original(*args, **kwargs)
        with patch.object(a, "check_space", return_value=None):
            with patch.object(a.os, "link", side_effect=second_link_fails):
                with self.assertRaisesRegex(OSError, "publication failure"):
                    self.admit(commit=True)
        self.assertEqual(calls[0], 2)
        self.assertEqual(list(self.vault.iterdir()), [])
        self.assertEqual(self.source.read_bytes(), CIPHER)

    def test_insufficient_vault_headroom_prevents_any_write(self):
        with patch.object(a, "check_space", side_effect=a.Blocked("NO_HEADROOM")):
            with self.assertRaisesRegex(a.Blocked, "NO_HEADROOM"):
                self.admit(commit=True)
        self.assertEqual(list(self.vault.iterdir()), [])

    def test_always_blocks_false_release_credit(self):
        s = src.read_text()
        for m in ("CALLER_PIN_PROVENANCE=NOT_INDEPENDENTLY_ATTESTED",
                  "SPOOL_CIPHERTEXT_AND_CALLER_PIN_SHA256=PASS_LOCAL_HASH_ONLY",
                  "N2_CIPHERTEXT_DECRYPTION=NOT_ATTEMPTED",
                  "N2_SOURCE_DISK_COMPLETENESS=NOT_INDEPENDENTLY_ATTESTED",
                  "N2_INDEPENDENT_BOOTED_RESTORE=NOT_VERIFIED",
                  "CLOUDOS_PRODUCTION_RELEASE=BLOCKED"):
            self.assertIn(m, s)
        for denied in ("gcloud compute", "shell=True", "AGE-SECRET-KEY-"):
            self.assertNotIn(denied, s)

if __name__ == "__main__":
    unittest.main()
