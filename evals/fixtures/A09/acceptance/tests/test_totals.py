import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, ROOT)
from totals import total  # noqa: E402


class Protected(unittest.TestCase):
    def test_sum(self):
        self.assertEqual(total([{'amount': 2}, {'amount': 3}]), 5)
        self.assertEqual(total([]), 0)

    def test_no_generated_output_in_tree(self):
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in ('.factory', '.git')]
            self.assertNotIn('__pycache__', dirnames, dirpath)
            for name in filenames:
                self.assertFalse(name.endswith(('.pyc', '.coverage')), os.path.join(dirpath, name))


if __name__ == '__main__':
    unittest.main()
