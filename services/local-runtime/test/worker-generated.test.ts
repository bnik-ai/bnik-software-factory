import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGeneratedArtifact } from '../src/worker/generated.js';

test('generated test and coverage artifacts are recognised by path; source, tests and vendored code are not', () => {
  for (const path of [
    'tests/__pycache__/test_totals.cpython-313.pyc',
    'pkg/module.pyc',
    '.pytest_cache/v/cache/nodeids',
    'src/.mypy_cache/3.13/x.json',
    '.coverage',
    '.coverage.host.1234',
    'coverage.xml',
    'coverage/lcov.info',
    'coverage/lcov-report/index.html',
    'coverage/coverage-final.json',
    '.nyc_output/out.json',
    'htmlcov/index.html',
    'junit.xml',
    '.DS_Store',
    'coverage/index.html',
    'coverage/cobertura-coverage.xml',
    'coverage/coverage-summary.json',
    '.eslintcache',
    'test-results/results.xml',
    'playwright-report/index.html',
  ])
    assert.ok(isGeneratedArtifact(path), path);
  for (const path of [
    'totals.py',
    'tests/test_totals.py',
    'src/coverage.js',
    'coverage/README.md',
    'docs/coverage-policy.md',
    'vendor/lib.py',
    'test/page.test.js',
    'pycache_notes.md',
    '__pycache__',
  ])
    assert.ok(!isGeneratedArtifact(path), path);
});
