# BNIK Software Factory

GitHub-native workflows for coding agents.

**Private development candidate.** This tree contains the governance core and
experimental adapters. It is not a released or supported local installation.
The release license and distribution notices are still being finalized.

The intended initial workflow starts from a Task, creates an implementation PR,
runs agent review and required CI, and waits for a human to approve and merge.
It targets one explicitly configured repository with the operator's own GitHub
and Claude credentials. The packaged local runtime, isolated worker, onboarding,
and enforcement of that complete workflow are still under development.

## Explore the source

| Package | Responsibility |
| --- | --- |
| `services/github-app` | Webhook authentication, intake, and GitHub App surfaces |
| `services/validator` | Record transitions, policy, audit ledger, and verdicts |
| `services/orchestrator` | Verdict-gated routing to agent roles |
| `services/agents` | Build/review handlers, tools, and model adapters |

See [architecture](docs/architecture.md), [source authority](docs/sources-of-truth.md),
[upstream policy](docs/upstream.md), and [provenance](PROVENANCE.md).

## Check the source locally

From the repository root, with Node and npm installed:

```sh
for service in agents github-app orchestrator validator; do
  (cd "services/$service" && npm ci --ignore-scripts --no-audit --no-fund && npm test && npm run lint && npm run type-check) || exit 1
done
node --test scripts/*.test.mjs
node scripts/gen-architecture-diagrams.mjs --check
```

These checks use fixtures; they do not start a factory or contact a live coding
model. The preparation checks ran on macOS arm64 with Node 26. The supported
container/platform matrix has not been established. Dependency installation
fetches packages under their own terms; see [third-party components](THIRD_PARTY.md).

Existing Azure entrypoints and Dockerfiles are experimental source references.
They are not an installation quickstart. Some entrypoints fall back to stubs
when credentials are absent; a successful process start does not prove a live run.
Goal/Spec/Design, Ops, SRE, Terraform and deployment surfaces are also experimental.
Never enable autonomous merge or deployment for the intended initial profile.
