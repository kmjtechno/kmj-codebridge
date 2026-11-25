"""Hermetic regression tests. No root, network, key or service mutation."""
from __future__ import annotations

import importlib.util
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'scripts' / 'production' / 'elite_fast_release.py'
spec = importlib.util.spec_from_file_location('kmj_elite_fast_release_v1', MODULE)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = '7d8cc8d9e5c5a3d94bcaad520674c1e596730470'
CB_SHA = '1e007c477d8938b621c62832c33d24c80bead4c3'


def response(repo, sha, names):
    return [
        {'object': {'sha': sha}},
        {'workflow_runs': [
            {'head_sha': sha, 'head_branch': 'main', 'name': n,
             'id': 200 + i, 'status': 'completed', 'conclusion': 'success'}
            for i, n in enumerate(names)
        ]},
        {'object': {'sha': sha}},
    ]


class ReleaseTest(unittest.TestCase):
    def test_sha_and_project_scope(self):
        for value in ('main', 'x' * 40, 'a' * 39, 'a' * 41, 'A' * 40, SHA + ';rm -rf /'):
            with self.assertRaises(release.Blocked):
                release.sha_input(value)
        self.assertEqual(release.sha_input(SHA), SHA)
        self.assertEqual(sorted(release.PROJECTS), ['codebridge', 'main-platform'])
        self.assertNotIn('cloudos', release.PROJECTS)

    def test_api_path_scope(self):
        with self.assertRaises(release.Blocked):
            release.github_json('/repos/otherorg/repo/git/ref/heads/main')
        with self.assertRaises(release.Blocked):
            release.github_json('/repos/kmjtechno/../../admin')

    def test_ci_exact_workflow_success(self):
        names = release.PROJECTS['main-platform']['required_workflows']
        with patch.object(release, 'github_json', side_effect=response('x', SHA, names)) as api:
            self.assertEqual(len(release.verify_exact_main_ci('kmjtechno/kmj-main-platform', SHA, names)), 3)
            self.assertEqual(api.call_count, 3)

    def test_ci_missing_required_rejected(self):
        names = release.PROJECTS['main-platform']['required_workflows']
        with patch.object(release, 'github_json', side_effect=response('x', SHA, names[:2])):
            with self.assertRaisesRegex(release.Blocked, 'REQUIRED_CI_CHECK_ABSENT'):
                release.verify_exact_main_ci('kmjtechno/kmj-main-platform', SHA, names)

    def test_ci_failing_or_running_rejected(self):
        names = release.PROJECTS['main-platform']['required_workflows']
        for status, conclusion in [('completed', 'failure'), ('in_progress', None), ('completed', 'skipped')]:
            data = response('x', SHA, names)
            data[1]['workflow_runs'][0]['status'] = status
            data[1]['workflow_runs'][0]['conclusion'] = conclusion
            with patch.object(release, 'github_json', side_effect=data):
                with self.assertRaisesRegex(release.Blocked, 'EXACT_HEAD_CI_NOT_ALL_GREEN'):
                    release.verify_exact_main_ci('kmjtechno/kmj-main-platform', SHA, names)

    def test_ci_main_moved_before_or_after_checks_rejected(self):
        names = release.PROJECTS['main-platform']['required_workflows']
        for idx in (0, 2):
            data = response('x', SHA, names)
            data[idx]['object']['sha'] = 'b' * 40
            with patch.object(release, 'github_json', side_effect=data):
                with self.assertRaises(release.Blocked):
                    release.verify_exact_main_ci('kmjtechno/kmj-main-platform', SHA, names)

    def test_ci_latest_success_supersedes_old_cancelled_attempt(self):
        names = release.PROJECTS['codebridge']['required_workflows']
        data = response('x', CB_SHA, names)
        data[1]['workflow_runs'].append({
            'head_sha': CB_SHA, 'head_branch': 'main', 'name': names[0],
            'id': 1, 'status': 'completed', 'conclusion': 'cancelled',
        })
        with patch.object(release, 'github_json', side_effect=data):
            release.verify_exact_main_ci('kmjtechno/kmj-codebridge', CB_SHA, names)

    def test_current_live_already_matches_does_not_mutate(self):
        with patch.object(release, 'trusted_regular_file'), \
             patch.object(release, 'verify_exact_main_ci'), \
             patch.object(release, 'current_main_platform', return_value='platform-' + SHA[:12]), \
             patch.object(release, 'invoke_fixed') as invoke:
            release.run_main_platform('prepare', SHA)
            invoke.assert_not_called()

    def test_main_post_activation_rejects_not_live(self):
        with patch.object(release, 'trusted_regular_file'), \
             patch.object(release, 'current_main_platform', return_value='platform-' + 'a' * 12), \
             patch.object(release, 'invoke_fixed') as invoke:
            with self.assertRaisesRegex(release.Blocked, 'POST_ACTIVATION_SHA_NOT_LIVE'):
                release.run_main_platform('post-activation', SHA)
            invoke.assert_not_called()

    def test_main_prepare_receipt_required(self):
        with patch.object(release, 'trusted_regular_file'), \
             patch.object(release, 'verify_exact_main_ci'), \
             patch.object(release, 'current_main_platform', return_value='platform-' + 'a' * 12), \
             patch.object(release, 'invoke_fixed', return_value='APPROVAL_REVIEW_REQUIRED'):
            with self.assertRaisesRegex(release.Blocked, 'OWNER_RELEASE_RECEIPT_UNVERIFIED'):
                release.run_main_platform('prepare', SHA)

    def test_main_prepare_exact_fixed_invocation(self):
        marker = 'APPROVAL_DONE_PREPARE_ONLY_ACTIVATE_THEN_RUN_POST_ACTIVATION'
        with patch.object(release, 'trusted_regular_file'), \
             patch.object(release, 'verify_exact_main_ci'), \
             patch.object(release, 'current_main_platform', return_value='platform-' + 'a' * 12), \
             patch.object(release, 'invoke_fixed', return_value=marker) as call:
            release.run_main_platform('prepare', SHA)
            args = call.call_args.args[0]
            self.assertEqual(args, ['/bin/bash', str(release.MAIN_HELPER), '--prepare-only', SHA])

    def test_main_helper_path_includes_root_sbin_for_runuser(self):
        # Ubuntu 24.04 has no /usr/bin/runuser; the pinned owner helper calls a bare `runuser`.
        # Without a root-owned sbin dir in PATH, post-activation exits 127 and is reported only
        # as PINNED_OPERATOR_REFUSED_OR_FAILED. PATH must stay root-owned system dirs only.
        marker = 'CHAIN_EXIT=0'
        with patch.object(release, 'trusted_regular_file'), \
             patch.object(release, 'current_main_platform', return_value='platform-' + SHA[:12]), \
             patch.object(release, 'invoke_fixed', return_value=marker) as call:
            release.run_main_platform('post-activation', SHA)
            env = call.call_args.args[2]
            dirs = env['PATH'].split(':')
            self.assertIn('/usr/sbin', dirs)
            self.assertTrue(all(d in ('/usr/sbin', '/usr/bin', '/sbin', '/bin') for d in dirs))
            self.assertEqual(env['HOME'], '/root')

    def test_dispatcher_pin_matches_reviewed_signer_wrapper(self):
        wrapper = MODULE.parent / 'elite-onehost-release.mjs'
        self.assertEqual(hashlib.sha256(wrapper.read_bytes()).hexdigest(),
                         release.SIGNER_SHA256)
        self.assertIn('/opt/kmj-codebridge-node/bin/node', release.NODE_CANDIDATES)

    def test_signer_requires_inspect_ready(self):
        with patch.object(release, 'trusted_regular_file'), \
             patch.object(release, 'verified_node24', return_value='/usr/bin/node'), \
             patch.object(release, 'invoke_fixed', return_value='ELITE_ONEHOST=BLOCKED:REVIEW_REQUIRED') as invoke:
            with self.assertRaisesRegex(release.Blocked, 'OWNER_SIGNER_NOT_ATTESTED'):
                release.run_codebridge('sign', CB_SHA)
            self.assertEqual(invoke.call_count, 1)

    def test_owner_confirm_required_for_each_mutation(self):
        with patch.object(release, 'require_elite_root'), patch.object(release, 'require_installed_self'):
            for action, project in [('prepare', 'main-platform'), ('release', 'main-platform'),
                                    ('post-activation', 'main-platform'), ('sign', 'codebridge')]:
                with self.assertRaisesRegex(release.Blocked, 'EXPLICIT_OWNER_APPROVAL_REQUIRED'):
                    release.main(['--project', project, '--action', action, '--sha', SHA])

    def test_unapproved_project_and_action_rejected(self):
        with patch.object(release, 'require_elite_root'), patch.object(release, 'require_installed_self'):
            with self.assertRaisesRegex(release.Blocked, 'PROJECT_ADAPTER_NOT_APPROVED'):
                release.main(['--project', 'cloudos', '--action', 'release', '--sha', SHA,
                              '--confirm', release.CONFIRM])
            with self.assertRaisesRegex(release.Blocked, 'ACTION_NOT_APPROVED_FOR_PROJECT'):
                release.main(['--project', 'codebridge', '--action', 'release', '--sha', SHA,
                              '--confirm', release.CONFIRM])

    def test_untrusted_node_from_tmp_is_rejected(self):
        # Never execute an attacker-modifiable path while preparing signer.
        with patch.object(release.Path, 'resolve', return_value=Path('/tmp/kmj-untrusted-node')):
            self.assertIsNone(release.trusted_node24_binary('/usr/bin/node'))

    def test_signer_cannot_be_root(self):
        # Invocation always enters dedicated non-root signer account.
        text = MODULE.read_text()
        self.assertIn("[RUNUSER, '-u', 'kmjsigner', '--', node, str(SIGNER)]", text)
        self.assertNotIn('shell=True', text)
        self.assertNotIn('os.system(', text)

