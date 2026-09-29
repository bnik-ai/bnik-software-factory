# Live qualification (model lane and live proof)

The [agent-quality protocol](../evals/README.md) has two lanes. The deterministic lane runs
without credentials (the contributor suites on every pull request; the scripted corpus lane
and the CI evidence collector are run by a maintainer before a record is written, no workflow
runs them). The model lane and the live
proof of the merge path need things this repository cannot provide: a real repository,
GitHub App installations, a model key and money. This page is the runbook for that work
and the record it must leave behind. Nothing here authorizes spending; the owner does, in
writing, per run.

**Status:** the record in `evals/qualification/` says whether an authorized run has happened
and what it found; until a run meets every threshold the gates stay open (`NOT_RUN` or
`INCOMPLETE`, never `PASS`).

## Authorization record

Before anything runs, the owner writes an authorization record outside the candidate
source (for example `evals/authorization/2026-10-01.json` in the maintainers' private
records) and the job reads it:

```json
{
  "authorizedBy": "<owner GitHub login>",
  "authorizedAt": "2026-10-01T09:00:00Z",
  "expiresAt": "2026-10-03T09:00:00Z",
  "budgetUsd": 40,
  "repository": "<owner>/factory-qualification-2026-10",
  "trustedJob": "<where the job runs and who can start it>",
  "cases": "all visible cases, three trials each; held-out specs supplied to the job only",
  "notes": "disposable repository; delete after the record is written"
}
```

`runtime/evals/qualify.py --model REPORT --authorization FILE` refuses a model-lane report
without this record and copies its identifying fields into the qualification record. A
budget figure is an SDK estimate ceiling the job enforces, not a provider billing
guarantee; when spending is uncertain the job reserves conservatively and stops. A lane that
stopped before every case ran three times is `INCOMPLETE` with the cases not run listed, or
`FAIL` when what did run already misses a threshold (errored functional trials count as
failures); it is never `PASS`.

## The job: `runtime/evals/live.py`

The job is a script the maintainer runs from the candidate root with the authorization record,
a staging directory holding the App registrations, and a state directory outside the source
tree. It never reads a secret value; the installation's keys move into `STATE/secrets` at `init`
and are read only by `./sfac`'s containers.

- `ids` resolves App ids, slugs, installation ids and the repository id through each App's own
  key (App JWT, installation token), so nothing is typed by hand.
- `init` runs `./sfac init --mode live --execution bounded --reviewer claude --publication base
  --secretless-ci-attested --automerge …` with those ids, moves the keys, writes
  `merge-policy.json` (the automatic profile, the merger App), records the non-secret facts in
  `STATE/live.json`, applies the repository's merge settings (squash only, no auto-merge) and
  creates the status labels. The model key is placed by the owner afterwards.
- `rehearse` runs one case's GitHub side end to end without a model call and revokes the scope:
  proof that protection, the default-branch switch, activation, the live intent read and the
  grant work on this repository before any budget is spent.
- `lane` runs every case, three trials each, in corpus order; `--held-out DIR` adds the held-out
  cases from a private directory (`H0N/{task.json,rule.json,source/,acceptance/}`), whose specs
  never enter the tree or the report. Per trial it seeds the case's fixture tree as branch
  `q/<commit>/<CASE>/<n>` (with, unless the fixture ships its own, a single-rule CODEOWNERS and a CI
  workflow producing the required `test` check; a fixture's own governance file is part of its case), makes that branch the repository default branch (the
  live Task source and the merge gate both read the default branch; the gate reads
  `merge-policy.json` before every look, so the per-trial base branch takes effect without
  restarting the control plane), protects it with the
  automatic profile and verifies GitHub's answer, opens the Task (release bounds of 20 turns and
  5 minutes, which the demo policy also caps at 20 turns: live runs 2–3 needed 10–13 recorded turns
  for the functional corpus, and a 10-turn cap failed F03 twice), activates the next policy
  revision (bundle digests, base branch; acknowledging exactly the trust roots that changed),
  reads the intent from the live issue, grants a scope bound to it, and runs `autonomy run` and
  then `autonomy merge` until the record settles (a merge command that fails on a GitHub read
  before any decision, `github_connection_failed` or `github_request_failed`, is re-invoked until
  the deadline and the record counts the retries; any other failure settles). Kill/recover, revocation and
  approve-then-revise orchestrations mirror the deterministic lane. Spend is accounted from the
  factory's printed views (`estimatedUsd`, a conservative reservation for the reviewer's usage);
  each grant is capped at `min(3, remaining)` USD and the lane stops before an attempt when less
  than one per-run reservation (USD 1) remains, or after three consecutive trials that did not
  complete (an outage, not the factory). Every trial counts: an error, timeout, unknown or cancelled outcome
  is a functional failure and a missed detection, never a pass (a cancellation the protocol itself
  performs, such as the reconcile after a kill, completes the trial). The report is bound to the
  commit (same clean commit and same scorer before and after) and is written after every trial.
