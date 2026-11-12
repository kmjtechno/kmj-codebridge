"""KMJ-elite dynamic DNS contracts (offline; mocked Cloudflare)."""
from pathlib import Path
import ast
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/production/elite_dynamic_dns.py"


class EliteDynamicDns(unittest.TestCase):
    def test_self_test_passes_offline(self):
        out = subprocess.run([sys.executable, "-B", str(SCRIPT), "--self-test"],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("ELITE_DDNS_SELF_TEST=PASS", out.stdout)

    def test_only_patch_of_content_never_create_or_delete(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn('"DELETE"', source)
        self.assertNotIn('"POST"', source)
        self.assertIn('{"content": item["content"]}', source)
        self.assertEqual(ast.literal_eval(source.split("A_RECORDS = ", 1)[1].split("\n", 1)[0]),
                         ("elite-ssh.kmjtechno.com", "mail.kmjtechno.com"))

    def test_token_never_printed(self):
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "print":
                self.assertNotIn("token", ast.unparse(node).lower().replace("token_file", ""))

    def test_systemd_unit_is_hardened(self):
        unit = (ROOT / "examples/elite-ddns/kmj-elite-ddns.service").read_text(encoding="utf-8")
        for line in ("ProtectSystem=strict", "NoNewPrivileges=true", "PrivateTmp=true", "--apply"):
            self.assertIn(line, unit)


if __name__ == "__main__":
    unittest.main()
