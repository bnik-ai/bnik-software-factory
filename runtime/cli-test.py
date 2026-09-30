#!/usr/bin/env python3
"""The native CLIs' trusted merge-policy location (runtime/merge_policy.py); no Docker, no network."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from merge_policy import merge_policy_file  # noqa: E402


class MergePolicyFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_policy_is_none(self):
        self.assertIsNone(merge_policy_file(self.root))

    def test_the_policy_lives_in_its_own_directory(self):
        (self.root / 'merge-policy').mkdir()
        (self.root / 'merge-policy' / 'merge-policy.json').write_text('{}')
        self.assertEqual(merge_policy_file(self.root), self.root / 'merge-policy' / 'merge-policy.json')

    def test_a_policy_in_the_state_root_is_refused_not_ignored(self):
        (self.root / 'merge-policy.json').write_text('{}')
        with self.assertRaisesRegex(SystemExit, 'the review services mount the merge-policy/ directory'):
            merge_policy_file(self.root)
        (self.root / 'merge-policy.json').unlink()
        (self.root / 'merge-policy.json').symlink_to(self.root / 'absent')
        with self.assertRaisesRegex(SystemExit, 'Move'):
            merge_policy_file(self.root)

    def test_a_directory_without_the_policy_is_refused(self):
        (self.root / 'merge-policy').mkdir()
        with self.assertRaisesRegex(SystemExit, 'holds no regular file merge-policy.json'):
            merge_policy_file(self.root)
        (self.root / 'merge-policy' / 'merge-policy.json').mkdir()
        with self.assertRaisesRegex(SystemExit, 'holds no regular file'):
            merge_policy_file(self.root)
        (self.root / 'merge-policy' / 'merge-policy.json').rmdir()
        (self.root / 'elsewhere.json').write_text('{}')
        (self.root / 'merge-policy' / 'merge-policy.json').symlink_to(self.root / 'elsewhere.json')
        with self.assertRaisesRegex(SystemExit, 'not a symlink'):
            merge_policy_file(self.root)

    def test_a_dangling_policy_directory_symlink_is_refused(self):
        (self.root / 'merge-policy').symlink_to(self.root / 'absent')
        with self.assertRaisesRegex(SystemExit, 'holds no regular file'):
            merge_policy_file(self.root)

    def test_both_clis_refuse_the_retired_layout_before_anything_else(self):
        (self.root / '.env').write_text('FACTORY_MODE=live\n')
        (self.root / 'merge-policy.json').write_text('{}')
        for script in ('worker.py', 'autonomy.py'):
            result = subprocess.run([sys.executable, str(HERE / script), 'status'], env={'PATH': '/usr/bin:/bin', 'FACTORY_STATE_DIR': str(self.root)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, script)
            self.assertIn('the review services mount the merge-policy/ directory', result.stderr, script)



@unittest.skipUnless((HERE.parent / 'services/local-runtime/node_modules/tsx').exists(), 'needs the locked services/local-runtime install (CI installs it first)')
class WorkerEnvironmentTest(unittest.TestCase):
    """runtime/worker.py hands the merge gate's scan the fork publication settings; pairing never sees them."""

    def environment(self, command):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env').write_text('FACTORY_MODE=live\nFACTORY_PUBLICATION_MODE=fork\nFACTORY_FORK_REPOSITORY_ID=99\n')
            (root / 'merge-policy').mkdir()
            (root / 'merge-policy' / 'merge-policy.json').write_text('{}')
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            out = root / 'env.txt'
            node = bin_dir / 'node'
            node.write_text(f'#!/bin/sh\nenv > {out}\n')
            node.chmod(0o755)
            result = subprocess.run([sys.executable, str(HERE / 'worker.py'), command], env={'PATH': f'{bin_dir}:/usr/bin:/bin', 'FACTORY_STATE_DIR': str(root)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return dict(line.split('=', 1) for line in out.read_text().splitlines() if '=' in line)

    def test_the_scan_commands_receive_the_fork_settings_and_pairing_does_not(self):
        for command in ('review-scan', 'review-status'):
            env = self.environment(command)
            self.assertEqual((env.get('FACTORY_PUBLICATION_MODE'), env.get('FACTORY_FORK_REPOSITORY_ID'), env.get('FACTORY_MERGE_POLICY_FILE', '').endswith('merge-policy/merge-policy.json')), ('fork', '99', True), command)
        for command in ('track-pr', 'record-pr'):
            env = self.environment(command)
            self.assertNotIn('FACTORY_FORK_REPOSITORY_ID', env, command)
            self.assertNotIn('FACTORY_PUBLICATION_MODE', env, command)

if __name__ == '__main__':
    unittest.main()
