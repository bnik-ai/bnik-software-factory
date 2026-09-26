#!/usr/bin/env python3
"""Create a synthetic source archive and explicit demo job in a new directory."""
import gzip
import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path

FILES = {
    'sum.js': 'module.exports = (a, b) => a - b;\n',
    'sum.test.js': "const assert = require('node:assert/strict');\nconst test = require('node:test');\nconst sum = require('./sum');\ntest('adds values', () => assert.equal(sum(2, 3), 5));\n",
    'test_tools.py': "import unittest\nclass Tools(unittest.TestCase):\n    def test_arithmetic(self):\n        self.assertEqual(2 + 3, 5)\n",
}


def archive(files):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w') as tar:
        for name, content in files.items():
            blob = content.encode()
            info = tarfile.TarInfo('source/' + name)
            info.size = len(blob)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(blob))
    return gzip.compress(data.getvalue(), mtime=0)


if __name__ == '__main__':
    root = Path(sys.argv[1]).resolve()
    root.mkdir(mode=0o700)
    source = archive(FILES)
    (root / 'source.tar.gz').write_bytes(source)
    job = dict(id='local-coding-demo', mode='demo', repository='example/factory-demo', sourceCommit='1' * 40, archiveSha256=hashlib.sha256(source).hexdigest(), prompt='Fix sum.js and run the declared checks.', maxTurns=2, timeoutMs=30000, fixtureCommand="printf 'module.exports = (a, b) => a + b;\\n' > sum.js", tests=['node --test sum.test.js', 'python3 -m unittest -v', 'bash --version | head -1; git --version; node --version; python3 --version'])
    (root / 'job.json').write_text(json.dumps(job, indent=2) + '\n')
    print('Created synthetic archive and job. No credentials or live model are used.')
