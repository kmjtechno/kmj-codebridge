"""Offline negative fixtures for the read-only Seq27 Supervisor parity doctor."""
import importlib.util
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SRC = Path(__file__).with_name("owner_supervisor_seq27_parity_readonly_20261115.py")
spec = importlib.util.spec_from_file_location("seq27_supervisor_parity", SRC)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
DIR = "/opt/kmj-codebridge-supervisor-stage/" + mod.SHA


def fixtures():
    service = {
        "LoadState": "loaded", "ActiveState": "inactive",
        "FragmentPath": mod.SERVICE_FILE, "WorkingDirectory": DIR,
        "NeedDaemonReload": "no", "User": "root",
        "ExecStart": "{ path=/opt/kmj-codebridge-node/bin/node ; argv[]=/opt/kmj-codebridge-node/bin/node " + DIR + "/src/cli.js supervisor ; }",
    }
    sock = {"LoadState": "loaded", "ActiveState": "active",
            "FragmentPath": mod.SOCKET_FILE, "NeedDaemonReload": "no"}
    return service, sock


class ParityTests(unittest.TestCase):
    def test_exact_unit_source_path_is_only_a_locator(self):
        self.assertEqual(mod.classify(*fixtures()), "SERVICE_SOURCE_PATH_MATCH")

    def test_declares_no_privileged_operation_pass(self):
        import inspect
        body = inspect.getsource(mod.main)
        self.assertIn("BACKUP_OR_HEALTH_OPERATION_VERIFIED=NO", body)
        self.assertIn("SYSTEM_MUTATION=NONE", body)

    def test_old_runtime_and_relocated_runtime_block(self):
        for value in ("/opt/kmj-codebridge-supervisor-stage/" + "a" * 40,
                      "/srv/kmj-codebridge-projects/kmj-codebridge"):
            a, b = fixtures()
            a["WorkingDirectory"] = value
            self.assertEqual(mod.classify(a, b), "SUPERVISOR_RUNTIME_STALE_OR_UNVERIFIED")

    def test_missing_or_fake_units_block(self):
        for key, value, want in (
            ("LoadState", "not-found", "SUPERVISOR_UNIT_MISSING"),
            ("FragmentPath", "/tmp/unit", "SUPERVISOR_UNIT_ORIGIN_UNVERIFIED"),
            ("NeedDaemonReload", "yes", "SUPERVISOR_DAEMON_RELOAD_PENDING"),
            ("User", "kmjcode", "SUPERVISOR_USER_UNEXPECTED"),
            ("ExecStart", "{ argv[]=bash -c anything ; }", "SUPERVISOR_EXEC_MISMATCH"),
        ):
            a, b = fixtures()
            a[key] = value
            self.assertEqual(mod.classify(a, b), want, key)

    def test_socket_inactive_blocks(self):
        a, b = fixtures()
        b["ActiveState"] = "inactive"
        self.assertEqual(mod.classify(a, b), "SUPERVISOR_SOCKET_INACTIVE")

    def test_no_caller_chosen_unit(self):
        with self.assertRaisesRegex(ValueError, "UNIT_NOT_ALLOWLISTED"):
            mod.show("other.service")

    def test_parses_bounded_systemctl_lines(self):
        p = mod.properties("LoadState=loaded\nLoadState=changed\nExecStart=opaque\nPRIVATE=secret\n")
        self.assertEqual(p, {"LoadState": "loaded", "ExecStart": "opaque"})

    def test_stage_marker_and_mutation_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            stage = base / mod.SHA
            (stage / "src").mkdir(parents=True)
            files = [stage / f for f in mod.STAGE_FILES]
            for f in files:
                f.parent.mkdir(exist_ok=True, parents=True)
                f.write_bytes(f.name.encode())
            hashes = [hashlib.sha256(f.read_bytes()).hexdigest() for f in files]
            marker = stage / ".supervisor-stage"
            marker.write_text(mod.SHA + ":" + ":".join(hashes) + "\n")
            # Temp fixture may not be root owned. Mock only permission predicates;
            # still validate actual bytes and the marker layout.
            with patch.object(mod, "trusted_dir", return_value=True), patch.object(mod, "trusted_regular", return_value=True):
                self.assertEqual(mod.stage_attestation(base), "STAGE_FINGERPRINT_MATCH")
                files[-1].write_bytes(b"changed")
                self.assertEqual(mod.stage_attestation(base), "STAGE_FINGERPRINT_MISMATCH")
                files[-1].unlink()
                self.assertEqual(mod.stage_attestation(base), "STAGE_UNAVAILABLE")

    def test_missing_and_symlink_stage_denied(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            self.assertNotEqual(mod.stage_attestation(base), "STAGE_FINGERPRINT_MATCH")
            (base / mod.SHA).symlink_to(base)
            self.assertNotEqual(mod.stage_attestation(base), "STAGE_FINGERPRINT_MATCH")


if __name__ == "__main__":
    unittest.main()
