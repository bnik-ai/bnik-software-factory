# BNIK Software Factory

BNIK Software Factory turns coding agents into a recoverable, policy-controlled GitHub workflow that you operate locally.

Turn a bounded GitHub Task into a reviewed change using your own repository,
credentials and local runtime. A human authorizes each coding run, an isolated
worker returns a patch and test receipts, an operator publishes the reviewed
output, and a human reviews and merges after required CI. The runtime verifies
the merge and completes the paired Task.

- **Recoverable:** inspect durable work and receipts, reconcile interrupted runs,
  and recover without blindly repeating model calls.
- **Policy-controlled:** enforce authorization, required checks and execution limits,
  with recorded evidence for workflow decisions.
- **Locally operated:** run the factory through Docker using your own repository
  and credentials. Live work still connects to GitHub and the model provider.

**Private alpha candidate; not yet released.** Apache-2.0 is selected for project-owned source; public attribution and maintainer
identity are being finalized. No public repository, installation service or
prebuilt image is available from this tree. See the [license](LICENSE), [support status](SUPPORT.md),
[provenance](PROVENANCE.md) and [third-party terms](THIRD_PARTY.md).

```text
Human Task activation -> Isolated build -> Patch + test receipts
                                                   |
                                      Operator reviews and publishes
                                                   |
                                 Human review <-> Explicit revision
                                                   |
                                     Required CI on current head
                                                   |
                                      Human merge -> Task completed
```

## Get started

Start with the [credential-free quickstart](docs/quickstart.md). It verifies the
local control plane without a GitHub App or model bill. The `sfac` launcher runs
operator tools in containers; no host Python or Node install is needed. Then try the
[isolated worker example](docs/isolated-worker.md), followed by the
[GitHub installation](docs/github-installation.md) and
[real Task-to-merge walkthrough](docs/end-to-end-pilot.md).

The local profile targets one GitHub.com repository, one operator-controlled
installation and Claude Agent SDK execution. Publication is an explicit operator
step. AI review is advisory; the packaged workflow requires native human review.
This is not an autonomous development or deployment service.

## Documentation

| Need | Guide |
| --- | --- |
| Install, see expected output, troubleshoot and tear down | [Quickstart](docs/quickstart.md) |
| Understand supported and experimental behavior | [Support matrix](SUPPORT.md) and [roadmap](docs/roadmap.md) |
| Understand components and trust boundaries | [Architecture](docs/architecture.md) |
| Register an App and authorize one Task | [GitHub installation](docs/github-installation.md) |
| Configure required CI and human merge | [Human merge](docs/human-merge.md) |
| Inspect usage, cancel work and prune content | [Run controls](docs/run-controls.md) |
| Recover failures and back up the database | [Recovery](docs/recovery.md) and [local runtime](docs/local-runtime.md) |
| Contribute or maintain a release | [Contributing](CONTRIBUTING.md), [maintainer guide](docs/maintaining.md), [CI](docs/contributor-ci.md) |
| Understand or operate bounded autonomy (opt-in, not live-verified) | [Autonomy policy](docs/autonomy-policy.md), [autonomy operations](docs/autonomy-operations.md) and [agent qualification](evals/README.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |
| Review changes and limitations | [Release notes](CHANGELOG.md) |

## Source layout

| Package | Responsibility |
| --- | --- |
| `services/github-app` | Webhook authentication and GitHub App surfaces |
| `services/validator` | Record transitions, policy and audit ledger |
| `services/orchestrator` | Verdict-gated routing to agent roles |
| `services/local-runtime` | PostgreSQL queues, activation, isolated execution and merge reconciliation |
| `services/agents` | Build/review handlers, tools and model adapters |

The live operator workflow and the fixture validator/router demo use different
paths; [architecture](docs/architecture.md) explains both. See also the
[source map](docs/sources-of-truth.md) and [upstream policy](docs/upstream.md).

To check source changes, follow the locked install and test commands in
[CONTRIBUTING.md](CONTRIBUTING.md). Ordinary contributor CI uses fixtures and never
calls a paid model. Legacy Azure entrypoints, planning and operations handlers
remain experimental; their presence is not evidence of a supported deployment.
