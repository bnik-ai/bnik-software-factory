import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')))
from durations import parse_duration  # noqa: E402


class Reproducer(unittest.TestCase):
    def test_combined(self):
        self.assertEqual(parse_duration('1h30m'), 90)


if __name__ == '__main__':
    unittest.main()
