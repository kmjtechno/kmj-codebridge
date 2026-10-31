import importlib.util
from pathlib import Path
import subprocess
import unittest

path = Path(__file__).resolve().parents[1] / "scripts" / "production" / "guarded-d3-reset-failed-20261101.py"
spec = importlib.util.spec_from_file_location("d3_lifecycle", path)
d3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d3)


def make_show(**overrides):
    values = {**d3.EXPECTED, "ActiveState": "failed", "Result": "exit-code", "ExecMainStatus": "3"}
    values.update(overrides)
    return "".join(f"{k}={v}\n" for k, v in values.items())


class Runner:
    def __init__(self, shows):
        self.shows = list(shows)
        self.commands = []

    def __call__(self, args, **kwargs):
        self.commands.append(tuple(args))
        if args[1] == "show":
            return subprocess.CompletedProcess(args, 0, self.shows.pop(0), "")
        if args[1] == "reset-failed":
            return subprocess.CompletedProcess(args, 0, "", "")
        raise AssertionError("unexpected command")


class D3Tests(unittest.TestCase):
    def test_diagnose_does_not_mutate(self):
        runner = Runner([make_show()])
        self.assertEqual(d3.reconcile(runner=runner, trusted=lambda: True), ("RESET_CANDIDATE", ["ActiveState"], False))
        self.assertEqual(len(runner.commands), 1)

    def test_reset_only_exact_failed_lifecycle(self):
        runner = Runner([make_show(), make_show(ActiveState="inactive", Result="success", ExecMainStatus="0")])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True), ("RESET_VERIFIED", [], True))
        self.assertEqual(runner.commands[1], ("/usr/bin/systemctl", "reset-failed", d3.UNIT))

    def test_policy_drift_never_mutates(self):
        for key, bad in [("User", "root"), ("ProtectSystem", "full"), ("DropInPaths", "/tmp/evil"), ("ReadWritePaths", "/")]:
            with self.subTest(key=key):
                runner = Runner([make_show(**{key: bad})])
                state, keys, changed = d3.reconcile(apply=True, runner=runner, trusted=lambda: True)
                self.assertEqual((state, keys, changed), ("POLICY_DRIFT", [key], False))
                self.assertEqual(len(runner.commands), 1)

    def test_wrong_exit_and_active_state_never_mutate(self):
        for data in [{"ExecMainStatus": "0"}, {"Result": "signal"}, {"ActiveState": "active"}]:
            runner = Runner([make_show(**data)])
            self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True)[0], "UNEXPECTED_LIFECYCLE")
            self.assertEqual(len(runner.commands), 1)

    def test_untrusted_path_blocks_before_probe(self):
        runner = Runner([])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: False), ("UNIT_PATH_UNTRUSTED", [], False))
        self.assertEqual(runner.commands, [])

    def test_malformed_and_unicode_output_rejected(self):
        for raw in [make_show().replace("\n", "\r\n"), make_show() + "User=root\n",
                    make_show().replace("User=kmjdevci", "User=kmjdevci\u2028root"),
                    make_show().replace("User=kmjdevci", "User=\x00")]:
            self.assertIsNone(d3.parse_properties(raw))

    def test_inactive_with_stale_failure_is_not_clean(self):
        for overrides, expected_keys in [
            ({"Result": "exit-code", "ExecMainStatus": "0"}, ["Result"]),
            ({"Result": "success", "ExecMainStatus": "3"}, ["ExecMainStatus"]),
            ({"Result": "exit-code", "ExecMainStatus": "3"}, ["Result", "ExecMainStatus"]),
        ]:
            with self.subTest(overrides=overrides):
                runner = Runner([make_show(ActiveState="inactive", **overrides)])
                state, keys, attempted = d3.reconcile(apply=True, runner=runner, trusted=lambda: True)
                self.assertEqual((state, keys, attempted), ("UNEXPECTED_LIFECYCLE", expected_keys, False))
                self.assertEqual(len(runner.commands), 1)

    def test_postcheck_inactive_with_stale_failure_not_pass(self):
        runner = Runner([make_show(), make_show(ActiveState="inactive", Result="exit-code", ExecMainStatus="3")])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True),
                         ("POSTCHECK_FAILED", ["Result", "ExecMainStatus"], True))
        self.assertEqual(len(runner.commands), 3)

    def test_postcheck_failure_not_pass(self):
        runner = Runner([make_show(), make_show(ActiveState="failed")])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True), ("POSTCHECK_FAILED", ["ActiveState"], True))


    def test_reset_failure_is_truthfully_reported_as_attempted(self):
        class FailedReset(Runner):
            def __call__(self, args, **kwargs):
                if args[1] == "reset-failed":
                    self.commands.append(tuple(args))
                    return subprocess.CompletedProcess(args, 1, "", "permission denied")
                return super().__call__(args, **kwargs)

        runner = FailedReset([make_show()])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True),
                         ("RESET_FAILED", ["ActiveState"], True))
        self.assertEqual(len(runner.commands), 2)

    def test_symlink_writable_or_hardlinked_unit_path_is_rejected(self):
        import stat
        from types import SimpleNamespace

        def fake_lstat(path, *, bad_path=None, bad_mode=None, hardlink=False):
            is_file = path == d3.UNIT_FILE
            mode = (stat.S_IFREG | 0o644) if is_file else (stat.S_IFDIR | 0o755)
            if path == bad_path:
                mode = bad_mode
            return SimpleNamespace(st_uid=0, st_mode=mode,
                                   st_nlink=2 if hardlink and is_file else 1)

        self.assertTrue(d3.trusted_unit_path(lstat=fake_lstat))
        self.assertFalse(d3.trusted_unit_path(
            lstat=lambda path: fake_lstat(
                path, bad_path="/etc/systemd", bad_mode=stat.S_IFLNK | 0o777)))
        self.assertFalse(d3.trusted_unit_path(
            lstat=lambda path: fake_lstat(
                path, bad_path=d3.UNIT_FILE, bad_mode=stat.S_IFREG | 0o666)))
        # A setuid/setgid/sticky bit is not acceptable on a root-owned
        # protected unit or parent, even without group/world write access.
        # Match the Supervisor's stricter 0o7022 trust mask.
        for path, mode in (
            (d3.UNIT_FILE, stat.S_IFREG | 0o4644),
            (d3.UNIT_FILE, stat.S_IFREG | 0o2644),
            ("/etc/systemd/system", stat.S_IFDIR | 0o1755),
            ("/etc/systemd", stat.S_IFDIR | 0o2755),
        ):
            with self.subTest(path=path, mode=oct(mode)):
                self.assertFalse(d3.trusted_unit_path(
                    lstat=lambda item: fake_lstat(
                        item, bad_path=path, bad_mode=mode)))
        self.assertFalse(d3.trusted_unit_path(
            lstat=lambda path: fake_lstat(path, hardlink=True)))


if __name__ == "__main__":
    unittest.main()
