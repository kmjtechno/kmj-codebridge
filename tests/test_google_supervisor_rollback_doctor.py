"""Hermetic behavior checks for the read-only Google Supervisor rollback doctor.

Run: python3 -m unittest discover -s tests -p 'test_google_supervisor_rollback_doctor.py'
No host service, socket, credential or staging directory is accessed.
"""
import importlib.util
from pathlib import Path
import stat
import subprocess
import types
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/production/google-cloudos-supervisor-rollback-doctor.py"
spec = importlib.util.spec_from_file_location("google_supervisor_rollback_doctor", SCRIPT)
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)


def metadata(mode, uid=0):
    return types.SimpleNamespace(st_mode=mode, st_uid=uid)


class RollbackDoctorBehavior(unittest.TestCase):
    def test_rejects_unapproved_unit_without_subprocess(self):
        with patch.object(doctor.subprocess, "run") as run:
            self.assertEqual(doctor.status("arbitrary.service"), "INVALID_UNIT")
            run.assert_not_called()

    def test_unit_timeout_is_bounded_and_unavailable(self):
        with patch.object(doctor.subprocess, "run", side_effect=subprocess.TimeoutExpired("systemctl", 7)) as run:
            self.assertEqual(doctor.status(doctor.UNIT_NAMES[0]), "UNAVAILABLE")
            self.assertEqual(run.call_args.kwargs["timeout"], 7)
            self.assertEqual(run.call_args.args[0][:2], ["/usr/bin/systemctl", "show"])

    def test_unit_states_do_not_trust_nonloaded_units(self):
        for output, expected in [
            ("LoadState=not-found\nActiveState=inactive\n", "NOT_INSTALLED"),
            ("LoadState=masked\nActiveState=active\n", "UNKNOWN_LOAD_STATE"),
            ("LoadState=loaded\nActiveState=active\n", "ACTIVE"),
            ("LoadState=loaded\nActiveState=activating\n", "UNKNOWN_STATE"),
        ]:
            with self.subTest(output=output), patch.object(doctor.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout=output)):
                self.assertEqual(doctor.status(doctor.UNIT_NAMES[0]), expected)

    def test_stage_parent_symlink_or_writable_denied(self):
        for bad in [metadata(stat.S_IFLNK | 0o777), metadata(stat.S_IFDIR | 0o777), metadata(stat.S_IFDIR | 0o755, uid=1000)]:
            with self.subTest(mode=bad.st_mode, uid=bad.st_uid):
                def fake_lstat(path):
                    return bad if str(path) == "/opt" else metadata(stat.S_IFDIR | 0o755)
                with patch.object(Path, "lstat", autospec=True, side_effect=fake_lstat):
                    self.assertTrue(doctor.stage(doctor.OLD_SOURCE).startswith("UNSAFE_PARENT_"))

    def test_stage_presence_never_claims_attestation(self):
        with patch.object(Path, "lstat", autospec=True, return_value=metadata(stat.S_IFDIR | 0o755)):
            self.assertEqual(doctor.stage(doctor.SIGNED_SOURCE), "PRESENT_NOT_ATTESTED")

    def test_socket_policy_is_not_rpc_proof(self):
        with patch.object(Path, "lstat", autospec=True, return_value=metadata(stat.S_IFSOCK | 0o660)):
            self.assertEqual(doctor.socket_metadata(), "PRESENT_POLICY_NOT_ATTESTED_RPC_NOT_TESTED")
        with patch.object(Path, "lstat", autospec=True, return_value=metadata(stat.S_IFSOCK | 0o666)):
            self.assertEqual(doctor.socket_metadata(), "UNSAFE_WORLD_WRITABLE_SOCKET")

    def test_config_content_is_never_opened(self):
        with patch.object(Path, "lstat", autospec=True, return_value=metadata(stat.S_IFREG | 0o600, uid=doctor.os.getuid())), patch("builtins.open", side_effect=AssertionError("content read forbidden")):
            self.assertEqual(doctor.config_metadata(), "OWNER_AND_MODE_PASS_CONTENT_UNREAD")

    def test_wrong_host_and_arguments_do_not_probe(self):
        with patch.object(doctor.sys, "argv", ["doctor"]), patch.object(doctor.socket, "gethostname", return_value="wrong-host"), patch.object(doctor, "status", side_effect=AssertionError("probe forbidden")):
            self.assertEqual(doctor.main(), 2)
        with patch.object(doctor.sys, "argv", ["doctor", "--apply"]), patch.object(doctor, "status", side_effect=AssertionError("probe forbidden")):
            self.assertEqual(doctor.main(), 2)


if __name__ == "__main__":
    unittest.main()
