"""V2 release entrypoint tests: no keys, network, root or service mutation."""
import importlib.util
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
import io

ROOT = Path(__file__).resolve().parents[1] / 'scripts' / 'production'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


release = load('elite_fast_release_v2')
install = load('elite_fast_release_v2_install')
SHA = 'a' * 40


class OneClickTest(unittest.TestCase):
    def test_versioned_pins(self):
        self.assertEqual(hashlib.sha256((ROOT / 'elite_fast_release_v2.py').read_bytes()).hexdigest(),
                         install.CODEBRIDGE_OPERATOR_SHA256)
        self.assertEqual(hashlib.sha256((ROOT / 'elite-onehost-release-v2.mjs').read_bytes()).hexdigest(),
                         release.SIGNER_SHA256)
        for source, digest, _ in install.SIGNER_SOURCES:
            path = ROOT.parent.parent / source
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)

    def test_release_auto_discovers_sha_and_binds_operator(self):
        ready = 'ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN\nSIGNED_DEPLOY_TIMER=ACTIVE'
        signed = ('ELITE_OWNER_SIGN=REVIEW_GATED\nAUTO_SIGNED_SHA=' + SHA +
                  '\nAUTO_SIGNED_SEQUENCE=44\nAUTO_SIGNED_PR=https://github.com/kmjtechno/kmj-codebridge/pull/999')
        with patch.object(release, 'trusted_regular_file'), \
             patch.object(release, 'verified_node24', return_value='/usr/bin/node'), \
             patch.object(release, 'github_json', return_value={'object': {'sha': SHA}}), \
             patch.object(release, 'verify_exact_main_ci') as ci, \
             patch.object(release, 'invoke_fixed', side_effect=[ready, signed]) as invoke, \
             redirect_stdout(io.StringIO()) as out:
            release.run_codebridge('release', None)
            self.assertEqual(ci.call_args.args[1], SHA)
            self.assertEqual(invoke.call_args.args[0][-2:], ['--sign-once', SHA])
            self.assertIn('FAST_RELEASE=SIGNED_PR_REVIEW_REQUIRED_NOT_LIVE', out.getvalue())

    def test_preflight_never_signs(self):
        ready = 'ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN\nSIGNED_DEPLOY_TIMER=ACTIVE'
        receipt = 'ELITE_OWNER_PREFLIGHT=READY\nAUTO_SIGNED_SHA=' + SHA + '\nAUTO_SIGNED_SEQUENCE=44'
        with patch.object(release, 'trusted_regular_file'), \
             patch.object(release, 'verified_node24', return_value='/usr/bin/node'), \
             patch.object(release, 'verify_exact_main_ci'), \
             patch.object(release, 'invoke_fixed', side_effect=[ready, receipt]) as invoke, \
             redirect_stdout(io.StringIO()) as out:
            release.run_codebridge('preflight', SHA)
            self.assertEqual(invoke.call_args.args[0][-2:], ['--preflight', SHA])
            self.assertIn('PREFLIGHT_READY_NOT_SIGNED', out.getvalue())

    def test_redaction(self):
        self.assertEqual(release.signer_blocker('ELITE_ONEHOST=BLOCKED:SEQUENCE_POLICY_EXHAUSTED'),
                         'SEQUENCE_POLICY_EXHAUSTED')
        self.assertEqual(release.signer_blocker('ELITE_ONEHOST=BLOCKED:PRIVATE_DATA'),
                         'PINNED_OPERATOR_REFUSED_OR_FAILED')

    def test_no_confirmation_no_release(self):
        with patch.object(release, 'require_elite_root'), \
             patch.object(release, 'require_installed_self'), \
             patch.object(release, 'run_codebridge') as run:
            with self.assertRaisesRegex(release.Blocked, 'EXPLICIT_OWNER_APPROVAL_REQUIRED'):
                release.main(['--project', 'codebridge', '--action', 'release'])
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
