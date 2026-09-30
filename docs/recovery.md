# Inspect and recover durable work

For Docker-only host operation, use [the container launcher](container-runtime.md).
The low-level commands below describe the optional native profile; the mapping
covers configuration, secret paths, worker/recovery commands and sample artifacts.
Do not mix its `runtime/` state with the launcher's `.factory/` state.

Recovery is an explicit maintainer operation. It preserves the work ID, delivery
key, payload hash and accumulated attempts. It does not create a branch or PR,
change a Task's labels, supply approval, or rerun a coding model.

```text
Failed work
    |
    v
Inspect ID + reason + attempts + recovery version
    |
    +---- cause unresolved ----> Quarantine that item
    |
    +---- cause resolved ------> Authenticated replay request
                                     |
                         +-----------+------------+
                         |                        |
                  Intake / merge gate         Coding job
                         |                        |
                  One extra attempt         Replay refused
                         |                        |
                  Recheck current           Inspect outcome,
                  GitHub evidence           clean up worker,
                         |                  fresh human activation
                  Human gates remain
```

## Prepare the operator command

Use the configured [local runtime](local-runtime.md). With an existing database,
take and verify a backup first. Stop its consumers and native supervisors, build
the updated image, run the one-shot migrator, then restart the runtime. Use the
same Compose project name and profile files that created the database; never
switch to a new volume to avoid a migration error. For the base demo profile:

```sh
docker compose -f runtime/compose.yaml stop runtime
docker compose -f runtime/compose.yaml build migrate
docker compose -f runtime/compose.yaml run --rm migrate
docker compose -f runtime/compose.yaml up -d --wait runtime
```

For live installations include their existing live, worker and human-merge
overrides in these commands. Migration `0006_recovery` adds quarantine and an
append-only action table without rewriting existing delivery identities or
attempts. Checksums reject an incompatible schema. Keep consumers stopped if the
migration fails; inspect its configuration and restore procedure.

The base profile needs no host database port. Inspect from its runtime container:

```sh
docker compose -f runtime/compose.yaml exec runtime node --import tsx src/recovery-cli.ts inspect
```

The live/native profile with `runtime/compose.worker.yaml` also supports:

```sh
npm ci --prefix services/local-runtime --ignore-scripts --no-audit --no-fund
python3 runtime/recovery.py inspect
python3 runtime/recovery.py inspect WORK_ID
```

Replace `WORK_ID` with an ID returned by inspection. The wrapper uses the existing
runtime database password file and loopback port; it passes no GitHub App, model
or Docker credentials to the command. The container CLI supports the same arguments.

PostgreSQL authenticates the `factory_runtime` role using the configured password
(SCRAM in the packaged database). Native remote connections require verified TLS
through the underlying CLI's database configuration. Possession of this local
database credential is the maintainer authority. Receipts identify the database
role, not an independently verified individual GitHub user. Restrict access to
the credential and backups; there is no anonymous HTTP recovery endpoint.

## Interpret status

Inspection returns at most the latest 100 queue items and PR states. Inspect a
specific work ID to see its last 100 recovery actions. It omits webhook bodies,
model output and raw error text; unknown error text becomes `unclassified_failure`.

| State | Meaning and next step |
| --- | --- |
| `queued` | Pending claim or retry delay; inspect attempts and availability time. |
| `running` | Lease owned or awaiting expiry; never replay an active item. |
| `awaiting-human` | PR policy is satisfied; a human merges it, or with opt-in automatic merge, `autonomy merge` can merge it through the merger App. |
| `failed` | Queue item exhausted/rejected, or a separate PR policy check is parked; read the reason. |
| `completed` | Queue item settled, or PR reconciliation completed. |
| `quarantined` | This queue item cannot be claimed until an allowed explicit replay. |

A completed queue scan does not mean its PR is approved or merged. The separate
`reviews` array reports that policy state and observed head. Approval/CI missing
or stale parks the PR; current evidence must pass before reconciliation. Use
`python3 runtime/worker.py review-status` and `review-scan` with the configured
human-merge profile. Do not replay a completed scan to manufacture approval.

