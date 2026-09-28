/**
 * Artifacts a local test, type-check or coverage run leaves in the tree. They are never part
 * of the change the author proposes: the worker removes those the base snapshot did not carry
 * before the patch is frozen (bytecode is already suppressed by PYTHONDONTWRITEBYTECODE) and
 * lists them as generated paths in the outcome.
 */
const GENERATED_DIRECTORIES = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.hypothesis',
  '.tox',
  '.nox',
  '.nyc_output',
  'htmlcov',
  'test-results',
  'playwright-report',
]);
const GENERATED_FILES =
  /(^|\/)(\.coverage(\..+)?|coverage\.xml|cobertura-coverage\.xml|lcov\.info|clover\.xml|coverage-final\.json|junit\.xml|\.eslintcache|\.DS_Store)$|\.py[co]$/;
/** Reports under a `coverage/` directory; its prose (a README) stays. */
const COVERAGE_REPORT = /(^|\/)coverage\/(lcov-report\/|.+\.(html|xml|json|info|css|js)$)/;

export function isGeneratedArtifact(path: string): boolean {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))) return true;
  return GENERATED_FILES.test(path) || COVERAGE_REPORT.test(path);
}
