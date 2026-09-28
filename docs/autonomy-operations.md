# Operating bounded autonomy

**Status: implemented, not the default, and not yet live-verified.** The controller,
trusted runners and publisher exist and pass synthetic contracts (fixture executor,
real sandboxes, PostgreSQL, a Git-hashing fixture host). No pull request has been
published to a real repository under this mode yet; OSS-22 covers that proof. The
supported alpha workflow stays human-gated until then.

Bounded autonomy lets routine work go from an authorized Task to a published pull
request without a human step, while critical, out-of-scope or uninspectable changes
wait for a human approval bound to that exact revision. The
[policy contract](autonomy-policy.md) defines the decision; this page describes the
machinery that produces its evidence and how an operator runs it.

## What runs where

```mermaid
flowchart LR
  O[Operator: sfac autonomy ...] --> C[Controller container: factory_controller DB role]
  C -->|admit + consume| L[(Ledger: policy, scopes, decisions, reservations, runs)]
  C -->|job| W[Coding worker: existing supervisor, no credentials]
  C --> K[Collector sandbox: archive + patch to tree + manifest]
  C --> A[Acceptance sandbox: protected bundle at .factory/acceptance]
  C --> R[Reviewer sandbox + proxy: intent, diff, receipts]
  C --> D[Resolution sandbox: npm re-resolve; scanner container offline]
  C -->|allow| P[Publisher: Git Data API, one token per publication]
  P --> G[GitHub: branch on fork or base, PR with task-ref]
  C -->|hold| H[Human approval bound to the action digest]
```

| Component | Runs as | Credentials | Network |
| --- | --- | --- | --- |
| Controller (`src/autonomy/cli.ts`) | supervisor container, `factory_controller` role | controller DB password; in live mode the App key (source reads), model key (proxy only), publisher App key | GitHub, model provider |
| Coding worker | disposable container, uid 1000 | none (proxy holds the model key) | none |
| Collector, acceptance, reviewer sandboxes | disposable containers, uid 1000, read-only, no capabilities | none | none; the reviewer reaches its proxy through a socket volume |
| Resolution sandbox | disposable container | none | outbound network (Docker bridge); the project's manifest, lockfile or `.npmrc` naming any non-registry source is refused before npm runs (transitive limit below) |
| Scanner (Trivy adapter) | disposable container from the pinned image | none | none; reads an operator-maintained database cache volume |
| Publisher | inside the controller process | publisher App installation token, minted with `contents: write, pull_requests: write, metadata: read`, restricted to the write and base repositories, revoked after use. One token covers both repositories with the same permission set (a GitHub token limitation), so in fork mode the installation on the base repository also holds `contents: write` even though only pull requests are written there | GitHub |
| Internet-facing runtime | `factory_runtime` role | unchanged | unchanged; `SELECT` only on autonomy tables |

The controller holds Docker daemon authority, as the existing supervisor does. The
worker, the sandboxes and the scanner never hold a credential.

## Configuration

Run `./sfac init` with autonomy selected:

- Demo (credential-free): `./sfac init --mode demo --autonomy`. Fixture reviewer and
  scanner, no publisher; the pipeline runs end to end and stops in `held` with reason
  `publication_disabled` and both decisions recorded, because nothing can be published
  without GitHub.
- Live: `./sfac init --mode live --execution bounded --reviewer claude --reviewer-model claude-… --publication fork --fork-repository OWNER/REPO --fork-repository-id ID --publisher-app-id ID --publisher-installation-id ID …`
  plus the usual live arguments. `--scanner trivy --scanner-image REF --scanner-cache-volume NAME`
  enables dependency verification. Fork mode needs the fork to contain the Task's base
  commit (keep it synced with the base) and the publisher App installed on both. Fork pull
  requests run the base repository's `pull_request` workflows without secrets, but
  `pull_request_target` and `workflow_run` workflows run with the base's secrets: a base
  repository with such workflows acting on pull-request content must not enable bounded
  publication in either mode.

`init` creates `secrets/controller_database_password` for the controller role, which
`./sfac build && ./sfac up` provisions through the migration. Then provide, in the state
directory (`.factory/` by default):

