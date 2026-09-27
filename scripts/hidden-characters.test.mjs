import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Trojan Source (CVE-2021-42574): direction controls make code render differently
// from how it compiles. Formatters can silently turn escapes into these characters.
const DIRECTION_CONTROLS = new RegExp(
  `[${[0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    .map((codePoint) => `\\u${codePoint.toString(16).padStart(4, '0')}`)
    .join('')}]`,
);

test('no tracked text file contains hidden text-direction controls', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const offenders = files.filter((file) => {
    let content;
    try {
      content = readFileSync(file);
    } catch {
      return false;
    }
    if (content.includes(0)) return false;
    return DIRECTION_CONTROLS.test(content.toString('utf8'));
  });
  assert.deepEqual(offenders, []);
});
