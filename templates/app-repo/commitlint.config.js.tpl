// Generated from {{FACTORY_REPO}}/templates/app-repo/commitlint.config.js.tpl
// Extends @commitlint/config-conventional for its structural rules and replaces its type
// list with eight commit intents: add, fix, change, remove, update, perf, secure, docs.
// Other types, such as feat, chore, refactor, test and ci, are rejected. Subjects are lower
// case with no trailing full stop; headers are at most 100 characters.

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
