import datetime as dt
import importlib.util
import json
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/production/kmj-elite-renew-owner-cap100.py"
SPEC = importlib.util.spec_from_file_location("renewal", SCRIPT)
renewal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renewal)
NOW = dt.datetime(2026, 11, 28, tzinfo=dt.timezone.utc)


def fixture():
    home = renewal.HOME
    return {
        "schema": 1, "enabled": True, "repo": "kmjtechno/kmj-codebridge",
        "profile": "owner-host-auto-sign-stable-only",
        "ownerConsent": "AUTO_SIGN_REVIEWED_MAIN_ONLY", "keyId": "kmj-release-2026",
        "approvedAt": "2026-11-23T00:00:00Z", "expiresAt": "2026-12-22T00:00:00Z",
        "maxSequence": 43, "repoPath": home + "/source/kmj-codebridge",
        "keyFile": home + "/.config/kmj-codebridge/kmj-release-original.pem",
        "publicKeyFile": home + "/.config/kmj-codebridge/kmj-release-original.pub",
    }


class RenewalTests(unittest.TestCase):
    def plan(self, obj):
        return renewal.plan(json.dumps(obj).encode(), NOW)

    def test_only_cap_changes(self):
        old, new = self.plan(fixture())
        self.assertEqual(new["maxSequence"], 100)
        self.assertEqual({k: v for k, v in new.items() if k != "maxSequence"},
                         {k: v for k, v in old.items() if k != "maxSequence"})

    def test_already_current(self):
        obj = fixture()
        obj["maxSequence"] = 100
        old, new = self.plan(obj)
        self.assertEqual(old, new)

    def test_reject_outside_scope(self):
        for key, value in [
            ("maxSequence", 101), ("maxSequence", True), ("enabled", False),
            ("repo", "other/repo"), ("keyFile", "/tmp/key"),
            ("expiresAt", "2026-11-24T00:00:00Z"),
            ("expiresAt", "2027-01-01T00:00:00Z"),
            ("approvedAt", "2026-11-29T00:00:00Z"), ("schema", True),
        ]:
            with self.subTest(key=key, value=value):
                obj = fixture()
                obj[key] = value
                with self.assertRaises(renewal.Blocked):
                    self.plan(obj)

    def test_duplicate_and_extra_fields_rejected(self):
        raw = json.dumps(fixture()).encode()
        with self.assertRaises(renewal.Blocked):
            renewal.plan(raw[:-1] + b', "maxSequence": 100}', NOW)
        obj = fixture()
        obj["extra"] = True
        with self.assertRaises(renewal.Blocked):
            self.plan(obj)


if __name__ == "__main__":
    unittest.main()
