#!/usr/bin/env python3
"""Simulated canary lifecycle only; never uses real network or credentials."""
import importlib.util
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / "scripts/operations" /
          "kmj_cloudos_relay_sftp_bounded_canary_20261103.py")
spec = importlib.util.spec_from_file_location("kmj_relay_canary", SOURCE)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


def response(code=0):
    return SimpleNamespace(returncode=code, stdout=b"", stderr=b"")


class CanaryLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.commands = []
        self.remote_dir = None
        self.remote_file = None
        self.canary_bytes = None
        self.deleted = False
        self.corrupt = False
        self.cleanup_denied = False
        self.smoke = SimpleNamespace(SFTP="/usr/bin/sftp", ELITE_IP="elite-ssh.kmjtechno.com",
                                     UPLOADER="kmjcloudosbackup")

    def fake_sftp(self, smoke, argv, batch, timeout=28):
        self.commands.append(batch)
        self.assertEqual(argv[0], "/usr/bin/sftp")
        self.assertIn("StrictHostKeyChecking=yes", argv)
        self.assertIn("PasswordAuthentication=no", argv)
        self.assertIn("IdentityAgent=none", argv)
        self.assertIn("BatchMode=yes", argv)
        self.assertLessEqual(timeout, 30)
        p = batch.strip().split(" ")
        action = p[0]
        if action == "mkdir":
            self.remote_dir = p[1]
            self.assertTrue(self.remote_dir.startswith("/incoming/.kmj-cloudos-relay-canary-"))
            self.assertEqual(len(self.remote_dir.split("-")[-1]), 32)
            return response()
        if action == "put":
            self.remote_file = p[2]
            self.assertEqual(self.remote_file, self.remote_dir + "/canary.bin")
            self.canary_bytes = Path(p[1]).read_bytes()
            self.assertLessEqual(len(self.canary_bytes), 96)
            return response()
        if action == "get":
            self.assertEqual(p[1], self.remote_file)
            data = self.canary_bytes + (b"x" if self.corrupt else b"")
            Path(p[2]).write_bytes(data)
            return response()
        if action == "rm":
            self.assertEqual(p[1], self.remote_dir + "/canary.bin")
            if self.cleanup_denied or self.remote_file is None:
                # Upload never happened: removing absent file may fail,
                # but successful rmdir + missing dir still prove cleanup.
                return response(1)
            self.deleted = True
            return response()
        if action == "rmdir":
            self.assertEqual(p[1], self.remote_dir)
            return response(1 if self.cleanup_denied else 0)
        if action == "ls":
            self.assertEqual(p[1], self.remote_dir)
            return response(0 if self.cleanup_denied else 1)
        raise AssertionError("UNEXPECTED_REMOTE_COMMAND=" + action)

    def test_bounded_canary_roundtrip_and_cleanup(self):
        with patch.object(mod, "sftp", side_effect=self.fake_sftp):
            mod.canary(self.smoke, Path("/private/never-read-by-test"),
                       b"elite-ssh.kmjtechno.com ssh-ed25519 pinnedpublic\n")
        self.assertEqual(len(self.commands), 6)
        self.assertEqual([x.split(" ")[0] for x in self.commands],
                         ["mkdir", "put", "get", "rm", "rmdir", "ls"])
        self.assertTrue(self.deleted)

    def test_failed_hash_still_cleans_up_and_fails_closed(self):
        self.corrupt = True
        with patch.object(mod, "sftp", side_effect=self.fake_sftp):
            with self.assertRaisesRegex(mod.Blocked,
                                        "CANARY_TRANSFER_OR_REMOTE_OPERATION_FAILED"):
                mod.canary(self.smoke, Path("/private/local"),
                           b"elite-ssh.kmjtechno.com ssh-ed25519 pin\n")
        self.assertTrue(self.deleted)
        self.assertEqual(len(self.commands), 6)

    def test_cleanup_connection_exception_preserves_manual_review_gate(self):
        original = self.fake_sftp

        def interrupted(smoke, argv, batch, timeout=28):
            if batch.startswith("rm "):
                raise mod.Blocked("TEST_REMOTE_TIMEOUT")
            return original(smoke, argv, batch, timeout=timeout)

        with patch.object(mod, "sftp", side_effect=interrupted):
            with self.assertRaisesRegex(
                    mod.Blocked, "REMOTE_CANARY_CLEANUP_REQUIRES_REVIEW"):
                mod.canary(self.smoke, Path("/private/local"),
                           b"elite-ssh.kmjtechno.com ssh-ed25519 pin\\n")

    def test_companion_specific_exception_on_upload_triggers_cleanup(self):
        class CompanionBlocked(RuntimeError):
            pass
        original = self.fake_sftp

        def disconnected(smoke, argv, batch, timeout=28):
            if batch.startswith("put "):
                raise CompanionBlocked("private SSH timeout")
            return original(smoke, argv, batch, timeout=timeout)

        with patch.object(mod, "sftp", side_effect=disconnected):
            with self.assertRaisesRegex(
                    mod.Blocked, "CANARY_TRANSFER_OR_REMOTE_OPERATION_FAILED"):
                mod.canary(self.smoke, Path("/private/local"),
                           b"elite-ssh.kmjtechno.com ssh-ed25519 pin\\n")
        self.assertIn("rmdir", [x.split(" ")[0] for x in self.commands])
        self.assertIn("ls", [x.split(" ")[0] for x in self.commands])

    def test_companion_specific_exception_during_cleanup_reports_path(self):
        class CompanionBlocked(RuntimeError):
            pass
        original = self.fake_sftp

        def disconnected(smoke, argv, batch, timeout=28):
            if batch.startswith("rm "):
                raise CompanionBlocked("private SSH timeout")
            return original(smoke, argv, batch, timeout=timeout)

        with patch.object(mod, "sftp", side_effect=disconnected):
            with self.assertRaisesRegex(
                    mod.Blocked, "REMOTE_CANARY_CLEANUP_REQUIRES_REVIEW"):
                mod.canary(self.smoke, Path("/private/local"),
                           b"elite-ssh.kmjtechno.com ssh-ed25519 pin\\n")

    def test_cleanup_failure_requires_review(self):
        self.cleanup_denied = True
        with patch.object(mod, "sftp", side_effect=self.fake_sftp):
            with self.assertRaisesRegex(mod.Blocked,
                                        "REMOTE_CANARY_CLEANUP_REQUIRES_REVIEW"):
                mod.canary(self.smoke, Path("/private/local"),
                           b"elite-ssh.kmjtechno.com ssh-ed25519 pin\n")
        self.assertFalse(self.deleted)


if __name__ == "__main__":
    unittest.main(verbosity=2)