| File | Purpose |
| --- | --- |
| `autonomy-policy.json` | The [policy](autonomy-policy.md); start from [`runtime/autonomy-policy.example.json`](../runtime/autonomy-policy.example.json). Pin `acceptanceSuiteSha256`, `acceptanceHarnessSha256`, `acceptanceRunnerImage`, `reviewerConfigSha256` and, when enabled, the scanner adapter and image. |
| `acceptance/` | The protected acceptance bundle: `harness.json` plus test files. See below. |
| `secrets/publisher_private_key` | Live only: the publisher App's private key. |
| `secrets/model_key` | Live only: the model key, held by the proxy for the worker and the reviewer. |

Activate the policy, then grant a scope:

```sh
./sfac autonomy activate --acknowledge initial_activation,mode_changed:human_gated->bounded,...
./sfac autonomy intent 42                    # prints the Task's node id and intent digest
./sfac autonomy grant --scope goal-1 --tasks I_TASK_NODE_ID=INTENT_SHA256 --budget-usd 5 --max-runs 2 --expires-hours 48
./sfac autonomy status
```

A live grant names each Task together with the intent digest `intent` printed, so the
grant covers the issue as the owner read it: an issue edited afterwards has another
digest and is refused with `scope_intent_mismatch` until the owner grants it again.
Demo grants may name Tasks alone.

`activate` refuses until every weakening it computes is acknowledged by exact code;
it prints the list it expected. A demo installation acknowledges
`initial_activation` and, for a bounded policy, `mode_changed:human_gated->bounded`.

## Running a Task

```sh
./sfac autonomy run TASK_NUMBER --scope goal-1          # live
./sfac autonomy run 1 --scope goal-1 --task-file /artifacts/task.json --archive /artifacts/source.tar.gz   # demo
```

The controller admits an `execute` request, runs the worker once, collects the frozen
change, runs the protected acceptance suite (and the reproducer for `bugfix` Tasks),
the fresh-context reviewer and, when the change touches npm manifests and a scanner is
configured, dependency verification. It then admits `publish`. Outcomes:

| Run state | Meaning | Next |
| --- | --- | --- |
| `published` | PR opened or updated on the exact tested tree; paired and tracked when the merge policy is configured | OSS-21 merges routine work; humans review critical work |
| `held` | `execute_approval_required` or `publish_approval_required`: a human must approve the recorded `actionSha256` | `./sfac autonomy approve --action SHA --kind publish --approver GITHUB_USER_ID`, then `run` again; receipts older than `receiptTtlMs` are verified again before the decision |
| `repair` | Acceptance failed or the reviewer found important defects; a new attempt was started with the findings appended to the prompt, within the scope's run limit | nothing; the next attempt continues automatically |
| `blocked` | Policy or ledger refused (paused, revoked, budget, malformed evidence) | fix the cause; `run --new-attempt` starts another attempt |
| `failed` | The worker or collector failed; no external effect. A worker that had already started keeps an `unknown` reservation (spend uncertain) until reconciled | `reconcile` if a reservation is open, then `run --new-attempt` if appropriate |
| `unknown` | Execution or publication outcome is uncertain (lost worker lease, dead work item, Task or source changed mid-execution, a failure after the branch was written) | inspect the worker and GitHub, then `./sfac autonomy reconcile --run RUN_ID --spent-usd X` or `--released` settles an open or uncertain reservation (also one left `unknown` under a published run) and frees the Task |
| `cancelled` | `./sfac autonomy cancel TASK_NUMBER`; an executing attempt keeps an `unknown` reservation until reconciled. While a controller is driving the attempt, `cancel` only asks a running worker to stop (`requested`) and that controller records the outcome | `reconcile` when a reservation is open |

A publication that fails before anything is written (GitHub unavailable, token refused)
leaves the run in `publish_admitted` with the reason printed; `run` again retries only
the publication. `run` exits with `task_run_in_progress` while another controller holds
the Task and with `worker_busy` while another worker run holds the repository; nothing
changes in either case. A publication that was written before a crash is found on the
branch and adopted, not recreated.

Re-running `run` on a finished attempt changes nothing; the controller resumes only an
open attempt. A crashed controller resumes from the recorded step: an execution already
admitted is not paid for twice, and a publication already made is found again, not
duplicated. The ledger settles the budget reservation from the worker's estimated cost;
an uncertain outcome keeps the full reservation until an operator reconciles it.

## Protected acceptance bundle

