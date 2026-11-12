"""KMJ-elite origin single-source-of-truth contracts (source-only, no network)."""
from pathlib import Path
import json
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config/elite-origin.json").read_text(encoding="utf-8"))
ROTATOR = ROOT / "scripts/operations/rotate_elite_origin_ip.py"


class EliteOriginConfig(unittest.TestCase):
    def test_every_managed_file_uses_the_configured_ipv4(self):
        ip = re.compile(r"(?<![\d.])" + re.escape(CONFIG["ipv4"]) + r"(?![\d])")
        for name in CONFIG["managedFiles"]:
            with self.subTest(path=name):
                self.assertTrue(ip.search((ROOT / name).read_text(encoding="utf-8")))

    def test_ssh_pin_is_preserved_in_pinned_probes(self):
        pin = CONFIG["sshEd25519"]
        for name in CONFIG["managedFiles"]:
            if name.endswith("_readonly_20261103.py") and "hostpin" in name:
                self.assertIn('ELITE_EXPECTED_ED25519 = "' + pin + '"', (ROOT / name).read_text(encoding="utf-8"))
            if name.endswith("cloudos_elite_ssh_trust_probe_20261102.py"):
                self.assertIn('EXPECTED_FINGERPRINT = "' + pin + '"', (ROOT / name).read_text(encoding="utf-8"))

    def test_rotator_self_test_and_dry_run_are_offline_and_unchanged(self):
        out = subprocess.run([sys.executable, "-B", str(ROTATOR), "--self-test"],
                             capture_output=True, text=True, timeout=60, cwd=ROOT)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("ELITE_IP_ROTATION_SELF_TEST=PASS", out.stdout)
        before = {n: (ROOT / n).read_bytes() for n in CONFIG["managedFiles"]}
        target = "9.9.9.9" if CONFIG["ipv4"] == "8.8.4.4" else "8.8.4.4"
        out = subprocess.run([sys.executable, "-B", str(ROTATOR), "--to", target],
                             capture_output=True, text=True, timeout=60, cwd=ROOT)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("DRY_RUN_UNCHANGED", out.stdout)
        self.assertEqual(before, {n: (ROOT / n).read_bytes() for n in CONFIG["managedFiles"]})

    def test_rotator_has_no_network_or_remote_mutation(self):
        import ast
        tree = ast.parse(ROTATOR.read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(imported - {"__future__", "argparse", "ipaddress", "json", "re",
                                     "subprocess", "sys", "pathlib", "tempfile"}, set())
        commands = [node.args[0] for node in ast.walk(tree)
                    if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "run"]
        self.assertEqual([ast.literal_eval(c) for c in commands], [["git", "ls-files"]])

if __name__ == "__main__":
    unittest.main()
