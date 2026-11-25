"""Offline checks for the exact owner-only dispatcher upgrade."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'scripts' / 'production'
spec = importlib.util.spec_from_file_location(
    'fast_pin_upgrade', ROOT / 'owner_upgrade_fast_release_pin_20261125.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class PinUpgradeTest(unittest.TestCase):
    def test_exact_reviewed_predecessor_to_successor(self):
        new = (ROOT / 'elite_fast_release.py').read_bytes()
        self.assertEqual(upgrade.digest(new), upgrade.NEW)
        old = new.replace(upgrade.NEW_WRAPPER.encode(), upgrade.OLD_WRAPPER.encode())
        old = old.replace(
            b'# Reviewed 2026-11-23 signer CI-gate upgrade; never trust a runtime-supplied hash.',
            b'# Independent immutable pin from CodeBridge root-only signer installation contract.')
        old = old.replace(
            b"NODE_CANDIDATES = ('/opt/kmj-codebridge-node/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/opt/node24/bin/node')",
            b"NODE_CANDIDATES = ('/usr/local/bin/node', '/usr/bin/node', '/opt/node24/bin/node')")
        self.assertEqual(upgrade.digest(old), upgrade.OLD)
        self.assertEqual(upgrade.successor(old), new)
        with self.assertRaisesRegex(ValueError, 'DISPATCHER_PREDECESSOR_SHA_MISMATCH'):
            upgrade.successor(old + b'\n')

    def test_signer_pair_pins_match_reviewed_sources(self):
        self.assertEqual(upgrade.digest((ROOT / 'elite-onehost-release.mjs').read_bytes()),
                         upgrade.NEW_WRAPPER)
        self.assertEqual(upgrade.digest((ROOT.parent / 'release-ci-gate.mjs').read_bytes()),
                         upgrade.NEW_GATE)

    def test_unknown_arguments_stop_before_host_access(self):
        with self.assertRaisesRegex(ValueError, 'ARGUMENTS_REJECTED'):
            upgrade.main(['--apply'])


if __name__ == '__main__':
    unittest.main()
