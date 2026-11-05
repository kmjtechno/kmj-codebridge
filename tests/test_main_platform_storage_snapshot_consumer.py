"""Behavior tests for the controller's protected snapshot consumer."""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

controller_path = Path(__file__).resolve().parents[1] / "scripts/production/activate-main-platform-approved.py"
if not controller_path.is_file():
    controller_path = Path(__file__).with_name("controller.py")
spec = importlib.util.spec_from_file_location("snapshot_controller", controller_path)
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)


class Rejected(Exception):
    pass


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.release = Path(self.tmp.name) / "release"
        self.app = self.release / "apps/platform"
        self.app.mkdir(parents=True)
        self.helper = types.SimpleNamespace(NAME=re.compile(r"storage\.pre-shared-\d{8}T\d{6}Z\Z"),
                                            Rejected=Rejected, check_source=Mock(),
                                            git_identity=Mock(), git_read=Mock(return_value=b""))
        self.loader = patch.object(ctl, "load_snapshot_attestor", return_value=self.helper)
        self.loader.start()
        self.addCleanup(self.loader.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_ordinary_source_uses_unprivileged_helper_git(self):
        ctl.verify_candidate_source(self.release, "a" * 40)
        self.helper.git_identity.assert_called_once_with(self.release, "a" * 40)
        args, kwargs = self.helper.git_read.call_args
        self.assertIn("-z", args)
        self.assertIn(":(exclude)apps/platform/storage", args)
        self.assertFalse(kwargs["text"])
        self.helper.check_source.assert_not_called()

    def test_ordinary_dirt_still_blocks(self):
        self.helper.git_read.return_value = b"?? apps/platform/other\0"
        with self.assertRaisesRegex(RuntimeError, "CANDIDATE_DIRTY"):
            ctl.verify_candidate_source(self.release, "a" * 40)

    def snapshot(self, name="storage.pre-shared-20261105T091800Z"):
        (self.app / name).mkdir()
        return name

    def test_snapshot_passes_exact_identity_to_attestor(self):
        name = self.snapshot()
        ctl.verify_candidate_source(self.release, "a" * 40)
        self.helper.git_read.assert_not_called()
        self.helper.git_identity.assert_not_called()
        self.assertEqual(self.helper.check_source.call_args.kwargs, dict(
            release_root=str(self.release), app_dir=str(self.app), expected_sha="a" * 40,
            shared_dir=str(ctl.SHARED_STORAGE), snapshot_name=name,
            state_dir=str(ctl.SNAPSHOT_STATE), scanner_path=str(ctl.SNAPSHOT_SCANNER)))

    def test_snapshot_does_not_override_other_source_changes(self):
        self.snapshot()
        self.helper.check_source.side_effect = Rejected("other_source_changes")
        with self.assertRaisesRegex(RuntimeError, "CANDIDATE_DIRTY"):
            ctl.verify_candidate_source(self.release, "a" * 40)

    def test_wrong_sha_preserves_sha_gate(self):
        self.helper.git_identity.side_effect = Rejected("wrong_candidate_sha")
        with self.assertRaisesRegex(RuntimeError, "CANDIDATE_SHA_MISMATCH"):
            ctl.verify_candidate_source(self.release, "a" * 40)

    def test_missing_receipt_blocks(self):
        self.snapshot()
        self.helper.check_source.side_effect = Rejected("missing_or_ambiguous_receipt")
        with self.assertRaisesRegex(RuntimeError, "CANDIDATE_SNAPSHOT_UNVERIFIED"):
            ctl.verify_candidate_source(self.release, "a" * 40)

    def test_extra_or_malformed_snapshot_blocks_before_attestation(self):
        for names in [("storage.pre-shared-invalid",),
                      ("storage.pre-shared-20261105T091800Z", "storage.pre-shared-20261105T091801Z")]:
            with self.subTest(names=names):
                for name in names:
                    self.snapshot(name)
                with self.assertRaisesRegex(RuntimeError, "CANDIDATE_SNAPSHOT_AMBIGUOUS"):
                    ctl.verify_candidate_source(self.release, "a" * 40)
                self.helper.check_source.assert_not_called()
                for name in names:
                    (self.app / name).rmdir()

    def test_missing_dependency_has_no_legacy_git_fallback(self):
        self.loader.stop()
        with patch.object(ctl, "load_snapshot_attestor", side_effect=FileNotFoundError), \
                patch.object(ctl, "run") as legacy:
            with self.assertRaises(FileNotFoundError):
                ctl.verify_candidate_source(self.release, "a" * 40)
            legacy.assert_not_called()


class DependencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "protected.py"
        self.path.write_bytes(b"trusted bytes\n")
        self.path.chmod(0o600)
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.uid = patch.object(ctl, "SNAPSHOT_INSTALL_UID", os.getuid())
        self.uid.start()
        self.addCleanup(self.uid.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_exact_protected_bytes_accepted(self):
        self.assertEqual(ctl.protected_snapshot_bytes(self.path, self.digest), b"trusted bytes\n")

    def test_changed_bytes_rejected(self):
        self.path.write_bytes(b"different bytes\n")
        with self.assertRaisesRegex(RuntimeError, "HASH_MISMATCH"):
            ctl.protected_snapshot_bytes(self.path, self.digest)

    def test_writable_dependency_rejected(self):
        self.path.chmod(0o666)
        with self.assertRaisesRegex(RuntimeError, "DEPENDENCY_UNSAFE"):
            ctl.protected_snapshot_bytes(self.path, self.digest)

    def test_symlink_dependency_rejected(self):
        other = self.path.with_name("other.py")
        self.path.rename(other)
        self.path.symlink_to(other)
        with self.assertRaisesRegex(RuntimeError, "PATH_UNSAFE"):
            ctl.protected_snapshot_bytes(self.path, self.digest)

    def test_hardlinked_dependency_rejected(self):
        os.link(self.path, self.path.with_name("alias.py"))
        with self.assertRaisesRegex(RuntimeError, "DEPENDENCY_UNSAFE"):
            ctl.protected_snapshot_bytes(self.path, self.digest)


if __name__ == "__main__":
    unittest.main()
