#!/usr/bin/env python3
"""Offline end-to-end mock coverage: no network or real relay credential."""
import importlib.util
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / "scripts/operations" /
          "kmj_cloudos_relay_sftp_restrictions_negative_20261103.py")
spec = importlib.util.spec_from_file_location("kmj_sftp_negative", SOURCE)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


def result(rc, stdout=b"", stderr=b""):
    return SimpleNamespace(returncode=rc, stdout=stdout, stderr=stderr)


class NegativeSFTPTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.smoke = SimpleNamespace(
            SFTP="/usr/bin/sftp",
            read_local_identity=lambda: Path("/private/local-only"),
            pin_remote_host=lambda: b"103.212.136.154 ssh-ed25519 testpin\n",
            actual_sftp=lambda private, host: self.calls.append(("positive", host)),
            run=self.run,
        )

    def run(self, argv, *, stdin=None, timeout=0):
        self.calls.append((argv, stdin, timeout))
        if argv[0] == "/usr/bin/sftp":
            return result(1, b"Remote working directory: /incoming\n",
                          b"File not found")
        if "-W" in argv:
            return result(255, b"",
                          b"channel 0: open failed: administratively prohibited: open failed")
        return result(255, b"", b"only internal-sftp forced")

    def test_positive_control_before_negative_and_only_read_operations(self):
        with patch.object(mod, "load_pinned_smoke", return_value=self.smoke):
            mod.test()
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.calls[0][0], "positive")
        shell_args = self.calls[1][0]
        self.assertEqual(shell_args[0], "/usr/bin/ssh")
        self.assertIn("-T", shell_args)
        self.assertIn("StrictHostKeyChecking=yes", shell_args)
        self.assertIn("PasswordAuthentication=no", shell_args)
        self.assertIn("IdentityAgent=none", shell_args)
        forward_args = self.calls[2][0]
        self.assertIn("-W", forward_args)
        self.assertIn("127.0.0.1:22", forward_args)
        batch_args, batch_input, timeout = self.calls[3]
        self.assertEqual(batch_args[0], "/usr/bin/sftp")
        self.assertEqual(batch_input, b"pwd\nls /etc\n")
        self.assertLessEqual(timeout, 30)
        self.assertNotIn(b"put", batch_input)
        self.assertNotIn(b"rm ", batch_input)

    def test_if_forwarding_appears_allowed_report_blocked(self):
        original = self.smoke.run

        def run(argv, *, stdin=None, timeout=0):
            if "-W" in argv:
                return result(255, b"SSH-2.0-OpenSSH_9.6\n")
            return original(argv, stdin=stdin, timeout=timeout)

        self.smoke.run = run
        with patch.object(mod, "load_pinned_smoke", return_value=self.smoke):
            with self.assertRaisesRegex(
                    mod.Blocked, "RESTRICTED_UPLOADER_DIRECT_TCPIP_FORWARD_WAS_ALLOWED"):
                mod.test()

    def test_if_shell_marker_emitted_report_blocked(self):
        original = self.smoke.run

        def run(argv, *, stdin=None, timeout=0):
            if "-W" not in argv and argv[0] == "/usr/bin/ssh":
                return result(0, mod.SENTINEL)
            return original(argv, stdin=stdin, timeout=timeout)

        self.smoke.run = run
        with patch.object(mod, "load_pinned_smoke", return_value=self.smoke):
            with self.assertRaisesRegex(
                    mod.Blocked, "RESTRICTED_UPLOADER_SHELL_WAS_EXECUTED"):
                mod.test()

    def test_if_chroot_outside_listable_report_blocked(self):
        original = self.smoke.run

        def run(argv, *, stdin=None, timeout=0):
            if argv[0] == "/usr/bin/sftp":
                return result(0, b"Remote working directory: /incoming\n/etc\n")
            return original(argv, stdin=stdin, timeout=timeout)

        self.smoke.run = run
        with patch.object(mod, "load_pinned_smoke", return_value=self.smoke):
            with self.assertRaisesRegex(
                    mod.Blocked, "SFTP_OUTSIDE_CHROOT_PATH_WAS_LISTABLE"):
                mod.test()


if __name__ == "__main__":
    unittest.main(verbosity=2)
