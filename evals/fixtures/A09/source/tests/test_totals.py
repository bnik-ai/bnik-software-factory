import unittest
from totals import total


class Totals(unittest.TestCase):
    def test_sum(self):
        self.assertEqual(total([{'amount': 2}, {'amount': 3}]), 5)


if __name__ == '__main__':
    unittest.main()
