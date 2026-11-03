#!/usr/bin/env python3
"""Offline safety tests. Never make a real SSH, GCE metadata, or SFTP call."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / "scripts/operations" /
          "kmj_cloudos_relay_elite_sftp_auth_smoke_20261103.py")
spec = importlib.util.spec_from_file_location("kmj_relay_sftp_smoke", SOURCE)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


class ReadOnlySftpSmokeTests(unittest.TestCase):
    def setUp(self):
        raw = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
        self.scan = (mod.ELITE_IP + " ssh-ed25519 " +
                     base64.b64encode(raw).decode() + "\n").encode()
        self.fingerprint = "SHA256:" + base64.b64encode(
            hashlib.sha256(raw).digest()).decode().rstrip("=")

    def test_pinned_key_mismatch_refuses_before_login(self):
        with patch.object(mod, "run",
                          return_value=subprocess.CompletedProcess(
                              args=[], returncode=0, stdout=self.scan,
                              stderr=b"")):
            with self.assertRaisesRegex(
                    mod.Blocked, "ELITE_ED25519_HOST_KEY_PIN_MISMATCH"):
                mod.pin_remote_host()

    def test_malformed_scan_refuses(self):
        for raw in (b"", self.scan + self.scan,
                    self.scan.replace(mod.ELITE_IP.encode(), b"8.8.8.8"),
                    self.scan.replace(b"ssh-ed25519", b"ssh-rsa")):
            with patch.object(mod, "run",
                              return_value=subprocess.CompletedProcess(
                                  args=[], returncode=0, stdout=raw,
                                  stderr=b"")):
                with self.assertRaises(mod.Blocked):
                    mod.pin_remote_host()

    def test_successful_readonly_sftp_transcript_not_writes(self):
        captured = {}

        def fake_run(argv, *, stdin=None, timeout=0):
            captured["argv"] = argv
            captured["stdin"] = stdin
            captured["timeout"] = timeout
            hosts = [x for x in argv if
                     x.startswith("UserKnownHostsFile=")]
            self.assertEqual(len(hosts), 1)
            pin = hosts[0].split("=", 1)[1]
            self.assertEqual(Path(pin).read_bytes(), self.scan)
            return subprocess.CompletedProcess(
                args=argv, returncode=0,
                stdout=b"Remote working directory: /incoming\n",
                stderr=b"",
            )

        with patch.object(mod, "run", side_effect=fake_run):
            mod.actual_sftp(Path("/fake/private/local-only"), self.scan)
        self.assertEqual(captured["stdin"], b"pwd\nls /incoming\n")
        self.assertEqual(captured["argv"][0], mod.SFTP)
        self.assertIn("BatchMode=yes", captured["argv"])
        self.assertIn("StrictHostKeyChecking=yes", captured["argv"])
        self.assertIn("PasswordAuthentication=no", captured["argv"])
        self.assertIn("IdentityAgent=none", captured["argv"])
        self.assertIn("HostKeyAlgorithms=ssh-ed25519", captured["argv"])
        self.assertIn("-b", captured["argv"])
        self.assertIn("kmjcloudosbackup@103.212.136.154", captured["argv"])
        self.assertLessEqual(captured["timeout"], 30)
        self.assertFalse(any(
            x in captured["stdin"] for x in (b"put", b"rm ", b"mkdir",
                                             b"rename", b"rmdir")))

    def test_failed_authentication_is_never_mislabeled_pass(self):
        with patch.object(mod, "run", return_value=subprocess.CompletedProcess(
                args=[], returncode=255, stdout=b"", stderr=b"private diagnostic")):
            with self.assertRaisesRegex(
                    mod.Blocked, "RELAY_TO_ELITE_SFTP_AUTH_OR_READ_FAILED"):
                mod.actual_sftp(Path("/local/private"), self.scan)

    def test_missing_remote_pwd_proof_refuses(self):
        with patch.object(mod, "run", return_value=subprocess.CompletedProcess(
                args=[], returncode=0, stdout=b"", stderr=b"")):
            with self.assertRaisesRegex(mod.Blocked, "SFTP_PWD_PROOF_ABSENT"):
                mod.actual_sftp(Path("/local/private"), self.scan)


if __name__ == "__main__":
    unittest.main(verbosity=2)
