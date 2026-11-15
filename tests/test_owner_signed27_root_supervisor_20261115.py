"""Disposable, nonroot tests for owner-signed27 Supervisor reconciliation.

These fixtures do NOT run systemctl or change /etc, sockets, gateway, backups,
release pointers, health scripts, keys, or privileged supervisor services.
"""
import importlib.util
from pathlib import Path
import socket
import stat
import types
import unittest
from unittest import mock

SOURCE=Path(__file__).resolve().parent.parent/"scripts/production/owner_reconcile_signed27_root_supervisor_20261115.py"
spec=importlib.util.spec_from_file_location("kmj_owner_signed27_root_supervisor_review",SOURCE)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RootSupervisorSafeReconcile(unittest.TestCase):
    def setUp(self):
        self.root=dict(
            Id=m.SERVICE,LoadState="loaded",Type="simple",
            User="root",Group="root",WorkingDirectory=
              "/opt/kmj-codebridge-supervisor-stage/"+"a"*40,
            ExecStart="{ path="+m.NODE+" ; argv[]="+m.NODE+
              " /opt/kmj-codebridge-supervisor-stage/"+"a"*40+
              "/src/cli.js supervisor ; ignore_errors=no ; }",
            DropInPaths="/etc/systemd/system/kmj-codebridge-supervisor.service.d/90-existing-safe.conf",
            ActiveState="inactive",NeedDaemonReload="no",
        )
        self.sock=dict(Id=m.SOCKET,LoadState="loaded",ActiveState="active")
        self.gw=dict(Id=m.GATEWAY,LoadState="loaded",ActiveState="active",
                     Environment="CODEBRIDGE_SOURCE_COMMIT="+m.SOURCE_SHA,
                     WorkingDirectory=str(m.SOURCE_ROOT),
                     ExecStart="{ path="+m.NODE+" ; argv[]="+m.NODE+" "+
                       str(m.SOURCE_ROOT)+"/src/cli.js gateway ; }")

    def verify(self):
        return m.validate_baseline(self.root,self.sock,self.gw)

    def test_good_previous_supervisor_and_new_signed27_gateway_admitted(self):
        self.assertTrue(self.verify())

    def test_wrong_previous_supervisor_source_root_rejected(self):
        self.root["WorkingDirectory"]="/srv/kmj-codebridge-projects/kmj-codebridge"
        with self.assertRaisesRegex(m.Block,"SUPERVISOR_OLD_STAGE_UNEXPECTED"):
            self.verify()

    def test_busy_previous_supervisor_rejected(self):
        self.root["ActiveState"]="active"
        with self.assertRaisesRegex(m.Block,"SUPERVISOR_BUSY_OR_FAILED_REQUIRE_REVIEW"):
            self.verify()

    def test_failed_previous_supervisor_rejected(self):
        self.root["ActiveState"]="failed"
        with self.assertRaisesRegex(m.Block,"SUPERVISOR_BUSY_OR_FAILED_REQUIRE_REVIEW"):
            self.verify()

    def test_socket_inactive_rejected(self):
        self.sock["ActiveState"]="inactive"
        with self.assertRaisesRegex(m.Block,"SUPERVISOR_SOCKET_NOT_READY"):
            self.verify()

    def test_wrong_untrusted_gateway_commit_rejected(self):
        self.gw["Environment"]="CODEBRIDGE_SOURCE_COMMIT="+"f"*40
        with self.assertRaisesRegex(m.Block,"SIGNED27_GATEWAY_IDENTITY_UNVERIFIED"):
            self.verify()

    def test_wrong_gateway_runtime_rejected(self):
        self.gw["WorkingDirectory"]="/srv/untrusted"
        self.gw["ExecStart"]="argv[]=/srv/untrusted/src/cli.js gateway"
        with self.assertRaisesRegex(m.Block,"SIGNED27_GATEWAY_RUNTIME_MISMATCH"):
            self.verify()

    def test_unexpected_preexisting_override_rejected(self):
        self.root["DropInPaths"]+= " "+str(m.DROP_PATH)
        with self.assertRaisesRegex(m.Block,"NEW_DROPIN_ALREADY_INSTALLED"):
            self.verify()

    def test_non_root_supervisor_user_rejected(self):
        self.root["User"]="kmjcode"
        with self.assertRaisesRegex(m.Block,"SUPERVISOR_UNIT_NOT_BASELINE"):
            self.verify()

    def test_unit_needs_daemon_reload_rejected(self):
        self.root["NeedDaemonReload"]="yes"
        with self.assertRaisesRegex(m.Block,"SUPERVISOR_UNIT_NOT_BASELINE"):
            self.verify()

    def test_old_exec_mismatch_rejected(self):
        self.root["ExecStart"]="argv[]=/usr/bin/bash /tmp/agent.sh"
        with self.assertRaisesRegex(m.Block,"SUPERVISOR_OLD_EXEC_UNEXPECTED"):
            self.verify()

    def test_exact_effective_new_unit_accepted(self):
        unit={**self.root,
              "WorkingDirectory":str(m.SOURCE_ROOT),
              "DropInPaths":str(m.DROP_PATH),
              "ExecStart":"{ path="+m.NODE+" ; argv[]="+m.NODE+" "+
                str(m.SOURCE_ROOT)+"/src/cli.js supervisor ; }"}
        with mock.patch.object(m,"props",return_value=unit):
            m.validate_after()

    def test_new_unit_extra_wrong_exec_rejected(self):
        unit={**self.root,
              "WorkingDirectory":str(m.SOURCE_ROOT),
              "DropInPaths":str(m.DROP_PATH),
              "ExecStart":"argv[]=/usr/bin/bash /tmp/untrusted"}
        with mock.patch.object(m,"props",return_value=unit):
            with self.assertRaisesRegex(m.Block,"SIGNED27_SUPERVISOR_EFFECTIVE_UNIT_MISMATCH"):
                m.validate_after()

    def test_preflight_only_reads_and_prints_when_mocked(self):
        def fixture_props(unit,keys):
            return {m.SERVICE:self.root,m.SOCKET:self.sock,m.GATEWAY:self.gw}[unit]
        with (mock.patch.object(m.os,"geteuid",return_value=0),
              mock.patch.object(m.socket,"gethostname",return_value="KMJ-elite"),
              mock.patch.object(m.os.path,"lexists",return_value=False),
              mock.patch.object(m,"approved_source") as src,
              mock.patch.object(m,"verified_dropin_directory") as folder,
              mock.patch.object(m,"props",side_effect=fixture_props),
              mock.patch.object(m,"call") as runner):
            m.preflight()
        src.assert_called_once_with()
        folder.assert_called_once_with()
        runner.assert_not_called()

    def test_wrong_host_fails_before_source_or_systemd(self):
        with (mock.patch.object(m.os,"geteuid",return_value=0),
              mock.patch.object(m.socket,"gethostname",return_value="other"),
              mock.patch.object(m,"approved_source") as source):
            with self.assertRaisesRegex(m.Block,"OWNER_ROOT_KMJ_ELITE_REQUIRED"):
                m.preflight()
        source.assert_not_called()

    def test_source_sha_manifest_is_fixed_to_signed27_commit(self):
        self.assertEqual(len(m.PINNED_FILES),4)
        self.assertEqual(m.SOURCE_SHA,"40655678db7fa62edca28ccc4988614010253ef1")
        self.assertEqual(m.PINNED_FILES["src/supervisor.js"],
                         "141faa14608c4aedec6b29f65ea4c274f14f17af1e466fdf5554abd597e6e084")
        self.assertIn("ExecStart=\nExecStart=",m.REPLACEMENT)
        self.assertIn(str(m.SOURCE_ROOT),m.REPLACEMENT)
        self.assertNotIn("nginx",m.REPLACEMENT.lower())
        self.assertNotIn("backup",m.REPLACEMENT.lower())

    def test_root_owned_parent_symlink_rejected(self):
        fake=types.SimpleNamespace(st_mode=stat.S_IFLNK|0o777,st_uid=0)
        with mock.patch.object(m.os,"lstat",return_value=fake):
            with self.assertRaisesRegex(m.Block,"ROOT_SOURCE_PARENT_UNTRUSTED"):
                m.one_path_component("/opt")

    def test_wrong_source_mode_denied_without_opening(self):
        fake=types.SimpleNamespace(st_mode=stat.S_IFREG|0o666,
                                   st_uid=0,st_nlink=1,st_size=2048)
        with (mock.patch.object(m.os,"lstat",return_value=fake),
              mock.patch.object(m.os,"open") as opened):
            with self.assertRaisesRegex(m.Block,"PINNED_RELEASE_FILE_UNSAFE"):
                m.pinned_bytes("/dummy/file","a"*64)
        opened.assert_not_called()

    def test_preview_selftest_is_nonprivileged_no_effects(self):
        with mock.patch.object(m,"call") as execute:
            m.selftest()
        execute.assert_not_called()


if __name__=="__main__":
    unittest.main()
