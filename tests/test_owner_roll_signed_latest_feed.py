"""Pure/isolated offline QA for the owner signed rolling latest-feed publisher."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SRC=Path(__file__).resolve().parents[1]/"scripts/production/owner_roll_signed_latest_feed_20261115.py"
spec=importlib.util.spec_from_file_location("kmj_rolling_signed_latest_review",SRC)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

A="a"*40
B="b"*40
def manifest(seq,rev):
    data={
      "schema":1,"product":"KMJ CodeBridge","channel":"stable",
      "keyId":"kmj-release-2026","sequence":seq,"nodeMajor":24,
      "revision":rev,"version":"0.3.2","bytes":12345,
      "sha256":"f"*64,
      "archive":f"{m.ORIGIN}/{rev}/kmj-codebridge-0.3.2-{rev[:12]}.tar.gz",
    }
    return json.dumps(data).encode()

def pair(seq,rev):
    return {"release-manifest.json":manifest(seq,rev),
            "release-manifest.sig":b"Q"*86+b"\n"}

class SignedLatestRollingOfflineTests(unittest.TestCase):
    def test_signed_manifest_shape_admitted_only_after_crypto(self):
        raw=manifest(28,B)
        with mock.patch.object(m,"verify_signature") as verifier:
            info,archive=m.parse_signed(raw,b"Q"*86,B,"public")
            self.assertEqual(info["sequence"],28)
            self.assertTrue(archive.endswith(B[:12]+".tar.gz"))
            verifier.assert_called_once()

    def test_unsigned_origin_and_wrong_revision_denied(self):
        old=json.loads(manifest(28,B))
        for changes in (
            {"channel":"beta"},
            {"archive":"https://other.example/evil.tar.gz"},
            {"revision":A},
            {"keyId":"attacker"},
            {"nodeMajor":22},
            {"sequence":-1},
            {"bytes":0},
        ):
            with self.subTest(changes=changes):
                item={**old,**changes}
                with mock.patch.object(m,"verify_signature") as verifier:
                    with self.assertRaises(m.Block):
                        m.parse_signed(json.dumps(item).encode(),b"sig",B,"public")
                    verifier.assert_not_called()

    def test_bad_detached_signature_rejected_without_node(self):
        with mock.patch.object(m,"pinned_call") as run:
            with self.assertRaisesRegex(m.Block,"SIGNED_RELEASE_SIGNATURE_INVALID"):
                m.verify_signature(manifest(28,B),b"invalid","not-trusted")
            run.assert_not_called()

    def test_strict_cli_excludes_url_and_shell_choices(self):
        for args in (["--url","https://untrusted.example"],
                     ["--apply"],["--rollback"],
                     ["--apply",m.CONFIRM,"/tmp/path"]):
            with self.subTest(args=args),self.assertRaisesRegex(m.Block,"UNEXPECTED_ARGUMENTS"):
                m.main(args)

    def test_choose_highest_signed_candidate(self):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d)
            (base/A).mkdir()
            (base/B).mkdir()
            with mock.patch.object(m,"ROOT",base),mock.patch.object(m,"trusted_parent_chain"),\
                 mock.patch.object(m,"validated_release",
                                   side_effect=lambda rev,pub:(
                                      {"sequence":28 if rev==B else 27,"revision":rev},
                                      "fixture.tar.gz",pair(28 if rev==B else 27,rev))):
                result=m.choose_candidate("public")
                self.assertEqual(result[:2],(28,B))

    def test_duplicate_sequence_never_selects_arbitrary_revision(self):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d)
            (base/A).mkdir();(base/B).mkdir()
            with mock.patch.object(m,"ROOT",base),mock.patch.object(m,"trusted_parent_chain"),\
                 mock.patch.object(m,"validated_release",
                                   side_effect=lambda rev,pub:(
                                      {"sequence":27,"revision":rev},
                                      "fixture.tar.gz",pair(27,rev))):
                with self.assertRaisesRegex(m.Block,"SIGNED_SEQUENCE_DUPLICATE"):
                    m.choose_candidate("public")

    def test_rollback_source_must_match_old_signed_pair_and_public_archive(self):
        current=({"sequence":27,"revision":A},"old.tar.gz",pair(27,A))
        with mock.patch.object(m,"validated_release",
                               return_value=({"sequence":27,"revision":A},
                                             "old.tar.gz",pair(28,B))),\
             mock.patch.object(m,"public_archive") as public:
            with self.assertRaisesRegex(m.Block,"ROLLBACK_SOURCE_UNVERIFIED"):
                m.rollback_ready(current,"public")
            public.assert_not_called()
        with mock.patch.object(m,"validated_release",
                               return_value=current),\
             mock.patch.object(m,"public_archive") as public:
            m.rollback_ready(current,"public")
            public.assert_called_once()

    def test_no_signed_release_is_denied(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(m,"ROOT",Path(d)),mock.patch.object(m,"trusted_parent_chain"):
                with self.assertRaisesRegex(m.Block,"NO_IMMUTABLE_SIGNED_RELEASES"):
                    m.choose_candidate("public")

    def test_first_roll_requires_existing_owner_signed_feed(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(m,"LATEST",Path(d)/"latest"):
                with self.assertRaisesRegex(m.Block,"INITIAL_FEED_REQUIRES_SIGNED27_BOOTSTRAP"):
                    m.latest_current("public")

    def test_public_urls_cannot_be_redirected_to_untrusted_host(self):
        with mock.patch.object(m,"pinned_call") as run:
            with self.assertRaisesRegex(m.Block,"PUBLIC_RELATIVE_PATH_INVALID"):
                m.https_bytes("https://evil.example/path",b"data")
            run.assert_not_called()

    @unittest.skipUnless(os.name=="posix" and hasattr(os,"O_DIRECTORY"),"Linux only")
    def test_atomic_roll_preserves_previous_pair(self):
        self._roll_test(fail_public=False)

    @unittest.skipUnless(os.name=="posix" and hasattr(os,"O_DIRECTORY"),"Linux only")
    def test_public_failure_restores_previous_pair(self):
        self._roll_test(fail_public=True)

    def _roll_test(self,fail_public):
        old=pair(27,A);new=pair(28,B)
        with tempfile.TemporaryDirectory() as d:
            base=Path(d)
            (base/"latest").mkdir()
            for name,b in old.items():(base/"latest"/name).write_bytes(b)
            def current(pub):
                raw=(base/"latest"/"release-manifest.json").read_bytes()
                if raw==old["release-manifest.json"]:
                    return {"sequence":27,"revision":A},None,old
                if raw==new["release-manifest.json"]:
                    return {"sequence":28,"revision":B},None,new
                raise m.Block("TEST_DRIFT")
            def public(*args):
                if fail_public:raise m.Block("PUBLIC_SIGNED_BYTES_MISMATCH")
            lockfile=base/"lock"
            lockfile.touch()
            def lock():
                return os.open(lockfile,os.O_RDONLY)
            def read_owned(path,limit):
                return Path(path).read_bytes()
            with mock.patch.object(m,"ROOT",base),mock.patch.object(m,"LATEST",base/"latest"),\
                 mock.patch.object(m,"latest_current",side_effect=current),\
                 mock.patch.object(m,"lock_owner",side_effect=lock),\
                 mock.patch.object(m,"regular_bytes",side_effect=read_owned),\
                 mock.patch.object(m,"https_bytes",side_effect=public):
                candidate=(28,B,{"sequence":28,"revision":B},"fixture.tar.gz",new)
                if fail_public:
                    with self.assertRaisesRegex(m.Block,
                         "PUBLIC_READBACK_FAILED_PREVIOUS_FEED_RESTORED"):
                        m.roll_once("public",current("public"),candidate)
                else:
                    m.roll_once("public",current("public"),candidate)
                expected=old if fail_public else new
                self.assertEqual({n:(base/"latest"/n).read_bytes() for n in expected},expected)
                retired=list(base.glob(".kmj-latest-roll-*"))
                self.assertEqual(len(retired),1)
                archived=new if fail_public else old
                self.assertEqual({n:(retired[0]/n).read_bytes() for n in archived},archived)

    def test_no_shell_or_unapproved_automatic_signing(self):
        source=SRC.read_text()
        for bad in ("shell=True","os.system","git pull","rm -rf"):
            self.assertNotIn(bad,source)
        self.assertIn("OWNER_SPKI",source)
        self.assertIn("RENAME_EXCHANGE",source)
        self.assertIn("PREVIOUS_SIGNED_PAIR=PRESERVED",source)
        self.assertIn("PRODUCTION_SERVICE_MUTATION=NONE",source)

if __name__=="__main__":
    unittest.main()
