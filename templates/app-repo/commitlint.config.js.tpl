// Generated from {{FACTORY_REPO}}/templates/app-repo/commitlint.config.js.tpl
// Enforces the bnik commit convention per AGENTS.md hard constraint 6.
//
// Intent vocabulary: add / fix / change / remove / update / perf / secure / docs.
// This is the canonical set used across all bnik repos (software-factory, platform-overlay,
// factory-produced apps). It is INTENTIONALLY DIFFERENT from the legacy
// feat/chore/refactor/test/ci set — those types are rejected by this config.
//
// See {{FACTORY_REPO}}/templates/app-repo/AGENTS.md.tpl §6 and the commit-conventions
// skill in the bnik agent toolchain for the full convention.
//
// Note on @commitlint/config-conventional extension: we extend the base config to inherit
// the structural rules (subject format, header length, leading-blank requirements) but
// override type-enum to enforce the bnik intent set instead of the conventional-commits
// type set. Without the override, BuildAgent / ReviewAgent commits would be rejected.

module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['add', 'fix', 'change', 'remove', 'update', 'perf', 'secure', 'docs'],
    ],
    'subject-case': [2, 'always', 'lower-case'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    'body-leading-blank': [1, 'always'],
    'footer-leading-blank': [1, 'always'],
  },
};
