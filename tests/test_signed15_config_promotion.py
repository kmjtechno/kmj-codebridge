import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest
from unittest.mock import patch

SOURCE = (pathlib.Path(__file__).resolve().parents[1] /
          "scripts/production/owner_promote_signed15_stable_config_20261103.py")
spec = importlib.util.spec_from_file_location("signed15_config", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Signed15ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.cfg = {
            "schema": 1,
            "channel": "stable",
            "manifestUrl": mod.expected_url(mod.OLD,"release-manifest.json"),
            "signatureUrl": mod.expected_url(mod.OLD,"release-manifest.sig"),
            "trustedKeys": {"kmj-release-2026": "test-valid-public-key-unchanged"},
            "installRoot": "/opt/kmj-codebridge-stable",
            "stateDir": "/var/lib/kmj-codebridge-update",
            "agentStateDir": "/var/lib/kmj-codebridge-kmj-main-platform",
            "workDir": "/var/lib/kmj-codebridge-update-work",
            "health": {"attempts": 10, "delayMs": 1000},
        }

    def test_only_urls_change(self):
        new, already = mod.updated_config(self.cfg)
        self.assertFalse(already)
        self.assertEqual(new["manifestUrl"],mod.expected_url(mod.NEW,"release-manifest.json"))
        self.assertEqual(new["signatureUrl"],mod.expected_url(mod.NEW,"release-manifest.sig"))
        self.assertEqual(set(new),set(self.cfg))
        for name in self.cfg:
            if name not in ("manifestUrl","signatureUrl"):
                self.assertEqual(new[name],self.cfg[name])

    def test_idempotent_and_tampering_refused(self):
        new,_ = mod.updated_config(self.cfg)
        again,already = mod.updated_config(new)
        self.assertTrue(already)
        self.assertEqual(new,again)
        for bad in (
            {**self.cfg,"signatureUrl":"https://example.org/manifest.sig"},
            {**self.cfg,"manifestUrl":mod.expected_url(mod.NEW,"release-manifest.json")},
            {**self.cfg,"channel":"beta"},
            {**self.cfg,"trustedKeys":{}},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    mod.updated_config(bad)

    def test_private_backup_config_write_and_no_overwrite(self):
        config=self.root/"stable-update.json"
        backup=self.root/"stable-update.before-signed15.json"
        original=(json.dumps(self.cfg,indent=2)+"\n").encode()
        config.write_bytes(original)
        os.chmod(config,0o600)
        def simulated_protected():
            st=config.stat()
            return config.read_bytes(),st
        new,_=mod.updated_config(self.cfg)
        with patch.object(mod,"CONFIG",config),\
             patch.object(mod,"BACKUP",backup),\
             patch.object(mod,"protected_file",simulated_protected):
            data,st=simulated_protected()
            mod.write_config(data,st,new)
            self.assertEqual(backup.read_bytes(), original)
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode),0o600)
            self.assertEqual(stat.S_IMODE(config.stat().st_mode),0o600)
            self.assertEqual(json.loads(config.read_bytes()),new)
            with self.assertRaisesRegex(ValueError,"EXISTING_BACKUP_REQUIRES_REVIEW"):
                mod.write_config(data,st,new)
            self.assertEqual(backup.read_bytes(),original)

    def test_refuses_existing_backup_before_write(self):
        config=self.root/"stable-update.json"
        backup=self.root/"stable-update.before-signed15.json"
        config.write_text(json.dumps(self.cfg))
        backup.write_bytes(b"pre-existing-protected-backup")
        new,_=mod.updated_config(self.cfg)
        with patch.object(mod,"CONFIG",config), patch.object(mod,"BACKUP",backup):
            with self.assertRaisesRegex(ValueError,"EXISTING_BACKUP_REQUIRES_REVIEW"):
                mod.write_config(config.read_bytes(),config.stat(),new)
            self.assertEqual(backup.read_bytes(),b"pre-existing-protected-backup")

if __name__ == "__main__":
    unittest.main()