## Recover one failed item

1. Inspect the item and fix the underlying outage or configuration. Verify the
   Task, repository, installation and PR identity using the existing operator
   tools. Treat a changed permission, activation comment or PR head as new
   evidence to resolve, not as an error to bypass.
2. Record the returned `recoveryVersion`. Generate a request UUID and save it
   before issuing a mutation:

   ```sh
   python3 -c 'import uuid; print(uuid.uuid4())'
   ```

3. Choose one action, substituting the inspected values and generated UUID:

   ```sh
   python3 runtime/recovery.py quarantine WORK_ID RECOVERY_VERSION REQUEST_UUID investigation_required
   python3 runtime/recovery.py replay WORK_ID RECOVERY_VERSION REQUEST_UUID cause_resolved
   ```

   These are alternatives, not a sequence to paste. Each new action requires a
   new UUID and the current version. Reasons are short lowercase codes, not
   secrets or free-form incident reports.
4. If the response is lost, repeat the **identical** command and UUID. The stored
   receipt returns `cached: true`; a conflicting reuse is rejected. A version
   conflict requires inspection. Never generate a new UUID merely because a
   response timed out.
5. Inspect again, let the configured consumer process the item, and verify the
   resulting activation receipt or PR state. The action receipt and queue change
   commit together. The runtime role cannot update or delete those receipts.

Replay is limited to failed/quarantined `GitHubIntake` and `HumanMergeGate` items
with retained payloads. Each accepted replay grants **one** additional claim,
preserving the lifetime counter and a hard limit of 100 attempts. Current
authorization, CI, approval and merge evidence are checked by the consumer.
Another pending/running item for the same record blocks replay until inspected
and settled. Completed and running work cannot be replayed or quarantined.

Quarantine accepts queued or failed work, but refuses unfinished worker cleanup.
It freezes that item only: other deliveries and scheduled PR scans can still run.
Stop the relevant consumer when an incident requires a wider pause. Replaying a
quarantined intake/reconciliation item requires its new version. Coding and
legacy/demo queue items cannot be released through this replay command.

## Reconcile uncertain effects

Duplicate webhook delivery retains its original identity; a conflicting body is
rejected. A crash before a database transaction commits rolls it back. After a
commit with a lost response, stored receipts and outgoing work remain authoritative.
Leases fence database writes; they do not undo an external API call.

If a Task update succeeded before acknowledgment, the merge gate re-reads the
same registered PR/Task and uses immutable merge proof to finish idempotently.
It may repeat harmless label/close requests, but creates no replacement PR or
Task. A changed PR head requires matching CI and a current approval of that head:
a configured human's, or, for a merge the merger App made under opt-in automatic
merge, that App's own.

For a coding/provider failure, inspect `python3 runtime/worker.py status` and use
`python3 runtime/worker.py recover` to clean up uncertain resources as described
in the [worker guide](isolated-worker.md). Recovery does not run a paid job again.
After resolving the cause, a fresh human activation and explicit new coding
request are required; under opt-in bounded autonomy, settle an open reservation
with `autonomy reconcile` and start another attempt with `autonomy run --new-attempt`.
Never reset attempt counters or reuse a failed paid job.

In the default mode, publication is an explicit operator step in the
[pilot walkthrough](end-to-end-pilot.md); under opt-in bounded autonomy the publisher
adopts a branch written before a crash (see [autonomy operations](autonomy-operations.md)).
Before retrying an uncertain push or PR creation, compare the recorded branch,
remote head, patch hash and existing PR. Reuse the existing matching PR; stop on
conflicting identities. The recovery CLI has no publishing or merging authority.

## Reproduce the checks

```sh
python3 runtime/test.py
```

This exercises real PostgreSQL authentication, migration upgrade, duplicate
requests, atomic recovery receipts, quarantine, bounded replay, revoked human
permission, stale PR heads, synthetic provider failure and interrupted Task
acknowledgment. It also runs actual consumer SIGKILL, database restart and backup
restore checks. GitHub/model failure cases use fixtures; these tests incur no
model spend and do not claim live provider outage coverage.
