# BNIK Software Factory

GitHub-native workflows for coding agents.

**Private development candidate.** This tree includes a packaged PostgreSQL control plane
and an explicit, credential-free demo. It is not a released end-to-end alpha.
The release license and distribution notices are still being finalized.

The intended initial workflow starts from a Task, creates an implementation PR,
runs agent review and required CI, and waits for a human to approve and merge.
It targets one explicitly configured repository with the operator's own GitHub
and Claude credentials. An explicit isolated coding executor is available;
enforcement of the complete workflow remains under development.

Run the [local demo and durable-runtime checks](docs/local-runtime.md), then follow
the [GitHub App installation and human activation guide](docs/github-installation.md).
Live intake verifies the configured installation and stores authorized Task receipts.
Execution requires a separate, explicit local command and current human authorization.
Run the separate [isolated worker example](docs/isolated-worker.md) to produce a
patch and actual test-command receipts from a disposable container.
For explicitly paired PRs, the [human merge profile](docs/human-merge.md) verifies
GitHub protection, human approval and required CI, then reconciles the Task.

## Explore the source

| Package | Responsibility |
| --- | --- |
| `services/github-app` | Webhook authentication, intake, and GitHub App surfaces |
| `services/validator` | Record transitions, policy, audit ledger, and verdicts |
| `services/orchestrator` | Verdict-gated routing to agent roles |
| `services/local-runtime` | PostgreSQL queues, atomic handoffs, local authentication and packaging |
| `services/agents` | Build/review handlers, tools, and model adapters |

See [architecture](docs/architecture.md), [source authority](docs/sources-of-truth.md),
[upstream policy](docs/upstream.md), and [provenance](PROVENANCE.md).

## Check the source locally

From the repository root, with Node and npm installed:

```sh
for service in agents github-app orchestrator validator local-runtime; do
  (cd "services/$service" && npm ci --ignore-scripts --no-audit --no-fund && npm test && npm run lint && npm run type-check) || exit 1
done
node --test scripts/*.test.mjs
node scripts/gen-architecture-diagrams.mjs --check
```

These checks use fixtures; they do not start a factory or contact a live coding
model. [Contributor CI and source artifacts](docs/contributor-ci.md) select Linux x64 and
Node 24.21.0. Linux arm64 runtime containers are also verified on macOS Docker
Desktop; local source checks have run on macOS arm64 with Node 26. Dependency installation
fetches packages under their own terms; see [third-party components](THIRD_PARTY.md).

Existing Azure entrypoints and Dockerfiles are experimental source references.
They are not an installation quickstart. Some entrypoints fall back to stubs
when credentials are absent; a successful process start does not prove a live run.
Goal/Spec/Design, Ops, SRE, Terraform and deployment surfaces are also experimental.
Never enable autonomous merge or deployment for the intended initial profile.

For a real model and human-review pilot, see the [end-to-end walkthrough](docs/end-to-end-pilot.md). Its live execution evidence is a separate requirement; examples alone do not establish completion.
