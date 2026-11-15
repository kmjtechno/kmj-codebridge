"""No-root/no-network negative fixtures for owner one-pass signed updater."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock

SRC=Path(__file__).resolve().parents[1]/"scripts/production/owner_onepass_signed_agent_autoupdate_20261115.py"
spec=importlib.util.spec_from_file_location("kmj_onepass_signed_agent",SRC)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class OnePassSignedAgentTests(unittest.TestCase):
    def patch_root(self):
        return [
            mock.patch.object(m.os,"geteuid",return_value=0),
            mock.patch.object(m.socket,"gethostname",return_value="KMJ-elite"),
            mock.patch.object(m,"SELF",Path(m.__file__)),
            mock.patch.object(m,"verified_source",return_value=b"owner-root-script")
        ]

    def run_with_patches(self,argv,feed_error=False,existing=False):
        events=[]
        class FakeFeed:
            CONFIRM="--confirm-owner-publish-signed27-feed"
            def main(self,args):
                events.append(("feed",tuple(args)))
                if feed_error:raise m.Block("SIGNED_FEED_PREFLIGHT_FAILED")
        class FakeUpdater:
            CONFIRM="--confirm-signed-auto-owner-go"
            def main(self,args):events.append(("updater",tuple(args)))
        def load(path):
            if path==m.FEED:return FakeFeed()
            if path==m.UPDATER:return FakeUpdater()
            raise m.Block("UNAPPROVED_HELPER_PATH")
        patches=self.patch_root()+[
            mock.patch.object(m,"load_helper",side_effect=load),
            mock.patch.object(m,"ensure_approval",side_effect=lambda:events.append(("approval",()))),
            mock.patch.object(m,"read_approval",return_value=True),
            mock.patch.object(m,"existing_signed_feed",return_value=existing),
        ]
        for p in patches:p.start()
        try:
            if feed_error:
                with self.assertRaisesRegex(m.Block,"ONEPASS_FEED_INSPECT_FAILED"):
                    m.run(argv)
            else:m.run(argv)
        finally:
            for p in reversed(patches):p.stop()
        return events

    def test_onepass_apply_order_exact_and_no_gateway(self):
        self.assertEqual(self.run_with_patches(["--apply",m.CONFIRM]),[
            ("feed",("--inspect",)),
            ("feed",("--apply","--confirm-owner-publish-signed27-feed")),
            ("approval",()),
            ("updater",("--enable","--confirm-signed-auto-owner-go")),
        ])

    def test_feed_failure_never_grants_approval_or_enables_timer(self):
        self.assertEqual(self.run_with_patches(["--apply",m.CONFIRM],feed_error=True),[
            ("feed",("--inspect",)),
        ])

    def test_existing_later_signed_feed_skips_seq27_republication(self):
        self.assertEqual(self.run_with_patches(["--apply",m.CONFIRM],existing=True),[
            ("approval",()),
            ("updater",("--enable","--confirm-signed-auto-owner-go")),
        ])

    def test_existing_latest_symlink_is_blocked_before_signature_read(self):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d)
            (base/"real").mkdir()
            (base/"latest").symlink_to(base/"real",target_is_directory=True)
            feed=types.SimpleNamespace(DEST=base/"latest",ancestry=lambda p:None)
            updater=types.SimpleNamespace()
            with self.assertRaisesRegex(m.Block,"EXISTING_LATEST_ROOT_UNTRUSTED"):
                m.existing_signed_feed(feed,updater)

    def test_status_is_no_mutation_and_no_feed(self):
        self.assertEqual(self.run_with_patches(["--status"]),[
            ("updater",()),
        ])

    def test_disable_does_not_touch_feed(self):
        self.assertEqual(self.run_with_patches(["--disable",m.CONFIRM]),[
            ("updater",("--disable","--confirm-signed-auto-owner-go")),
        ])

    def test_signed_existing_feed_with_public_byte_mismatch_is_rejected(self):
        root=Path("/fake-trusted-static/latest")
        files={"release-manifest.json":b"local-manifest",
               "release-manifest.sig":b"local-sig"}
        feed=types.SimpleNamespace(
            DEST=root,
            ancestry=lambda p:None,
            read_owned=lambda p,limit:files[p.name],
        )
        updater=types.SimpleNamespace(
            CONFIG=Path("/fake-config"),
            FEED_MANIFEST="https://trusted/manifest",
            FEED_SIG="https://trusted/sig",
            read_root=lambda p:b"{}",
            parse_config=lambda raw:{},
            verify_feed=lambda cfg:None,
            fetch=lambda url,size=65536:b"different-public-bytes",
        )
        fake_stat=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0)
        with mock.patch.object(m.os.path,"lexists",return_value=True),\
             mock.patch.object(m.os,"lstat",return_value=fake_stat):
            with self.assertRaisesRegex(m.Block,"EXISTING_SIGNED_FEED_UNVERIFIED"):
                m.existing_signed_feed(feed,updater)

    def test_dynamic_paths_or_unapproved_arguments_denied_first(self):
        for args in (["--apply"],["--apply","--force"],
                     ["--install","/tmp/a.py"],["--url","http://evil.example"]):
            with self.subTest(args=args),self.assertRaisesRegex(m.Block,"ONEPASS_UNEXPECTED_ARGS"):
                m.run(args)

    def test_untrusted_helper_path_denied_without_file_read(self):
        with self.assertRaisesRegex(m.Block,"UNAPPROVED_HELPER_PATH"):
            m.verified_source(Path("/tmp/evil.py"))

    def test_owner_policy_exact_scope_and_pin(self):
        self.assertEqual(m.POLICY["allowedComponents"],["agent"])
        self.assertEqual(m.POLICY["minimumSequence"],27)
        self.assertTrue(m.POLICY["ownerGo"])
        self.assertEqual(m.POLICY["keySpkiSha256"],
          "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8")

    def test_owner_policy_create_only_in_disposable_directory(self):
        with tempfile.TemporaryDirectory() as d:
            dest=Path(d)/"policy"/"approval.json"
            actual_lstat=os.lstat
            def fake_lstat(p):
                st=actual_lstat(p)
                return types.SimpleNamespace(st_mode=st.st_mode,st_uid=0,
                                             st_nlink=st.st_nlink,st_size=st.st_size)
            with mock.patch.object(m,"APPROVAL",dest),\
                 mock.patch.object(m,"protected_ancestors"),\
                 mock.patch.object(m,"read_approval",return_value=True),\
                 mock.patch.object(m.os,"lstat",side_effect=fake_lstat):
                m.ensure_approval()
            self.assertEqual(json.loads(dest.read_text()),m.POLICY)
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode),0o600)
            old=dest.read_bytes()
            with mock.patch.object(m,"APPROVAL",dest),\
                 mock.patch.object(m,"protected_ancestors"),\
                 mock.patch.object(m,"read_approval",return_value=True),\
                 mock.patch.object(m.os,"lstat",side_effect=fake_lstat):
                m.ensure_approval()
            self.assertEqual(dest.read_bytes(),old)

    def test_no_arbitrary_root_or_private_signer(self):
        source=SRC.read_text()
        self.assertNotIn("shell=True",source)
        self.assertNotIn("os.system",source)
        self.assertNotIn("curl ",source)
        self.assertNotIn("git pull",source)
        self.assertNotIn("rm -rf",source)
        self.assertIn("ONEPASS_SIGNED_AGENT_AUTOMATION=ENABLED",source)
        self.assertIn("GATEWAY_SUPERVISOR_WINDOWS_AUTOPROMOTION=NOT_ENABLED",source)

if __name__=="__main__":
    unittest.main()
