# Release notes

## 0.1.0-alpha — unreleased

This candidate has not been tagged or published yet. Project-owned source uses Apache-2.0.
Record the exact candidate SHA when reproducing behavior. The initial distribution
proposal is project source/build instructions, with dependencies obtained separately.

### Changes

- Remediate the dependency advisories `npm audit` reported for the five lockfiles on
  September 30 and October 29, 2026: Hono 4.13.11 and `@hono/node-server` 2.1.5 in the
  control plane, the MCP TypeScript SDK 1.32.2 under the agent SDK in the worker image,
  Vitest 4.1.12 in the four test-running services, and patched transitive packages within
  their ranges. The webhook's 1 MiB body limit is covered by tests, in process and through
  the Node HTTP adapter. One advisory has no fix inside the Azure SDK's supported range; see
  [Security](SECURITY.md).
- Move the trusted merge policy to `merge-policy/merge-policy.json` in the state
  directory (native `runtime/merge-policy/merge-policy.json`), mounted as a directory so
  an edited file reaches the running control plane; a `merge-policy.json` in the state
  root is refused.

- Add opt-in automatic merge for bounded autonomy (`FACTORY_AUTOMERGE=enabled`, live
  only): a trusted merge-gate observation (head tree, protection, required checks,
  reviews), approvals sourced from native GitHub reviews of the exact head by configured
  approvers, a merge record admitted once through the ledger, a separate merger App that
  squash-merges the exact head after an immediate re-check, verification of the merge
  commit's parent and tree, reconciliation through the merge gate, re-verification of
  expired receipts, and `./sfac autonomy merge` / `merge-scan`. Routine work merges with
  no human step; critical work waits for a human review of the exact head. A merge record
  ends only when the pull request is no longer what was tested; pending checks, change
  requests and GitHub refusals keep it open for the next scan, and an admission is honoured
  only under the policy it was decided with, within its TTL, with its approval standing.
  Publication now pairs the Task itself (backlink and `status:in_review`), and the intent
  digest ignores that backlink.

- Add the opt-in bounded-autonomy controller (`FACTORY_EXECUTION=bounded`, demo
  `FACTORY_AUTONOMY=bounded`): trusted collector, protected acceptance runner with a
  tamper-checked bundle and structured result counting, fresh-context reviewer (fixture
  or Claude through the fixed-origin proxy), npm dependency verification with a
  pluggable scanner adapter (fixture, Trivy), a Git Data API publisher that proves the
  published tree equals the tested tree and adopts a branch written before a crash,
  compare-and-set run state with crash resume and one controller per Task, bounded
  revision, approval holds with re-verification of expired receipts, scopes that bind
  each Task to the intent digest the owner reviewed, a `factory_controller` database
  role and `./sfac autonomy …` commands (`intent`, `pin`, `activate`, `grant`, `run`,
  `approve`, `reconcile`, …). Not the default; live-qualified on commit `2d4d48a` as
  recorded in `evals/qualification/`; later commits are not themselves qualified.

- Add the trusted autonomy policy foundation (wired into the opt-in bounded-autonomy
  controller above):
  a strict host policy file, deterministic risk rules over the complete change,
  acceptance/review/merge-gate/approval receipts, a pure decision engine and a
  PostgreSQL ledger for policy activation, pause, scopes, single-use admissions
  and budget reservations. The runtime database role gets read-only access.
- Freeze the agent-quality qualification protocol and a 24-case corpus with five
  held-out cases published as digests. Both lanes passed on commit `2d4d48a`
  ([record](evals/qualification/2d4d48a.json)), with a routine merge, a critical merge
  unlocked by the owner's native review (and still held once that approval was dismissed) and a
  merge refused after the approved head moved, all shown live; later commits are not themselves
  qualified.
- Add optional trusted dependency verification to the policy contract: a
  pluggable, digest-pinned scanner adapter plus deterministic lockfile, script,
  shape and license checks can make manifest changes routine; findings at or above
  a configured severity, and registry or hook configuration, still hold.

- Support restrictive source permissions in all three images; mount credentials by
  command, keep result preparation offline, and bound operator memory/processes.
- Print migration digests and audit heads, reject tampered verification fixtures,
  and provide installation-scoped image cleanup.

- Add the local `sfac` container operator for configuration, supervision, recovery,
  backup verification and result preparation; isolate installation image tags.
- Freeze worker patches before tests; exclude generated outputs and fail validation
  when tests modify proposed source. Expose demo completion receipts directly.
- Document the trusted supervisor's Docker authority and current platform limits.

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

In the default profile the runtime does not publish PRs, run AI reviews or merge;
opt-in bounded autonomy adds publication and AI review, and a further opt-in
(`FACTORY_AUTOMERGE=enabled`) adds merge, all within its policy. Revisions run from a pinned
default-branch snapshot. Single repository only; no autonomous deploy or hosted service. Planning/Azure/operations paths are experimental.
Model access depends on the operator's account and exact SDK/model compatibility;
there is no model substitution. Cost estimates are not bills or hard spending caps.

Licensing and maintainer are confirmed: Apache-2.0, copyright 2026 Babak Nikanjam,
maintained by @bnikanjam. Before release, repeat the dependency audit on the release commit,
complete independent onboarding, review the exact artifact and obtain publication
approval. Runtime integration and prior human workflow exercises do not replace
independent onboarding. See [support](SUPPORT.md), [third-party components](THIRD_PARTY.md)
and [roadmap](docs/roadmap.md). No binary or vendor-containing image is cleared here.
