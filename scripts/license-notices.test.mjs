import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Apache-2.0 section 4: a redistribution carries the License and the NOTICE file. Every runtime
// image that ships the provenance statement (which points to both) ships both.
const root = fileURLToPath(new URL('..', import.meta.url));
function dockerfiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? dockerfiles(join(dir, entry.name))
      : entry.name === 'Dockerfile'
        ? [join(dir, entry.name)]
        : [],
  );
}

test('every runtime image that copies PROVENANCE.md also copies LICENSE and NOTICE', () => {
  const images = dockerfiles('runtime');
  assert.ok(images.length >= 3, images.join(', '));
  for (const file of images) {
    const copies = readFileSync(join(root, file), 'utf8')
      .split('\n')
      .filter((line) => /^COPY\b/.test(line))
      .join(' ');
    if (!/\bPROVENANCE\.md\b/.test(copies)) continue;
    assert.match(copies, /\bLICENSE\b/, file);
    assert.match(copies, /\bNOTICE\b/, file);
  }
});

test('NOTICE names the project and its copyright holder', () => {
  assert.equal(
    readFileSync(join(root, 'NOTICE'), 'utf8'),
    'BNIK Software Factory\nCopyright 2026 Babak Nikanjam\n',
  );
});
