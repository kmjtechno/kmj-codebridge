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
        self.assertEqual(d3.reconcile(runner=runner, trusted=lambda: True, content_trusted=lambda: True), ("RESET_CANDIDATE", ["ActiveState"], False))
        self.assertEqual(len(runner.commands), 1)

    def test_exact_unit_or_helper_drift_never_resets_failed_state(self):
        runner = Runner([make_show()])
        self.assertEqual(
            d3.reconcile(apply=True, runner=runner, trusted=lambda: True,
                         content_trusted=lambda: False),
            ("UNIT_CONTENT_UNTRUSTED", [], False),
        )
        self.assertEqual(len(runner.commands), 1)

    def test_diagnose_remains_read_only_without_content_attestation(self):
        runner = Runner([make_show()])
        self.assertEqual(
            d3.reconcile(runner=runner, trusted=lambda: True,
                         content_trusted=lambda: False),
            ("RESET_CANDIDATE", ["ActiveState"], False),
        )
        self.assertEqual(len(runner.commands), 1)

    def test_stale_systemd_loaded_cache_never_resets(self):
        # Disk content can match a pinned SHA while PID 1 still has older unit
        # directives loaded. NeedDaemonReload=yes must fail before mutation.
        runner = Runner([make_show(NeedDaemonReload="yes")])
        self.assertEqual(
            d3.reconcile(apply=True, runner=runner, trusted=lambda: True,
                         content_trusted=lambda: True),
            ("POLICY_DRIFT", ["NeedDaemonReload"], False),
        )
        self.assertEqual(len(runner.commands), 1)
        self.assertEqual(runner.commands[0][1], "show")

    def test_cache_becomes_stale_before_reset_never_mutates(self):
        runner = Runner([make_show(), make_show(NeedDaemonReload="yes")])
        self.assertEqual(
            d3.reconcile(apply=True, runner=runner, trusted=lambda: True,
                         content_trusted=lambda: True),
            ("PRE_RESET_STATE_CHANGED", ["NeedDaemonReload"], False),
        )
        self.assertEqual(len(runner.commands), 2)
        self.assertTrue(all(command[1] == "show" for command in runner.commands))

    def test_pre_reset_policy_drift_never_mutates(self):
        runner = Runner([make_show(), make_show(ProtectSystem="full")])
        self.assertEqual(
            d3.reconcile(apply=True, runner=runner, trusted=lambda: True,
                         content_trusted=lambda: True),
            ("PRE_RESET_STATE_CHANGED", ["ProtectSystem"], False),
        )
        self.assertEqual(len(runner.commands), 2)
        self.assertTrue(all(command[1] == "show" for command in runner.commands))

    def test_pre_reset_path_change_never_mutates(self):
        runner = Runner([make_show()])
        trust_checks = iter((True, False))
        self.assertEqual(
            d3.reconcile(apply=True, runner=runner,
                         trusted=lambda: next(trust_checks),
                         content_trusted=lambda: True),
            ("PRE_RESET_TRUST_CHANGED", [], False),
        )
        self.assertEqual(len(runner.commands), 1)

    def test_pre_reset_content_change_never_mutates(self):
        runner = Runner([make_show()])
        content_checks = iter((True, False))
        self.assertEqual(
            d3.reconcile(apply=True, runner=runner, trusted=lambda: True,
                         content_trusted=lambda: next(content_checks)),
            ("PRE_RESET_TRUST_CHANGED", [], False),
        )
        self.assertEqual(len(runner.commands), 1)

    def test_reset_only_exact_failed_lifecycle(self):
        runner = Runner([make_show(), make_show(), make_show(ActiveState="inactive", Result="success", ExecMainStatus="0")])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True, content_trusted=lambda: True), ("RESET_VERIFIED", [], True))
        self.assertEqual(runner.commands[2], ("/usr/bin/systemctl", "reset-failed", d3.UNIT))

    def test_policy_drift_never_mutates(self):
        for key, bad in [("User", "root"), ("ProtectSystem", "full"), ("DropInPaths", "/tmp/evil"), ("ReadWritePaths", "/")]:
            with self.subTest(key=key):
                runner = Runner([make_show(**{key: bad})])
                state, keys, changed = d3.reconcile(apply=True, runner=runner, trusted=lambda: True, content_trusted=lambda: True)
                self.assertEqual((state, keys, changed), ("POLICY_DRIFT", [key], False))
                self.assertEqual(len(runner.commands), 1)

    def test_wrong_exit_and_active_state_never_mutate(self):
        for data in [{"ExecMainStatus": "0"}, {"Result": "signal"}, {"ActiveState": "active"}]:
            runner = Runner([make_show(**data)])
            self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True, content_trusted=lambda: True)[0], "UNEXPECTED_LIFECYCLE")
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
                state, keys, attempted = d3.reconcile(apply=True, runner=runner, trusted=lambda: True, content_trusted=lambda: True)
                self.assertEqual((state, keys, attempted), ("UNEXPECTED_LIFECYCLE", expected_keys, False))
                self.assertEqual(len(runner.commands), 1)

    def test_postcheck_inactive_with_stale_failure_not_pass(self):
        runner = Runner([make_show(), make_show(), make_show(ActiveState="inactive", Result="exit-code", ExecMainStatus="3")])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True, content_trusted=lambda: True),
                         ("POSTCHECK_FAILED", ["Result", "ExecMainStatus"], True))
        self.assertEqual(len(runner.commands), 4)

    def test_postcheck_failure_not_pass(self):
        runner = Runner([make_show(), make_show(), make_show(ActiveState="failed")])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True, content_trusted=lambda: True), ("POSTCHECK_FAILED", ["ActiveState"], True))


    def test_reset_failure_is_truthfully_reported_as_attempted(self):
        class FailedReset(Runner):
            def __call__(self, args, **kwargs):
                if args[1] == "reset-failed":
                    self.commands.append(tuple(args))
                    return subprocess.CompletedProcess(args, 1, "", "permission denied")
                return super().__call__(args, **kwargs)

        runner = FailedReset([make_show(), make_show()])
        self.assertEqual(d3.reconcile(apply=True, runner=runner, trusted=lambda: True, content_trusted=lambda: True),
                         ("RESET_FAILED", ["ActiveState"], True))
        self.assertEqual(len(runner.commands), 3)

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


    def test_content_open_is_dirfd_anchored_and_inode_pinned(self):
        import hashlib
        import os
        import stat
        from types import SimpleNamespace
        from unittest import mock

        payload = b"fixed-root-owned-unit-or-helper"
        digest = hashlib.sha256(payload).hexdigest()
        paths = {
            "/": 10, "/etc": 11, "/etc/systemd": 12,
            "/etc/systemd/system": 13, d3.UNIT_FILE: 14,
            "/usr": 15, "/usr/local": 16,
            "/usr/local/libexec": 17, d3.HELPER_FILE: 18,
        }
        reverse = {value: key for key, value in paths.items()}
        opened = []
        closed = []
        overrides = {}
        late_replacements = set()
        read_count = [0]

        def fake_stat_for(path):
            is_file = path in (d3.UNIT_FILE, d3.HELPER_FILE)
            mode = (stat.S_IFREG | 0o644) if is_file else (stat.S_IFDIR | 0o755)
            result = dict(st_dev=1, st_ino=paths[path], st_uid=0,
                          st_mode=mode, st_nlink=1 if is_file else 2,
                          st_size=len(payload) if is_file else 4096)
            result.update(overrides.get(path, {}))
            return SimpleNamespace(**result)

        def fake_open(name, flags, *, dir_fd=None):
            if dir_fd is None:
                self.assertEqual(name, "/")
                path = "/"
            else:
                self.assertIn(dir_fd, reverse)
                path = reverse[dir_fd].rstrip("/") + "/" + name
            self.assertIn(path, paths)
            self.assertTrue(flags & os.O_NOFOLLOW)
            self.assertTrue(flags & os.O_NONBLOCK)
            self.assertTrue(flags & os.O_CLOEXEC)
            if path not in (d3.UNIT_FILE, d3.HELPER_FILE):
                self.assertTrue(flags & os.O_DIRECTORY)
            opened.append((path, dir_fd))
            return paths[path]

        def fake_stat(name, *, dir_fd, follow_symlinks):
            self.assertFalse(follow_symlinks)
            path = reverse[dir_fd].rstrip("/") + "/" + name
            result = fake_stat_for(path)
            if path in late_replacements and read_count[0] > 0:
                return SimpleNamespace(**{**vars(result),
                                          "st_ino": result.st_ino + 200})
            return result

        def fake_fstat(fd):
            path = reverse[fd]
            # Simulate replacement between stat and open when requested.
            result = fake_stat_for(path)
            if path in replacement_inodes:
                return SimpleNamespace(**{**vars(result),
                                          "st_ino": result.st_ino + 100})
            return result

        def fake_read(fd, count):
            read_count[0] += 1
            return payload

        replacement_inodes = set()
        with (
            mock.patch.object(d3.os, "open", side_effect=fake_open),
            mock.patch.object(d3.os, "stat", side_effect=fake_stat),
            mock.patch.object(d3.os, "fstat", side_effect=fake_fstat),
            mock.patch.object(d3.os, "read", side_effect=fake_read),
            mock.patch.object(d3.os, "close", side_effect=closed.append),
            mock.patch.object(d3, "EXPECTED_UNIT_SHA256", digest),
            mock.patch.object(d3, "EXPECTED_HELPER_SHA256", digest),
        ):
            self.assertTrue(d3.trusted_exact_content())
            self.assertEqual([p for p, _ in opened if p == "/"], ["/", "/"])
            self.assertEqual(len(opened), len(closed))
            self.assertTrue(all(parent is not None for p, parent in opened
                                if p != "/"))

            # A directory or final file swapped AFTER a successful SHA read
            # must not be accepted merely because its old dirfd remains open.
            for path in ("/etc/systemd", "/etc/systemd/system", d3.UNIT_FILE):
                with self.subTest(late_swap=path):
                    read_count[0] = 0
                    late_replacements.add(path)
                    self.assertFalse(d3.trusted_exact_content())
                    late_replacements.clear()

            # Replacing a parent inode during descriptor traversal is refused.
            for path in ("/etc/systemd", "/usr/local/libexec", d3.HELPER_FILE):
                with self.subTest(replaced=path):
                    replacement_inodes.add(path)
                    self.assertFalse(d3.trusted_exact_content())
                    replacement_inodes.clear()

            # A symlink, writable ancestor or hardlinked/special file is
            # rejected without ever invoking a reset-failed command.
            for path, drift in (
                ("/usr/local", {"st_mode": stat.S_IFLNK | 0o777}),
                ("/etc/systemd", {"st_mode": stat.S_IFDIR | 0o777}),
                (d3.HELPER_FILE, {"st_nlink": 2}),
                (d3.UNIT_FILE, {"st_mode": stat.S_IFIFO | 0o644}),
            ):
                with self.subTest(untrusted=path):
                    overrides[path] = drift
                    self.assertFalse(d3.trusted_exact_content())
                    overrides.clear()


if __name__ == "__main__":
    unittest.main()
