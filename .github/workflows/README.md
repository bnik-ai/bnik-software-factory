# Candidate workflows

- `contributor-ci.yml`: read-only PR/main checks, generated docs, credential-free
  PostgreSQL and isolated worker integration. Require the `contributor-ci` result.
- `node-ci.yml`: fixed-runtime reusable service checks; only declared service paths.
- `candidate-build.yml`: manual deterministic source archive from an exact commit,
  retained as a workflow artifact. No public publication.

All actions are pinned. No workflow receives deployment or model secrets. See
[the CI and build contract](../../docs/contributor-ci.md) for fork settings, commands,
runtime support, paid-test separation and reproducibility limits.
