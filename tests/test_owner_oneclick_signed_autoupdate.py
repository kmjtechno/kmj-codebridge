"""Offline policy fixtures: no root, network or systemd writes."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SRC = (Path(__file__).resolve().parents[1] /
       "scripts/production/owner_oneclick_signed_autoupdate.py")
spec = importlib.util.spec_from_file_location("kmj_oneclick_feed", SRC)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def config():
    return {
        "schema": 1, "channel": "stable",
        "manifestUrl": mod.OLD_MANIFEST, "signatureUrl": mod.OLD_SIG,
        "trustedKeys": {mod.KEY_ID: "A" * 40},
        "supervisorSocket": "/run/kmj-codebridge/supervisor.sock"
    }


def unit_fixtures():
    fields = {
        "LoadState": "loaded", "FragmentPath": "",
        "NeedDaemonReload": "no", "ActiveState": "inactive",
        "UnitFileState": "disabled", "User": "root",
        "ExecStart": "", "Result": "success",
    }
    timer = dict(fields,
                 FragmentPath="/etc/systemd/system/" + mod.SIGNED_TIMER)
    service = dict(fields,
                   FragmentPath="/etc/systemd/system/" + mod.SIGNED_SERVICE,
                   ExecStart="/usr/bin/node stable-update " + str(mod.CONFIG))
    dev = dict(fields, FragmentPath="/etc/systemd/system/" + mod.DEV_TIMER)
    return timer, service, dev


class SignedOneClickTests(unittest.TestCase):
    def test_owner_policy_exact_scope_and_key(self):
        approved = {"schema": 1, "profile": "signed-stable-agent-only",
                    "allowedComponents": ["agent"],
                    "keySpkiSha256": mod.OWNER_FP,
                    "minimumSequence": 27, "ownerGo": True}
        with patch.object(mod, "read_root",
                          return_value=json.dumps(approved).encode()):
            self.assertEqual(mod.owner_approval(), approved)

    def test_owner_policy_does_not_grant_gateway_or_root(self):
        base = {"schema": 1, "profile": "signed-stable-agent-only",
                "allowedComponents": ["agent"],
                "keySpkiSha256": mod.OWNER_FP,
                "minimumSequence": 27, "ownerGo": True}
        for changed in (
            dict(base, allowedComponents=["agent", "gateway"]),
            dict(base, keySpkiSha256="a" * 64),
            dict(base, minimumSequence=26),
            dict(base, ownerGo=False),
            dict(base, shell="/bin/sh"),
        ):
            with self.subTest(changed=changed), patch.object(
                mod, "read_root", return_value=json.dumps(changed).encode()):
                with self.assertRaises(mod.Blocked):
                    mod.owner_approval()

    def test_config_must_be_stable_with_known_urls(self):
        obj = config()
        self.assertEqual(mod.parse_config(json.dumps(obj)), obj)
        obj.update(manifestUrl=mod.FEED_MANIFEST, signatureUrl=mod.FEED_SIG)
        self.assertEqual(mod.parse_config(json.dumps(obj)), obj)
        for changed in (
            dict(obj, channel="development"),
            dict(obj, manifestUrl="http://localhost/evil"),
            dict(obj, signatureUrl=mod.OLD_SIG),
            dict(obj, trustedKeys={}),
            dict(obj, supervisorSocket="/tmp/not-approved"),
        ):
            with self.subTest(changed=changed), self.assertRaises(mod.Blocked):
                mod.parse_config(json.dumps(changed))

    def test_exact_systemd_units_only(self):
        with self.assertRaisesRegex(mod.Blocked, "UNEXPECTED_UNIT"):
            mod.status("sshd.service")

    def test_live_timer_omits_service_only_properties(self):
        # Exact shape observed on KMJ-elite 2026-11-15: the timer's User
        # and ExecStart keys are entirely absent, not printed as empty.
        payload = (
            "LoadState=loaded\n"
            "FragmentPath=/etc/systemd/system/kmj-codebridge-stable-update.timer\n"
            "NeedDaemonReload=no\nActiveState=inactive\n"
            "UnitFileState=disabled\nResult=success\n"
        ).encode()
        with patch.object(mod, "command", return_value=payload):
            timer = mod.status(mod.SIGNED_TIMER)
        self.assertEqual(timer["User"], "")
        self.assertEqual(timer["ExecStart"], "")
        self.assertEqual(timer["UnitFileState"], "disabled")

    def test_missing_user_execstart_on_absent_dev_timer_are_normal(self):
        payload = (
            "LoadState=not-found\nFragmentPath=\nNeedDaemonReload=no\n"
            "ActiveState=inactive\nUnitFileState=\nResult=success\n"
        ).encode()
        with patch.object(mod, "command", return_value=payload):
            dev = mod.status(mod.DEV_TIMER)
        self.assertEqual(dev["User"], "")
        self.assertEqual(dev["ExecStart"], "")

    def test_signed_service_must_still_report_user_and_execstart(self):
        payload = (
            "LoadState=loaded\n"
            "FragmentPath=/etc/systemd/system/kmj-codebridge-stable-update.service\n"
            "NeedDaemonReload=no\nActiveState=inactive\n"
            "UnitFileState=static\nResult=success\n"
        ).encode()
        with patch.object(mod, "command", return_value=payload):
            with self.assertRaisesRegex(mod.Blocked,
                                        "UNIT_PROPERTIES_INCOMPLETE"):
                mod.status(mod.SIGNED_SERVICE)

    def test_timer_missing_security_property_and_nonempty_service_props_fail(self):
        missing_result = (
            "LoadState=loaded\nFragmentPath=/etc/systemd/system/"
            "kmj-codebridge-stable-update.timer\n"
            "NeedDaemonReload=no\nActiveState=inactive\n"
            "UnitFileState=disabled\n"
        ).encode()
        wrong_execstart = missing_result + (
            "Result=success\nExecStart=/bin/sh -c attacker\n"
        ).encode()
        with patch.object(mod, "command", return_value=missing_result):
            with self.assertRaisesRegex(mod.Blocked,
                                        "UNIT_PROPERTIES_INCOMPLETE"):
                mod.status(mod.SIGNED_TIMER)
        with patch.object(mod, "command", return_value=wrong_execstart):
            with self.assertRaisesRegex(mod.Blocked,
                                        "TIMER_SERVICE_PROPERTY_DRIFT"):
                mod.status(mod.SIGNED_TIMER)

    def test_systemd_preflight_and_idempotence(self):
        timer, service, dev = unit_fixtures()
        self.assertFalse(mod.systemd_policy(timer, service, dev))
        enabled = dict(timer, UnitFileState="enabled", ActiveState="active")
        self.assertTrue(mod.systemd_policy(enabled, service, dev))

    def test_unsigned_dev_timer_and_failed_update_block(self):
        timer, service, dev = unit_fixtures()
        for wrong in (
            dict(dev, UnitFileState="enabled"),
            dict(dev, ActiveState="active"),
        ):
            with self.assertRaisesRegex(mod.Blocked,
                                        "UNSIGNED_DEVELOPMENT_TIMER_CONFLICT"):
                mod.systemd_policy(timer, service, wrong)
        with self.assertRaisesRegex(mod.Blocked, "SIGNED_UPDATE_BUSY_OR_FAILED"):
            mod.systemd_policy(timer,
                               dict(service, Result="exit-code"), dev)

    def test_untrusted_feed_urls_never_fetched(self):
        with self.assertRaisesRegex(mod.Blocked, "UNTRUSTED_FEED_URL"):
            mod.fetch("https://untrusted.example/feed")
        with self.assertRaisesRegex(mod.Blocked, "UNTRUSTED_FEED_URL"):
            mod.fetch("http://127.0.0.1/metadata")

    def test_feed_metadata_sequence_and_archive_origin_fail(self):
        data = {
            "schema": 1, "product": "KMJ CodeBridge",
            "channel": "stable", "sequence": 26, "keyId": mod.KEY_ID,
            "nodeMajor": 24, "revision": mod.CURRENT,
            "sha256": "a" * 64, "bytes": 2171009,
            "archive": mod.FEED_ROOT + "/" + mod.CURRENT + "/kmj-codebridge-0.3.2.tar.gz"
        }
        with patch.object(mod, "fetch",
                          side_effect=[json.dumps(data).encode(), b"sig"]):
            with self.assertRaisesRegex(mod.Blocked,
                                        "SIGNED_FEED_METADATA_REJECTED"):
                mod.verify_feed(config())
        data["sequence"] = 27
        data["archive"] = "https://example.org/evil.tar.gz"
        with patch.object(mod, "fetch",
                          side_effect=[json.dumps(data).encode(), b"sig"]):
            with self.assertRaisesRegex(mod.Blocked,
                                        "SIGNED_FEED_ARCHIVE_ORIGIN_REJECTED"):
                mod.verify_feed(config())

    def test_bad_crypto_receipt_never_considered_signed(self):
        data = {
            "schema": 1, "product": "KMJ CodeBridge",
            "channel": "stable", "sequence": 27, "keyId": mod.KEY_ID,
            "nodeMajor": 24, "revision": mod.CURRENT,
            "sha256": "a" * 64, "bytes": 2171009,
            "archive": mod.FEED_ROOT + "/" + mod.CURRENT + "/kmj-codebridge-0.3.2.tar.gz"
        }
        with patch.object(mod, "fetch",
                          side_effect=[json.dumps(data).encode(), b"sig"]), \
             patch.object(mod, "trusted_ancestors"), \
             patch.object(mod.os, "lstat") as metadata, \
             patch.object(mod.os, "access", return_value=True), \
             patch.object(mod, "command", side_effect=mod.Blocked("GUARDED_COMMAND_FAILED")):
            import stat
            metadata.return_value.st_mode = stat.S_IFREG | 0o755
            metadata.return_value.st_uid = 0
            with self.assertRaisesRegex(mod.Blocked, "GUARDED_COMMAND_FAILED"):
                mod.verify_feed(config())

    def test_dry_status_does_not_trigger_mutating_commands(self):
        timer, service, dev = unit_fixtures()
        with patch.object(mod.os, "geteuid", return_value=0), \
             patch.object(mod.socket, "gethostname", return_value="KMJ-elite"), \
             patch.object(mod, "read_root", return_value=b"unused"), \
             patch.object(mod, "status", side_effect=[timer, service, dev]), \
             patch.object(mod, "command") as command:
            mod.main([])
            command.assert_not_called()

    def test_disable_rechecks_exact_timer_state_after_successful_systemctl(self):
        timer, service, dev = unit_fixtures()
        after = dict(timer, UnitFileState="disabled",
                     ActiveState="inactive")
        with patch.object(mod.os, "geteuid", return_value=0), \
             patch.object(mod.socket, "gethostname", return_value="KMJ-elite"), \
             patch.object(mod, "read_root", return_value=b"unused"), \
             patch.object(mod, "owner_approval"), \
             patch.object(mod, "status",
                          side_effect=[timer, service, dev, after]) as status, \
             patch.object(mod, "command") as command:
            mod.main(["--disable", mod.CONFIRM])
            self.assertEqual(status.call_count, 4)
            command.assert_called_once_with(
                mod.SYSTEMCTL, "disable", "--now", mod.SIGNED_TIMER,
                timeout=25)
        for wrong in (
            dict(after, UnitFileState="enabled"),
            dict(after, ActiveState="active"),
            dict(after, LoadState="not-found"),
            dict(after, NeedDaemonReload="yes"),
        ):
            with self.subTest(wrong=wrong), \
                 patch.object(mod.os, "geteuid", return_value=0), \
                 patch.object(mod.socket, "gethostname",
                              return_value="KMJ-elite"), \
                 patch.object(mod, "read_root", return_value=b"unused"), \
                 patch.object(mod, "owner_approval"), \
                 patch.object(mod, "status",
                              side_effect=[timer, service, dev, wrong]), \
                 patch.object(mod, "command"):
                with self.assertRaisesRegex(
                    mod.Blocked, "SIGNED_TIMER_DISABLE_UNVERIFIED"
                ):
                    mod.main(["--disable", mod.CONFIRM])

    def test_atomic_backup_writer_retries_short_writes_and_blocks_zero(self):
        received = bytearray()
        def short_write(fd, chunk):
            self.assertEqual(fd, 123)
            n = min(2, len(chunk))
            received.extend(chunk[:n])
            return n
        with patch.object(mod.os, "write", side_effect=short_write):
            mod.write_exact(123, b"abcdef")
        self.assertEqual(bytes(received), b"abcdef")
        with patch.object(mod.os, "write", side_effect=[1, 0]):
            with self.assertRaisesRegex(
                mod.Blocked, "AUTO_CONFIG_SHORT_WRITE"
            ):
                mod.write_exact(123, b"abc")
        source = SRC.read_text()
        self.assertIn("sync_private_config_parent()", source)
        self.assertIn('read_root(BACKUP) == before', source)

    def test_declines_automatic_activation_of_unsigned_builds(self):
        source = SRC.read_text()
        self.assertIn("UNSIGNED_GITHUB_MERGE_AUTOPROMOTION=DENIED", source)
        self.assertIn("GATEWAY_SUPERVISOR_AUTOPROMOTION=NOT_ENABLED", source)
        self.assertNotIn("shell=True", source)
        self.assertNotIn("git pull", source)
        self.assertNotIn("rm -rf", source)


if __name__ == "__main__":
    unittest.main()
