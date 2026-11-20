"""Hermetic, no-root source verification for the Elite one-host signer installer."""
import hashlib
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/production/owner_install_elite_onehost_signer_20261120.py"
spec = importlib.util.spec_from_file_location("elite_onehost_installer", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SourceOnly(unittest.TestCase):
    def test_installer_pins_match_current_reviewer_sources(self):
        for name, (source, expected) in m.PINNED.items():
            with self.subTest(file=name):
                self.assertTrue(source.is_file())
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),
                                 expected)

    def test_reviewed_source_bytes_and_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "trusted.py"
            body = b"reviewed source script" * 50
            p.write_bytes(body)
            self.assertEqual(
                m.verified_bytes(p, hashlib.sha256(body).hexdigest()), body
            )

    def test_modified_blob_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "trusted.py"
            p.write_bytes(b"A" * 1100)
            with self.assertRaisesRegex(m.Blocked, "SOURCE_SHA_MISMATCH"):
                m.verified_bytes(p, hashlib.sha256(b"B" * 1100).hexdigest())

    def test_symlink_rejected_without_following(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            p = parent / "real"
            p.write_bytes(b"A" * 1024)
            link = parent / "alias"
            link.symlink_to(p)
            with self.assertRaises(OSError):
                m.verified_bytes(link, hashlib.sha256(p.read_bytes()).hexdigest())

    def test_exact_owner_apply_arguments(self):
        with patch.object(m.os, "geteuid", return_value=1000):
            with self.assertRaisesRegex(m.Blocked, "ROOT_ELITE_ONLY"):
                m.main([])
        with self.assertRaisesRegex(m.Blocked, "ARGUMENTS_REJECTED"):
            m.main(["--apply"])
        with self.assertRaisesRegex(m.Blocked, "ARGUMENTS_REJECTED"):
            m.main(["--disable", "--confirm-elite-nonroot-signer-owner-go"])

    def test_installer_does_not_import_private_key_or_restart_unit(self):
        text = SOURCE.read_text("utf-8")
        self.assertIn("owner-auto-sign-stable.mjs", text)
        self.assertIn("elite-onehost-release.mjs", text)
        self.assertIn("release-ci-gate.mjs", text)
        self.assertNotIn("systemctl", text)
        self.assertNotIn("ssh-keygen", text)
        self.assertNotIn("PRIVATE KEY-----", text)
        self.assertIn("OWNER_PRIVATE_KEY=NOT_READ_OR_MOVED", text)
        self.assertIn("ELITE_SIGNER_INSTALL=DRY_RUN_NO_CHANGES", text)

    def test_file_manifest_names_are_only_three_approved_names(self):
        self.assertEqual(
            {parts[1] for parts in m.PINNED},
            {"owner-auto-sign-stable.mjs", "elite-onehost-release.mjs",
             "release-ci-gate.mjs"},
        )
        self.assertTrue(all(len(pin) == 64 for _, pin in m.PINNED.values()))


if __name__ == "__main__":
    unittest.main()
