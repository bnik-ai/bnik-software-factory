# Support and compatibility

## Status

`0.1.0-alpha` was released as-is on November 4, 2026 by [@bnikanjam](https://github.com/bnikanjam).
Nothing is maintained: no fixes, security updates, backports, responses or service levels are
promised. The repository stays open until December 31, 2026, then is archived unless a new
maintainer takes over; if you want to maintain it, say so in an issue before then. Otherwise fork it to change
or maintain it; a fork's maintainer sets that fork's support terms. Provider
account, billing, Docker hosting and GitHub plan support remain with their respective providers.
There is no managed hosting or on-call service. The facts below describe the release as tested;
they say nothing about later dependency versions.

## Version and platform matrix

| Component or environment | Alpha boundary |
| --- | --- |
| Release | `0.1.0-alpha`, tag `v0.1.0-alpha`, the only release; identify the full commit SHA. |
| Node | 24.21.0 is pinned in contributor CI and runtime image; macOS Node 26 is a development check, not the selected runtime. |
| PostgreSQL | 17.11, Bookworm base pinned by manifest digest; other major versions unqualified. |
| Claude Agent SDK | 0.3.283 with bundled Claude Code 2.1.283; model ID explicit, never substituted. |
| Linux x64 | Ubuntu 24.04 hosted contributor CI, database/worker integration and source artifact builds exercised; not rechecked after this release. |
| Linux arm64 | Local runtime and worker containers exercised on macOS arm64 Docker Desktop, Engine 28.0.4 / Compose 2.34.0. |
| Operator | `sfac` uses a POSIX shell and local Docker/Compose; Python 3 and Node 24.21.0 run inside the operator image. The optional native profile needs host Python 3, curl and Node 24.21.0 with installed service dependencies ([prerequisites](docs/local-runtime.md#native-profile-prerequisites)). |
| GitHub | GitHub.com, one selected repository; full merge profile needs an organization repository with the documented enforceable protection. |
| Other environments | Windows native, other Node/database versions, non-Docker workers and GitHub Enterprise Server are unqualified. |

Past checks do not certify every subsequent commit or dependency update. Runtime
images are built locally; there is no approved prebuilt image distribution.

## Behavior supported by the local alpha profile

- Durable intake, explicit human Task activation and authorization revalidation.
- One bounded coding run at a time per repository, in a disposable worker, with
  patches, command receipts, run metadata, estimated/unknown accounting and cancellation.
- Operator-reviewed publication, explicit Task/PR pairing, required current-head CI,
  native human review and human squash merge followed by Task reconciliation.
- Explicit recovery, database backup/restore and content retention controls.

The supported workflow is operator-driven. In the default human-gated configuration
the local runtime does not publish worker output or automatically invoke the
experimental AI ReviewAgent, and AI output never satisfies a required human approval.
The opt-in bounded-autonomy controller (`FACTORY_EXECUTION=bounded`, see
[operating bounded autonomy](docs/autonomy-operations.md)) publishes pull requests for
routine changes under an activated policy; it passes synthetic contracts, it passed live
qualification on commit `b42a3c2` (`evals/qualification/b42a3c2.json`; later commits are not
themselves qualified), and it stays outside the supported workflow. Source snapshots come from the
pinned default branch; revision prompts must describe the complete intended result.

## Experimental and unsupported

Azure/Service Bus/Terraform deployment paths, Goal/Spec/Design planning, Ops/SRE,
legacy multi-agent orchestration and autonomous deployment are experimental source
references. The fixture validator/router demo does not establish their live support.
Multi-tenant hosting, arbitrary outbound worker networking, submodules, LFS
hydration, symlink-dependent sources and automatic dependency installation inside the
worker are unsupported. Automatic merge exists only as a further, live-only opt-in of
bounded autonomy (`FACTORY_AUTOMERGE=enabled`). The agent-quality protocol's deterministic
and model lanes and the live proof of a routine merge and a critical hold passed on commit
`b42a3c2` (`evals/qualification/b42a3c2.json`; see [live qualification](docs/live-qualification.md)
and the [roadmap](docs/roadmap.md)); later commits are not themselves qualified.

The November 4, 2026 audit of the five lockfiles reported one advisory, evaluated in
[security](SECURITY.md); audits are point-in-time, and none follows this release. Passing tests is not a clean security audit. Containers share a host kernel;
provider requests can include repository content, and local estimates are not bills.
See [security](SECURITY.md), [worker boundaries](docs/isolated-worker.md) and
[third-party terms](THIRD_PARTY.md) before using non-synthetic data.
