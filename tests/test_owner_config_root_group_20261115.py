import importlib.util
import io
import os
import pathlib
import shutil
import tempfile
import socket
import stat
import sys
import unittest
from contextlib import redirect_stdout

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/production/owner_config_root_group_20261115.py"
spec = importlib.util.spec_from_file_location("cfgowner", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

UID, GID = 59997, 59997


class Harness(unittest.TestCase):
    def setUp(self):
        if os.geteuid() != 0:
            self.skipTest("needs root to chown")
        # Root-owned, exclusive fixture; never delete a predictable host path.
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="kmjt-cfgowner-", dir="/run"))
        self.dir = self.root / "stage"
        self.dir.mkdir()
        self.file = self.dir / "gateway.json"
        self.file.write_text('{"x":1}\n')
        self.set(UID, GID, 0o700, 0o600)
        self.saved = {k: getattr(mod, k) for k in
                      ("DIR", "FILE", "LOCK", "ids", "prove_runtime", "prove_readable_with_dummy",
                       "verify_after", "show")}
        mod.DIR, mod.FILE = self.dir, self.file
        mod.LOCK = self.root / "lock"
        mod.ids = lambda: (UID, GID)
        mod.prove_runtime = lambda: 4242
        mod.prove_readable_with_dummy = lambda gid: None
        mod.verify_after = lambda pid, gid: None
        mod.show = lambda prop: "active" if prop == "ActiveState" else "4242"
        self.hostname = socket.gethostname
        socket.gethostname = lambda: "KMJ-elite"
        self.calls = []
        self.real_set_owner = mod.set_owner

        def spy(path, uid, gid, mode, inode, is_dir):
            self.calls.append(pathlib.Path(path).name)
            return self.real_set_owner(path, uid, gid, mode, inode, is_dir)

        mod.set_owner = spy

    def tearDown(self):
        for k, v in getattr(self, "saved", {}).items():
            setattr(mod, k, v)
        mod.set_owner = getattr(self, "real_set_owner", mod.set_owner)
        if hasattr(self, "hostname"):
            socket.gethostname = self.hostname
        if hasattr(self, "root"):
            shutil.rmtree(self.root)

    def set(self, uid, gid, dmode, fmode):
        os.chown(self.dir, uid, gid)
        os.chmod(self.dir, dmode)
        os.chown(self.file, uid, gid)
        os.chmod(self.file, fmode)

    def state(self):
        d, f = os.lstat(self.dir), os.lstat(self.file)
        return ((d.st_uid, d.st_gid, stat.S_IMODE(d.st_mode)),
                (f.st_uid, f.st_gid, stat.S_IMODE(f.st_mode)))

    def go(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            try:
                mod.run(list(argv))
                err = None
            except mod.Blocked as e:
                err = e.args[0]
        return out.getvalue(), err


class Tests(Harness):
    def test_dry_run_changes_nothing(self):
        out, err = self.go()
        self.assertIsNone(err)
        self.assertIn("DRY_RUN_UNCHANGED", out)
        self.assertEqual(self.state(), ((UID, GID, 0o700), (UID, GID, 0o600)))
        self.assertEqual(self.calls, [])

    def test_apply_changes_file_then_directory(self):
        out, err = self.go("--apply", mod.CONFIRM)
        self.assertIsNone(err, out)
        self.assertEqual(self.state(), ((0, GID, 0o750), (0, GID, 0o640)))
        self.assertEqual(self.calls, ["gateway.json", "stage"])
        self.assertIn("GATEWAY_RESTART=NOT_PERFORMED", out)
        self.assertFalse(mod.LOCK.exists())

    def test_failed_verification_restores_original(self):
        def boom(pid, gid):
            raise mod.Blocked("SUPERVISOR_VALIDATOR_STILL_REJECTS")
        mod.verify_after = boom
        out, err = self.go("--apply", mod.CONFIRM)
        self.assertEqual(err, "OWNER_CHANGE_FAILED")
        self.assertIn("CONFIG_OWNER_AUTO_ROLLBACK=PASS", out)
        self.assertEqual(self.state(), ((UID, GID, 0o700), (UID, GID, 0o600)))
        self.assertFalse(mod.LOCK.exists())

    def test_rollback_mode_restores_service_user_ownership(self):
        self.go("--apply", mod.CONFIRM)
        self.calls.clear()
        out, err = self.go("--rollback", mod.CONFIRM)
        self.assertIsNone(err, out)
        self.assertEqual(self.state(), ((UID, GID, 0o700), (UID, GID, 0o600)))
        self.assertEqual(self.calls, ["stage", "gateway.json"])

    def test_partial_apply_failure_restores_same_original_inodes(self):
        initial_dir = os.lstat(self.dir).st_ino
        initial_file = os.lstat(self.file).st_ino
        real = mod.set_owner
        injected = [False]

        def fail_after_file(path, uid, gid, mode, inode, is_dir):
            if pathlib.Path(path) == self.dir and not injected[0]:
                injected[0] = True
                raise mod.Blocked("INJECTED_SECOND_STEP")
            return real(path, uid, gid, mode, inode, is_dir)

        mod.set_owner = fail_after_file
        out, err = self.go("--apply", mod.CONFIRM)
        self.assertTrue(injected[0])
        self.assertEqual(err, "OWNER_CHANGE_FAILED")
        self.assertIn("CONFIG_OWNER_AUTO_ROLLBACK=PASS", out)
        self.assertEqual(self.state(), ((UID, GID, 0o700), (UID, GID, 0o600)))
        self.assertEqual(os.lstat(self.dir).st_ino, initial_dir)
        self.assertEqual(os.lstat(self.file).st_ino, initial_file)
        self.assertFalse(mod.LOCK.exists())

    def test_partial_explicit_rollback_failure_restores_target_shape(self):
        self.go("--apply", mod.CONFIRM)
        real = mod.set_owner
        injected = [False]

        def fail_after_dir(path, uid, gid, mode, inode, is_dir):
            if pathlib.Path(path) == self.file and not injected[0]:
                injected[0] = True
                raise mod.Blocked("INJECTED_SECOND_STEP")
            return real(path, uid, gid, mode, inode, is_dir)

        mod.set_owner = fail_after_dir
        out, err = self.go("--rollback", mod.CONFIRM)
        self.assertTrue(injected[0])
        self.assertEqual(err, "OWNER_CHANGE_FAILED")
        self.assertIn("CONFIG_OWNER_AUTO_ROLLBACK=PASS", out)
        self.assertEqual(self.state(), ((0, GID, 0o750), (0, GID, 0o640)))
        self.assertFalse(mod.LOCK.exists())

    def test_unexpected_state_blocks_before_any_change(self):
        os.chmod(self.file, 0o644)
        out, err = self.go("--apply", mod.CONFIRM)
        self.assertEqual(err, "CONFIG_FILE_STATE_UNEXPECTED")
        self.assertEqual(self.calls, [])

    def test_hardlinked_or_symlinked_file_blocks(self):
        os.link(self.file, self.dir / "other")
        _, err = self.go("--apply", mod.CONFIRM)
        self.assertEqual(err, "CONFIG_FILE_NOT_REGULAR")
        os.unlink(self.dir / "other")
        os.unlink(self.file)
        os.symlink("/etc/passwd", self.file)
        _, err = self.go("--apply", mod.CONFIRM)
        self.assertEqual(err, "CONFIG_FILE_NOT_REGULAR")

    def test_apply_requires_confirm_flag_and_root_host(self):
        _, err = self.go("--apply")
        self.assertEqual(err, "INVALID_ARGS")
        socket.gethostname = lambda: "other-host"
        _, err = self.go()
        self.assertEqual(err, "WRONG_ROOT_OR_HOST")

    def test_existing_lock_blocks_apply(self):
        mod.LOCK.write_text("x")
        with self.assertRaises(FileExistsError):
            self.go("--apply", mod.CONFIRM)
        self.assertEqual(self.state(), ((UID, GID, 0o700), (UID, GID, 0o600)))


if __name__ == "__main__":
    unittest.main()
