"""Source-only exact KMJ-elite IP rotation guards; no host or GCE network calls."""
from pathlib import Path
import ast
import unittest

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_IP = "150.242.200.81"
OLD_IP = "103.212.136.154"
ELITE_PIN = "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI"
FILES = (
    "scripts/operations/gce_existing_relay_elite_hostpin_readonly_20261103.py",
    "scripts/operations/gce_n2_public_egress_inventory_readonly_20261103.py",
    "scripts/operations/cloudos_elite_ssh_trust_probe_20261102.py",
)

class EliteIPRotationReadonlyContracts(unittest.TestCase):
    def test_exact_new_origin_and_no_stale_elite_ipv4(self):
        for name in FILES:
            with self.subTest(path=name):
                source = (ROOT / name).read_text(encoding="utf-8")
                ast.parse(source, filename=name)
                self.assertIn(EXPECTED_IP, source)
                self.assertNotIn(OLD_IP, source)

    def test_owner_attested_ssh_ed25519_pin_not_rotated_by_ip_change(self):
        relay = (ROOT / FILES[0]).read_text(encoding="utf-8")
        probe = (ROOT / FILES[2]).read_text(encoding="utf-8")
        self.assertIn('ELITE_EXPECTED_ED25519 = "' + ELITE_PIN + '"', relay)
        self.assertIn('EXPECTED_FINGERPRINT = "' + ELITE_PIN + '"', probe)
        self.assertIn("ssh-keyscan", relay)
        self.assertIn("ssh-keyscan", probe)
        self.assertNotIn("StrictHostKeyChecking=no", relay + probe)
        self.assertNotIn("UserKnownHostsFile=/dev/null", relay + probe)

    def test_no_gce_start_ssh_login_or_key_enrollment_in_readonly_paths(self):
        for name in FILES:
            with self.subTest(path=name):
                source = (ROOT / name).read_text(encoding="utf-8")
                self.assertNotIn('gcloud compute instances start', source)
                self.assertNotIn('subprocess.run(["gcloud", "compute", "ssh"', source)
                self.assertNotIn('set-metadata', source)
                self.assertNotIn('ssh-copy-id', source)
                self.assertNotIn('StrictHostKeyChecking=no', source)
                self.assertNotIn('VM_START=PASS', source)

    def test_ssh_probe_mock_selftest_targets_new_ip_not_google_receiver(self):
        probe = (ROOT / FILES[2]).read_text(encoding="utf-8")
        self.assertIn('check("150.242.200.81", command=fake)', probe)
        self.assertIn('check("150.242.200.81", command=wrong)', probe)
        self.assertNotIn('check("34.63.5.14"', probe)
        self.assertIn("ELITE_SSH_LOGIN_AUTHORIZATION=NOT_TESTED", probe)
        self.assertIn("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", probe)

if __name__ == "__main__":
    unittest.main()
