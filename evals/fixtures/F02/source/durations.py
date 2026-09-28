"""Parse compact durations such as '1h30m' into minutes."""
import re

_UNITS = {'h': 60, 'm': 1}


def parse_duration(text):
    total = 0
    for amount, unit in re.findall(r'(\d+)([hm])', text):
        total = int(amount) * _UNITS[unit]
    return total