class StatusTest(unittest.TestCase):
    def test_status_listed_and_needs_no_confirmation(self):
        for project in ('main-platform', 'codebridge'):
            self.assertIn('status', release.PROJECTS[project]['actions'])

    def test_main_platform_status_is_read_only_and_reports_live_match(self):
        names = release.PROJECTS['main-platform']['required_workflows']
        data = [{'object': {'sha': SHA}}, response('x', SHA, names)[1]]
        out = []
        with patch.object(release, 'github_json', side_effect=data), \
             patch.object(release, 'current_main_platform', return_value='platform-' + SHA[:12]), \
             patch('builtins.print', side_effect=lambda *a: out.append(' '.join(map(str, a)))):
            release.run_status('main-platform')
        self.assertIn('CI_ALL=GREEN', out)
        self.assertIn('LIVE_MATCHES_MAIN_HEAD=YES', out)
        self.assertIn('FAST_RELEASE=STATUS_READ_ONLY', out)

    def test_status_reports_red_and_pending_without_raising(self):
        names = release.PROJECTS['main-platform']['required_workflows']
        runs = response('x', SHA, names)[1]
        runs['workflow_runs'][0]['conclusion'] = 'failure'
        runs['workflow_runs'][1]['status'] = 'in_progress'
        out = []
        with patch.object(release, 'github_json', side_effect=[{'object': {'sha': SHA}}, runs]), \
             patch.object(release, 'current_main_platform', return_value='platform-aaaaaaaaaaaa'), \
             patch('builtins.print', side_effect=lambda *a: out.append(' '.join(map(str, a)))):
            release.run_status('main-platform')
        self.assertIn('CI_ALL=NOT_GREEN', out)
        self.assertIn('LIVE_MATCHES_MAIN_HEAD=NO', out)
        self.assertTrue(any(x.endswith('=FAIL') for x in out))
        self.assertTrue(any(x.endswith('=PENDING') for x in out))

    def test_codebridge_status_reads_updater_line_and_never_touches_signer(self):
        names = release.PROJECTS['codebridge']['required_workflows']
        data = [{'object': {'sha': CB_SHA}}, response('x', CB_SHA, names)[1]]
        out = []
        fake = type('R', (), {'stdout': 'noise\nKMJ CodeBridge stable update complete; version 0.3.2, sequence 35, updated=false.\n'})()
        with patch.object(release, 'github_json', side_effect=data), \
             patch.object(release, 'trusted_regular_file', side_effect=AssertionError('signer must not be touched')), \
             patch.object(release.subprocess, 'run', return_value=fake), \
             patch('builtins.print', side_effect=lambda *a: out.append(' '.join(map(str, a)))):
            release.run_status('codebridge')
        self.assertIn('CODEBRIDGE_LIVE_VERSION=0.3.2', out)
        self.assertIn('CODEBRIDGE_LIVE_SEQUENCE=35', out)
        self.assertIn('CODEBRIDGE_SIGNING=OWNER_OFFLINE_KEY_ON_P520', out)

    def test_codebridge_status_without_updater_line_is_unknown_not_invented(self):
        fake = type('R', (), {'stdout': 'nothing useful'})()
        with patch.object(release.subprocess, 'run', return_value=fake):
            self.assertIsNone(release.codebridge_live_from_updater())

    def test_status_rejects_sha_argument_and_confirm(self):
        with patch.object(release, 'require_elite_root'), patch.object(release, 'require_installed_self'):
            with self.assertRaises(release.Blocked):
                release.main(['--project', 'codebridge', '--action', 'status', '--sha', CB_SHA])
            with self.assertRaises(release.Blocked):
                release.main(['--project', 'codebridge', '--action', 'status', '--confirm', release.CONFIRM])


if __name__ == '__main__':
    unittest.main()