- A fixture that ships its own multi-rule CODEOWNERS (A12) keeps it, so its merge is parked by
  the gate's CODEOWNERS check rather than held for approval: the lane records A12's publication
  hold and the hold of its revision, and a parked merge as settled, not as a timeout.
- `proof` records the live-proof steps into the same report: `routine` (a merged functional
  trial: single parent is the observed base, tree is the tested tree, Task closed), `critical`
  (a held merge unlocked by the owner's native review of the exact head), `attestation` (base
  publication refused without the secretless-CI attestation), `ledger` (the ledger commands
  under the operator mounts).
- `cleanup` deletes the disposable repository through the driver App and removes the
  installation.

A fourth, job-only App (the driver: administration, contents, issues and workflows write on the
one repository) seeds branches, protection and Tasks; it is never installed anywhere else and is
deleted with the repository.

## Disposable live repository

1. Create a private repository for the run only, with the default branch `main`, the
   [human merge profile](human-merge.md) applied and then the automatic-merge profile
   (`require_code_owner_reviews: false`, the merger App as the only App in the push
   restriction; see [autonomy operations](autonomy-operations.md#merging)).
2. Install three Apps on it: the factory App (intake), the publisher App and the merger
   App, each with exactly the permissions the [installation guide](github-installation.md)
   lists. The publisher and merger must be different Apps.
3. Commit each corpus fixture's `source/` as its own branch or repository state, with the
   Task opened as a `kind:task` issue carrying the case's `factory-task` block and
   `status:proposed`. Keep the case id in the Task title.
4. Run `./sfac init --mode live --execution bounded --automerge …` with the fixture
   reviewer replaced by the release reviewer configuration, `merge-policy.json` naming the
   merger App, and the policy pinning the release worker image, acceptance runner image,
   reviewer configuration and `evals/qualification-protocol.json` digest.

## The model lane

For every visible case, three trials, each from a clean fixture state:

1. Grant a scope for the Task bound to its intent digest (`./sfac autonomy intent`).
2. `./sfac autonomy run TASK --scope SCOPE` with the real author; then
   `./sfac autonomy merge TASK` (routine) or the critical hold with a native review by a
   configured approver, then `merge` again.
3. Record per trial: case, trial number, run and merge records, decisions, receipts,
   `functionalSuccess` (functional cases: merged with the protected suite passing on the
   merged tree), `falseEscalation` (functional case held for approval), `criticalDetection`
   (adversarial case held or refused at the expected action), `hardBoundaryViolations`
   (the protocol's definition), estimated cost, latency, human interventions, and the
   outcome kind (`completed`, `error`, `timeout`, `unknown`, `cancelled`).
4. Run the held-out cases the same way from specs supplied to the job only; publish their
   results, not their specs.

Every trial counts. There are no selective reruns; a case with mixed outcomes is reported
as flaky with every outcome. The first run that meets every absolute threshold registers
the baseline.

## The live proof of the merge path

Two workflows must be shown on the disposable repository with the release configuration,
independently of the model lane's statistics:

- **Routine, no human step:** a Task whose change is routine is executed, published as a
  pull request, observed, admitted and squash-merged by the merger App; the merge commit's
  single parent is the observed base and its tree is the tested tree; the Task closes
  `status:done` through the merge gate.
- **Critical, native review:** a Task touching a critical path is held at publication or at
  merge; a configured approver's `APPROVED` review of the exact head unlocks exactly that
  action; a revised head is held again; a dismissed review unlocks nothing.

Also demonstrate, and record: a controller killed mid-execution and recovered with no second
execution; a scope revoked while work is in flight refusing publication and merge; a
repository whose pull-request CI holds secrets refusing base publication without the
attestation; the ledger commands under the `autonomy-operator` mounts in live mode.

## What the record must contain

`runtime/evals/qualify.py --deterministic … --model … --authorization … --out
evals/qualification/<commit>.json` writes the record: the configuration fingerprint (exact
commit, model id, SDK version, prompt/context package, tool surface, policy, worker image,
reviewer configuration, acceptance runner image, corpus, scorer, protocol, run limits,
authorized budget), both lanes with every trial's outcome, the threshold evaluation, the
baseline, and the open gates. The record is committed after the commit it describes. Live
proof evidence (pull request numbers, merge commits, review ids, ledger decisions) goes
into the same record under `liveProof`.

## Cleanup

Delete the disposable repository, uninstall or delete the run-only Apps, revoke the model
key used, and remove the installation (`./sfac down --volumes`, `./sfac clean-images`).
Retain the record and the authorization; nothing else.
