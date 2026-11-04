"""Offline N2 archive integrity tests: no privileged paths or cloud calls."""
import hashlib
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

S = (Path(__file__).resolve().parents[1] / "scripts" / "operations" /
     "kmj_elite_cloudos_n2_cold_archive_integrity_20261104.py")
spec = importlib.util.spec_from_file_location("kmj_n2_cipher", S)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
CAPTURE = "a" * 32
NAME = "n2-cold-" + CAPTURE + ".json"
DATA = b"age-encryption.org/v1\n" + b"synthetic-nonsecret-test-data" * 12


def good():
    return {
        "schema": mod.SCHEMA,
        "capture_id": CAPTURE,
        "project": mod.SOURCE_PROJECT,
        "zone": mod.SOURCE_ZONE,
        "instance": mod.SOURCE_INSTANCE,
        "source_disk_bytes": 30 * 1024**3,
        "captured_at_utc": "2026-11-04T01:02:03Z",
        "capture_method": "cold-block-read",
        "source_state_reported": "TERMINATED",
        "age_recipient_sha256": mod.RECIPIENT_SHA,
        "source_disk_sha256": "b" * 64,
        "ciphertext_bytes": len(DATA),
        "ciphertext_sha256": hashlib.sha256(DATA).hexdigest(),
    }


def parse(d, name=NAME):
    return mod.parse_manifest(
        json.dumps(d).encode(),
        name,
        now=datetime(2026, 11, 4, 23, 59, tzinfo=timezone.utc),
    )


class TestColdN2Cipher(unittest.TestCase):
    def test_valid_exact_policy(self):
        self.assertEqual(parse(good())["capture_id"], CAPTURE)

    def test_wrong_identity_or_stopped_claim(self):
        for key, wrong in (
            ("schema", "v2"),
            ("project", "untrusted"),
            ("zone", "other"),
            ("instance", "other"),
            ("capture_method", "live-vm"),
            ("source_state_reported", "RUNNING"),
            ("age_recipient_sha256", "0" * 64),
        ):
            with self.subTest(key=key):
                d = good()
                d[key] = wrong
                with self.assertRaises(mod.Blocked):
                    parse(d)

    def test_reject_bool_numeric_and_invalid_sizes(self):
        for key, wrong in (
            ("source_disk_bytes", True),
            ("source_disk_bytes", 32),
            ("ciphertext_bytes", "321"),
            ("ciphertext_bytes", False),
            ("ciphertext_bytes", 0),
            ("ciphertext_sha256", "wrong"),
            ("source_disk_sha256", "wrong"),
            ("source_disk_sha256", True),
        ):
            with self.subTest(key=key):
                d = good()
                d[key] = wrong
                with self.assertRaises(mod.Blocked):
                    parse(d)

    def test_timestamp_fail_closed(self):
        for stamp in (
            "",
            "2039-01-01T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-11-04 01:02:03",
        ):
            with self.subTest(stamp=stamp):
                d = good()
                d["captured_at_utc"] = stamp
                with self.assertRaises(mod.Blocked):
                    parse(d)

    def test_duplicate_fields_bad_names_and_extra(self):
        with self.assertRaises(mod.Blocked):
            parse(good(), "n2-cold-" + "b" * 32 + ".json")
        with self.assertRaises(mod.Blocked):
            mod.parse_manifest(
                (json.dumps(good())[:-1] + ',"schema":"v2"}').encode(),
                NAME,
            )
        d = good()
        d["extra"] = "untrusted"
        with self.assertRaises(mod.Blocked):
            parse(d)

    def test_cipher_exact_hash_and_magic(self):
        with tempfile.TemporaryFile() as f:
            f.write(DATA)
            f.seek(0)
            mod.verify_cipher(f.fileno(), len(DATA), hashlib.sha256(DATA).hexdigest())
            f.seek(0)
            with self.assertRaises(mod.Blocked):
                mod.verify_cipher(f.fileno(), len(DATA), "0" * 64)
            f.seek(0)
            f.write(b"wrong!")
            f.seek(0)
            with self.assertRaises(mod.Blocked):
                mod.verify_cipher(f.fileno(), len(DATA), hashlib.sha256(DATA).hexdigest())

    def test_cipher_truncated(self):
        with tempfile.TemporaryFile() as f:
            f.write(DATA)
            f.seek(0)
            with self.assertRaises(mod.Blocked):
                mod.verify_cipher(f.fileno(), len(DATA) + 1, hashlib.sha256(DATA).hexdigest())

    def test_no_release_credit_or_host_mutations(self):
        src = S.read_text()
        for line in (
            "N2_SOURCE_TERMINATION=NOT_INDEPENDENTLY_ATTESTED",
            "N2_SOURCE_DISK_COMPLETENESS=NOT_INDEPENDENTLY_ATTESTED",
            "N2_INDEPENDENT_DISPOSABLE_BOOT_RESTORE=NOT_VERIFIED",
            "CLOUDOS_PRODUCTION_RELEASE=BLOCKED",
        ):
            self.assertIn(line, src)
        for unsafe in ("subprocess.", "shell=True", "gcloud compute", "AGE-SECRET-KEY-"):
            self.assertNotIn(unsafe, src)


if __name__ == "__main__":
    unittest.main()
