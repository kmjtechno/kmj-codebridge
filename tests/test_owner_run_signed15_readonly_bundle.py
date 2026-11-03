"""Offline source + fail-closed invocation contract; no owner action is executed."""
from pathlib import Path
import re
import subprocess
import unittest

SOURCE=Path(__file__).resolve().parents[1]/"scripts/production/owner_run_signed15_readonly_bundle_20261103.sh"
TEXT=SOURCE.read_text(encoding="utf-8")

class Signed15ReadOnlyBundleTests(unittest.TestCase):
    def test_shell_syntax(self):
        p=subprocess.run(["bash","-n",str(SOURCE)],capture_output=True,text=True,timeout=10)
        self.assertEqual(p.returncode,0,p.stderr)
    def test_nonprivileged_bash_rejected_before_any_download(self):
        p=subprocess.run(["bash",str(SOURCE)],capture_output=True,text=True,timeout=10)
        self.assertEqual(p.returncode,2,p.stdout)
        self.assertIn("BLOCKED_PRIVILEGED_BASH_REQUIRED",p.stdout)
    def test_extra_arguments_rejected_before_host_check(self):
        p=subprocess.run(["bash","-p",str(SOURCE),"--apply"],capture_output=True,text=True,timeout=10)
        self.assertEqual(p.returncode,2,p.stdout)
        self.assertIn("BLOCKED_ARGUMENTS",p.stdout)
    def test_exact_reviewed_git_blobs_and_commits(self):
        required=("AUDITOR_REV=d251638eb568d6e1a9b4a3dce4dd329436ad0d8a",
                  "REFERENCE_REV=cb46a972737f1459d0395b0147ca71a8cc9b2bc9",
                  "AUDITOR_BLOB=7a717dea3b814643338b352517762fdf12aa1c11",
                  "REFERENCE_BLOB=56f9e08119e8bb178be16dd213115d8f975b956a")
        for term in required: self.assertIn(term,TEXT)
        self.assertIn("hashlib.sha1(b'blob '",TEXT)
        self.assertIn("git_blob==expected",TEXT)
        self.assertIn("os.O_NOFOLLOW",TEXT)
    def test_no_live_mutation_and_safe_transport(self):
        self.assertIn("--proto '=https' --proto-redir '=https' --tlsv1.2",TEXT)
        self.assertIn("/usr/bin/curl -q -fLSs",TEXT)
        self.assertIn("KMJ_SIGNED15_READONLY_BUNDLE=PASS",TEXT)
        self.assertIn("KMJ_PRODUCTION_MUTATION=NONE",TEXT)
        self.assertIn("KMJ_SIGNED15_PINNED_SOURCES=PASS",TEXT)
        self.assertIn("if ! /usr/bin/python3 -I -",TEXT)
        self.assertIn('/usr/bin/python3 -B -I "$work/owner_verify_signed15_gateway_20261103.py" --inspect',TEXT)
        self.assertNotRegex(TEXT,r"(?m)^\s*(?:systemctl|service|ln\s+-s|git\s+reset|pg_dump|age|rsync|sftp|ssh)\b")
        self.assertEqual(TEXT.count("download \"$"),2)

if __name__=="__main__": unittest.main()
