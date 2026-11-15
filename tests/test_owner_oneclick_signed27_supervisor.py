"""Offline negative fixtures for the owner-approved, idempotent Seq27 one-click gate.

These tests never execute owner hardware, systemctl, socket RPCs, gateway
restarts, backup writes or external service commands.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/production/owner_oneclick_signed27_supervisor.py"
spec = importlib.util.spec_from_file_location("owner_oneclick_signed27", SOURCE)
one = importlib.util.module_from_spec(spec)
spec.loader.exec_module(one)


def valid_gateway():
    return {
        "LoadState": "loaded",
        "ActiveState": "active",
        "NeedDaemonReload": "no",
        "WorkingDirectory": str(one.RELEASE),
        "MainPID": "555",
        "ExecStart": "",
    }


class OneClickGateTests(unittest.TestCase):
    def test_only_fixed_cli_modes(self):
        for args in (["--apply"], ["--rollback"], ["--force"],
                     ["--apply", one.CONFIRM, "--force"]):
            with self.subTest(args=args), self.assertRaises(one.Blocked):
                one.run(args)

    def test_exact_owner_go_schema(self):
        code = b"#!/usr/bin/env python3\nprint('fixture only')\n"
        policy = {"schema": 1, "profile": "signed27-supervisor",
                  "revision": one.REVISION,
                  "helperSha256": hashlib.sha256(code).hexdigest(),
                  "ownerGo": True}
        with patch.object(one, "pinned_read",
                          side_effect=[json.dumps(policy).encode(), code]):
            self.assertEqual(one.approved_helper(), policy["helperSha256"])
        for key, value in (("ownerGo", False), ("profile", "other"),
                           ("revision", "a" * 40), ("helperSha256", "bad")):
            wrong = dict(policy)
            wrong[key] = value
            with self.subTest(key=key), patch.object(
                    one, "pinned_read", return_value=json.dumps(wrong).encode()):
                with self.assertRaises(one.Blocked):
                    one.approved_helper()
        wrong = dict(policy, shell="/bin/bash")
        with patch.object(one, "pinned_read",
                          return_value=json.dumps(wrong).encode()):
            with self.assertRaises(one.Blocked):
                one.approved_helper()

    def test_helper_tamper_denied(self):
        policy = {"schema": 1, "profile": "signed27-supervisor",
                  "revision": one.REVISION, "helperSha256": "f" * 64, "ownerGo": True}
        with patch.object(one, "pinned_read",
                          side_effect=[json.dumps(policy).encode(),
                                       b"#!/usr/bin/env python3\nmodified\n"]):
            with self.assertRaisesRegex(one.Blocked, "HASH_MISMATCH"):
                one.approved_helper()

    def test_gateway_not_matching_release_denied(self):
        for key, value in (("LoadState", "not-found"),
                           ("ActiveState", "inactive"),
                           ("NeedDaemonReload", "yes"),
                           ("WorkingDirectory", "/unrelated")):
            fields = valid_gateway()
            fields[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(
                    one.Blocked, "GATEWAY_SIGNED27_NOT_READY"):
                one.gateway_ready(fields)

    def test_gateway_pid_and_cwd(self):
        with patch.object(one.Path, "resolve", return_value=one.RELEASE):
            one.gateway_ready(valid_gateway())
        fields = valid_gateway()
        fields["MainPID"] = "0"
        with self.assertRaises(one.Blocked):
            one.gateway_ready(fields)

    def test_helper_exact_modes_receipts_and_no_shell(self):
        def good(args, **_kwargs):
            marker = ("SIGNED27_SUPERVISOR=APPLIED" if "--apply" in args
                      else "SIGNED27_SUPERVISOR=DRY_RUN_UNCHANGED")
            return subprocess.CompletedProcess(args, 0, (marker + "\n").encode(), b"")
        with patch.object(one.subprocess, "run", side_effect=good) as call:
            self.assertEqual(one.run_helper("check"),
                             "SIGNED27_SUPERVISOR=DRY_RUN_UNCHANGED")
            self.assertEqual(one.run_helper("apply"),
                             "SIGNED27_SUPERVISOR=APPLIED")
            self.assertEqual(call.call_args_list[0].args[0],
                             ["/usr/bin/python3", "-I", "-B", str(one.HELPER)])
            self.assertEqual(call.call_args_list[1].args[0][-1], "--apply")
            self.assertTrue(all(not c.kwargs.get("shell", False)
                                for c in call.call_args_list))
        with patch.object(one.subprocess, "run",
                          return_value=subprocess.CompletedProcess(
                              [], 0, b"UNVERIFIED\n", b"")):
            with self.assertRaisesRegex(one.Blocked, "RECEIPT_MISSING"):
                one.run_helper("apply")
        with patch.object(one.subprocess, "run",
                          return_value=subprocess.CompletedProcess(
                              [], 1, b"SIGNED27_SUPERVISOR=APPLIED\n", b"")):
            with self.assertRaisesRegex(one.Blocked, "HELPER_REFUSED"):
                one.run_helper("apply")

    def test_fixed_systemd_allowlist_and_duplicate_rejection(self):
        with self.assertRaisesRegex(one.Blocked, "UNIT_UNEXPECTED"):
            one.systemd("other.service")
        body = ("LoadState=loaded\nActiveState=active\nNeedDaemonReload=no\n"
                "WorkingDirectory=/x\nMainPID=42\nExecStart=opaque\n")
        with patch.object(one.subprocess, "run",
                          return_value=subprocess.CompletedProcess(
                              [], 0, body.encode(), b"")):
            self.assertEqual(one.systemd(one.GATEWAY_UNIT)["MainPID"], "42")
        with patch.object(one.subprocess, "run",
                          return_value=subprocess.CompletedProcess(
                              [], 0, (body + "MainPID=7\n").encode(), b"")):
            with self.assertRaisesRegex(one.Blocked, "DUPLICATE_FIELD"):
                one.systemd(one.GATEWAY_UNIT)

    def test_cryptographic_manifest_hash_prevents_untrusted_key_loading(self):
        with patch.object(one, "pinned_read", return_value=b"BAD"):
            with self.assertRaisesRegex(one.Blocked, "MANIFEST_PIN_MISMATCH"):
                one.verify_signed_release()

    def test_manifest_sequence_and_identity_denied(self):
        info = {"revision": one.REVISION, "channel": "stable",
                "sequence": 26, "keyId": "kmj-release-2026",
                "sha256": one.ARCHIVE_SHA256, "bytes": 2171009}
        raw = json.dumps(info).encode()
        with patch.object(one, "pinned_read",
                          side_effect=[raw, b"sig", b'{"trustedKeys":{}}']), \
             patch.object(one, "MANIFEST_SHA256",
                          hashlib.sha256(raw).hexdigest()):
            with self.assertRaisesRegex(one.Blocked, "MANIFEST_IDENTITY_INVALID"):
                one.verify_signed_release()

    def test_missing_trusted_public_key_denied_before_crypto_execution(self):
        info = {"revision": one.REVISION, "channel": "stable",
                "sequence": 27, "keyId": "kmj-release-2026",
                "sha256": one.ARCHIVE_SHA256, "bytes": 2171009}
        raw = json.dumps(info).encode()
        with patch.object(one, "pinned_read",
                          side_effect=[raw, b"sig", b'{"trustedKeys":{}}']), \
             patch.object(one, "MANIFEST_SHA256",
                          hashlib.sha256(raw).hexdigest()), \
             patch.object(one.subprocess, "run") as runner:
            with self.assertRaisesRegex(one.Blocked, "OWNER_TRUST_KEY_MISSING"):
                one.verify_signed_release()
            runner.assert_not_called()

    def test_missing_override_is_not_applied(self):
        with patch.object(one.os.path, "lexists", return_value=False):
            self.assertFalse(one.already_applied({"ExecStart": ""}))

    def test_exact_existing_override_idempotent_but_stale_unit_denied(self):
        expected = ("[Service]\nExecStart=\nExecStart=" + str(one.NODE) + " " +
                    str(one.RELEASE) + "/src/cli.js supervisor\n").encode()
        effective = "{ argv[]=" + str(one.NODE) + " " + str(
            one.RELEASE) + "/src/cli.js supervisor ; }"
        with patch.object(one.os.path, "lexists", return_value=True), \
             patch.object(one, "pinned_read", return_value=expected):
            self.assertTrue(one.already_applied({"ExecStart": effective}))
        with patch.object(one.os.path, "lexists", return_value=True), \
             patch.object(one, "pinned_read", return_value=expected):
            with self.assertRaisesRegex(one.Blocked, "EFFECTIVE_RUNTIME_MISMATCH"):
                one.already_applied({"ExecStart": "{ argv[]=other ; }"})
        with patch.object(one.os.path, "lexists", return_value=True), \
             patch.object(one, "pinned_read", return_value=b"mutated"):
            with self.assertRaisesRegex(one.Blocked, "OVERRIDE_UNTRUSTED"):
                one.already_applied({"ExecStart": effective})

    def test_source_defines_no_unbounded_process_control(self):
        source = SOURCE.read_text()
        for banned in ("shell=True", "os.system", "eval(", "input(",
                       "systemctl restart", "rm -rf"):
            self.assertNotIn(banned, source)
        self.assertIn("BACKUP_AND_HEALTH_MUTATIONS=NONE", source)
        self.assertIn("MCP_UNVERIFIED", source)


if __name__ == "__main__":
    unittest.main()
