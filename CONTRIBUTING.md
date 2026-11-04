# Contributing

This repository is archived at `0.1.0-alpha` and accepts no contributions; fork it to change
it. See [support](SUPPORT.md). The process below is the workflow this project used, kept for a
fork that adopts it.

## Propose and implement a change

Use an issue for a non-sensitive bug or focused proposal; follow [SECURITY.md](SECURITY.md)
for vulnerabilities. Explain the user-visible problem and a small reproducible
example. Discuss significant architecture, permissions or dependency changes before
implementation. Use synthetic data in fixtures and documentation.

Create a focused branch and PR against the development branch. Preserve unrelated
changes. Include the problem, resulting behavior, relevant tests, documentation
changes and limitations. Disclose AI assistance and verify its output as the human
contributor; a model's claim that tests passed is not a test receipt. Never submit
credentials, private source, generated operator configuration, installed dependencies
or internal preparation records.

Only contribute material you have authority to submit. Identify copied/adapted
third-party code and preserve its notices. Had contributions opened, intentionally submitted contributions would have been accepted under
the project's [Apache-2.0 license](LICENSE), unless explicitly stated otherwise and
agreed before submission, with no separate CLA or copyright assignment.

## Local checks

Use Node 24.21.0 and npm. From the repository root:

```sh
(for service in agents github-app orchestrator validator local-runtime; do
  (cd "services/$service" && npm ci --ignore-scripts --no-audit --no-fund && npm test && npm run lint && npm run type-check) || exit 1
done)
node --test scripts/*.test.mjs
node scripts/gen-architecture-diagrams.mjs --check
python3 runtime/cli-test.py
python3 runtime/evals/live-test.py
```

Installs download locked packages under their own terms and skip lifecycle scripts.
Tests use fixtures, not paid provider calls. For queue, migration, activation,
recovery or worker changes, also run the relevant Docker integration suites:

```sh
python3 runtime/test.py
python3 runtime/worker/test.py
```

These suites create and clean disposable fixtures. Never point tests at an operator's
live database. Review [CI and source artifacts](docs/contributor-ci.md) for runner
permissions and build contracts. For documentation-only changes, verify commands,
relative links and rendered output; run affected source checks if behavior changes.
Regenerate architecture diagrams with
`node scripts/gen-architecture-diagrams.mjs > docs/architecture-diagrams.md`
only when their source model changes, then verify with `--check`.

## Review and acceptance

Human maintainers review scope, correctness, test quality, documentation, dependency
changes and credential boundaries. Required CI must pass on the current head;
new commits may need renewed review. Contributors and bots cannot approve their own
changes to satisfy human review. A maintainer decides whether and when to merge;
there is no guaranteed review or merge timeline. Keep discussion respectful and
technical, and report abusive behavior privately to the confirmed maintainer.

Source CI never receives live model or operator credentials. Paid/live exercises
are separate explicit operator actions. Do not enable privileged PR workflows,
weaken required checks or add a public credential to make CI pass.