The bundle is a directory the operator controls. `harness.json`:

```json
{
  "version": 1,
  "runner": { "kind": "node-test" },
  "tests": ["tests/sum.test.mjs"],
  "reproducer": "tests/reproducer.test.mjs",
  "timeoutMs": 60000
}
```

Every other file is the suite. The runner copies the bundle into the candidate tree
at `.factory/acceptance/` after the patch is applied (a candidate that already has that
path cannot be tested), so tests import candidate code with relative paths such as
`../../../sum.js`. `node-test` runs each file in its own process and counts results
from the runner's structured events in the parent process, never from output text or
from a file the candidate's processes could reach (the summary travels through the
runner parent's stdout). A file passes only when its child reports completion of the
whole file: a child that exits early (candidate code called `process.exit(0)`) flushes no
events on the pinned runner, so the file fails. `{"kind":"command","program":"…","args":[…]}`
runs any program per file and trusts only its exit status. The bundle digest is checked
before and after each run, the candidate source is snapshotted around it, and the results
go into the acceptance receipt the policy consumes. See [`examples/autonomy-demo/acceptance`](../examples/autonomy-demo/acceptance).

Limit: candidate code runs inside the same process as the tests that import it, so code
written to defeat the suite (patching `assert`, forging the runner's event stream) can
manufacture a pass. Acceptance is therefore a regression signal against ordinary
mistakes and bundle tampering, not an integrity boundary against a hostile candidate;
the fresh-context reviewer and the approval rules for critical changes are that boundary.

Tests run without network. Projects whose tests need installed dependencies must
vendor them or provide a lockfile-free path; this is the same limit the worker has.

## Dependency verification

When a change touches `package.json` or `package-lock.json`, the resolution sandbox
(the only sandbox with network) first refuses any manifest specifier, lockfile
`resolved` URL or `.npmrc` in the project that could point npm anywhere but the public
registry, then re-resolves the lockfile from the manifest with install scripts disabled
and compares it byte for byte, computes the
package deltas and the changed manifest fields, and the scanner adapter reports
vulnerabilities over the committed lockfiles from an offline database cache. The Trivy
adapter runs the pinned image with `fs --scanners vuln --format json --skip-db-update
--skip-java-db-update --offline-scan` against a read-only cache volume; refresh that
volume with `docker run --rm --mount type=volume,src=NAME,dst=/cache IMAGE image
--cache-dir /cache --download-db-only` on a schedule you choose. Other ecosystems are
reported `unsupported` and stay critical. Limit: the refusal covers the project's own
files; a registry package whose metadata names a git or URL dependency would still make
npm fetch it from that host over the bridge, after which the lockfile fails to reproduce
and the change holds. A registry-pinned egress proxy for this sandbox is future work.
The adapter was verified once by hand against
`aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969`
(September 27, 2026: offline scan of a lockfile with known advisories, findings read from
`Results[].Vulnerabilities[]`, database age from `metadata.json` `UpdatedAt`); pin the
digest you verify yourself, since the policy refuses a tag.

## Recovery and boundaries

`./sfac autonomy recover` removes orphaned worker and sandbox containers, then
reports. It refuses with `controller_busy` while any controller command is active, so a
live run's sandboxes are never swept. It never repeats paid work; `unknown` runs need an
operator decision, recorded with `./sfac autonomy reconcile` (a PR found on GitHub is
paired through the existing `worker record-pr` path). Controller commands serialize on
rows of `factory_autonomy_locks`, which the internet-facing runtime role cannot touch. Pause (`./sfac autonomy pause --reason …`) stops all admission and all resumption of open attempts (`run` reports `autonomy_paused` and changes nothing); revocation and expiry stop a scope's attempts the same way. Pause stops admission
immediately; revocation stops a scope. The controller CLI is not reachable from a
webhook or the runtime process; it runs when an operator (or an operator-scheduled
job) invokes it.

Not supported: repositories whose archive differs from their tree (`export-ignore`
attributes); the publisher reports `publish_base_tree_mismatch` and nothing is written.
Ignore rules and attribute filters in the repository do not matter: snapshots track every
archived file byte for byte.

Not yet provided: automatic merging (OSS-21), a live proof of the whole path (OSS-22),
GitHub-review–sourced approvals (the console approval exists), and scheduling.
