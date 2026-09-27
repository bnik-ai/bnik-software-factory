# Release notes

## 0.1.0-alpha — unreleased

This candidate has not been tagged or published yet. Project-owned source uses Apache-2.0.
Record the exact candidate SHA when reproducing behavior. The initial distribution
proposal is project source/build instructions, with dependencies obtained separately.

### Included local workflow

- PostgreSQL-backed intake, queues, fenced leases, transactional handoffs and audit.
- Selected-repository GitHub App verification and explicit human Task activation.
- Disposable coding worker and separate credential-holding provider proxy; patches
  and actual command receipts; bounded turns, time, requests and resource use.
- Explicit operator publication and pairing; native human review/current-head CI,
  human squash merge verification and Task completion.
- Inspectable run evidence, estimated or unavailable usage, cancellation, content
  pruning, quarantines, bounded recovery and database backup/restore guidance.
- Contributor checks without paid models and deterministic source artifact builds.

### Limits and release prerequisites

The runtime does not publish PRs or automatically execute AI reviews. Revisions
run from a pinned default-branch snapshot. Single repository only; no autonomous
merge/deploy or hosted service. Planning/Azure/operations paths are experimental.
Model access depends on the operator's account and exact SDK/model compatibility;
there is no model substitution. Cost estimates are not bills or hard spending caps.

Before release, confirm licensing/maintainer details, resolve dependency findings,
complete independent onboarding, review the exact artifact and obtain publication
approval. Runtime integration and prior human workflow exercises do not replace
independent onboarding. See [support](SUPPORT.md), [third-party components](THIRD_PARTY.md)
and [roadmap](docs/roadmap.md). No binary or vendor-containing image is cleared here.
