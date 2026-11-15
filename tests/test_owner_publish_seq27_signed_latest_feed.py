"""Offline V1 signed latest-feed negative and isolated atomic publication tests.

No production root, network, secrets, systemd, gateway, backup or signer called.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest import mock

SRC=Path(__file__).resolve().parents[1]/"scripts/production/owner_publish_seq27_signed_latest_feed_20261115.py"
spec=importlib.util.spec_from_file_location("kmj_fixed_signed_latest_feed",SRC)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

REPO=Path(__file__).resolve().parents[1]
MANIFEST=REPO/"releases/stable"/m.REV/"release-manifest.json"
SIGNATURE=REPO/"releases/stable"/m.REV/"release-manifest.sig"

class SignedLatestOfflineTests(unittest.TestCase):
    def test_real_seq27_manifest_has_pinned_bytes(self):
        blob=MANIFEST.read_bytes()
        m.validate_manifest(blob)
        self.assertEqual(len(blob),512)

    def test_any_changed_manifest_byte_rejected(self):
        original=MANIFEST.read_bytes()
        for bad in (original+b" ",original[:-1],original.replace(b'"sequence": 27',b'"sequence": 28')):
            with self.subTest(size=len(bad)),self.assertRaisesRegex(m.Block,"SIGNED27_MANIFEST_SHA_MISMATCH"):
                m.validate_manifest(bad)

    def test_wrong_signature_shape_fails_before_node_execution(self):
        with mock.patch.object(m,"run") as run:
            with self.assertRaisesRegex(m.Block,"SIGNED27_SIGNATURE_FORMAT"):
                m.verify_signature(MANIFEST.read_bytes(),b"bad-sig", "invalid")
            run.assert_not_called()

    def test_owner_only_arg_forms_are_fixed(self):
        with self.assertRaisesRegex(m.Block,"UNEXPECTED_ARGUMENTS"):
            m.main(["--apply","--no-signatures"])
        with self.assertRaisesRegex(m.Block,"UNEXPECTED_ARGUMENTS"):
            m.main(["--url","https://attacker.example"])

    def test_untrusted_external_url_never_fetched(self):
        with self.assertRaisesRegex(m.Block,"PUBLIC_URL_NOT_PINNED"):
            m.https_exact("https://attacker.example/latest/manifest",b"test")

    def test_public_archive_must_match_exact_sha_and_size(self):
        with mock.patch.object(m,"run",return_value=b"wrong-content"):
            with self.assertRaisesRegex(m.Block,"PUBLIC_IMMUTABLE_ARCHIVE_HASH_MISMATCH"):
                m.https_archive_verified()

    def test_signed_feed_has_two_files_only_and_no_config_edit_api(self):
        source=SRC.read_text()
        self.assertNotIn("systemctl",source)
        self.assertNotIn("shell=True",source)
        self.assertNotIn("git pull",source)
        self.assertNotIn("rm -rf",source)
        self.assertIn("RENAME_NOREPLACE",source)
        self.assertIn("OWNER_ED25519_AND_ARCHIVE_PASS",source)
        self.assertIn("AUTO_UPDATE_TIMER=UNCHANGED",source)

    def test_existing_symlink_feed_refused(self):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d)
            (base/"elsewhere").mkdir()
            (base/"latest").symlink_to(base/"elsewhere",target_is_directory=True)
            with mock.patch.object(m,"DEST",base/"latest"),mock.patch.object(m,"ancestry"):
                with self.assertRaisesRegex(m.Block,"EXISTING_FEED_UNTRUSTED"):
                    m.check_existing({"release-manifest.json":b"ok"})

    @unittest.skipUnless(os.name=="posix" and hasattr(os,"O_DIRECTORY"),"Linux only")
    def test_atomic_noreplace_does_not_overwrite_existing_feed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/"existing").mkdir()
            (root/"latest").mkdir()
            fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
            try:
                with self.assertRaisesRegex(m.Block,"ATOMIC_NOREPLACE_FAILED"):
                    m.rename_noreplace(fd,"existing")
                self.assertTrue((root/"latest").is_dir())
                self.assertTrue((root/"existing").is_dir())
            finally:os.close(fd)

    @unittest.skipUnless(os.name=="posix" and hasattr(os,"O_DIRECTORY"),"Linux only")
    def test_disposable_atomic_commit_only_with_absent_destination(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/"staged").mkdir()
            (root/"staged"/"release-manifest.json").write_bytes(b"manifest")
            fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
            try:
                m.rename_noreplace(fd,"staged")
                self.assertFalse((root/"staged").exists())
                self.assertEqual((root/"latest"/"release-manifest.json").read_bytes(),b"manifest")
            finally:os.close(fd)

    @unittest.skipUnless(os.name=="posix" and hasattr(os,"O_DIRECTORY"),"Linux only")
    def test_disposable_publish_never_replaces_prior_pair(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            blobs={"release-manifest.json":b"fixture-manifest",
                   "release-manifest.sig":b"fixture-signature"}
            original_fstat=m.os.fstat
            def rooted_stat(fd):
                x=original_fstat(fd)
                return type("PinnedRootStat",(),{"st_uid":0,"st_mode":x.st_mode})()
            with mock.patch.object(m,"ROOT",root),mock.patch.object(m,"DEST",root/"latest"),\
                 mock.patch.object(m,"ancestry"),\
                 mock.patch.object(m,"read_owned",side_effect=lambda path,limit:Path(path).read_bytes()),\
                 mock.patch.object(m.os,"fstat",side_effect=rooted_stat):
                m.create_feed(blobs)
                self.assertEqual({k:(root/"latest"/k).read_bytes() for k in blobs},blobs)
                with self.assertRaisesRegex(m.Block,"EXISTING_FEED_REVIEW_REQUIRED"):
                    m.create_feed(blobs)
                self.assertEqual({k:(root/"latest"/k).read_bytes() for k in blobs},blobs)

if __name__=="__main__":
    unittest.main()
