import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')))
from durations import parse_duration  # noqa: E402


class Protected(unittest.TestCase):
    def test_units(self):
        self.assertEqual(parse_duration('2h'), 120)
        self.assertEqual(parse_duration('45m'), 45)
        self.assertEqual(parse_duration('1h30m'), 90)
        self.assertEqual(parse_duration('2h5m'), 125)

    def test_empty(self):
        self.assertEqual(parse_duration(''), 0)


if __name__ == '__main__':
    unittest.main()
