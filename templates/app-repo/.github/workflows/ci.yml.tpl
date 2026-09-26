# Experimental template: replace command placeholders and pin action revisions.
name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  source-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: {{INSTALL_CMD}}
      - run: {{LINT_CMD}}
      - run: {{TYPECHECK_CMD}}
      - run: {{TEST_CMD}}
