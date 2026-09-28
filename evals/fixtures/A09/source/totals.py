"""Totals over line items."""


def total(lines):
    return sum(line['amount'] for line in lines[:-1])
