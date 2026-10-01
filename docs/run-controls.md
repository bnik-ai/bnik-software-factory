# Run evidence and resource controls

For Docker-only host operation, use [the container launcher](container-runtime.md).
The low-level commands below describe the optional native profile; the mapping
covers configuration, secret paths, worker/recovery commands and sample artifacts.
Do not mix its `runtime/` state with the launcher's `.factory/` state.
Native commands need the host tools and the `runtime/compose.worker.yaml` database port in [native profile prerequisites](local-runtime.md#native-profile-prerequisites).

The supported local profile records each explicit coding attempt in PostgreSQL.
Inspection and cancellation do not start a model call. Run the schema migrator
after backing up an existing installation, using the same Compose project and
profiles as described in the [recovery guide](recovery.md).

```text
Human activation -> Submit job -> Admit within Task and repository limits
                                       |
                                       v
                           Persist identity and effective limits
                                       |
                                       v
                           Execute within time/turn/request bounds
                                       |
                       +---------------+----------------+
                       |                                |
                    Result                         Stop / failure
                       |                                |
               Record tests and usage           Keep uncertain outcome
                       +---------------+----------------+
                                       |
                             Clean up and settle
```

## Status and run linkage

```sh
python3 runtime/worker.py status
python3 runtime/worker.py status JOB_ID
```

Output includes up to 100 jobs/runs, with the original job and work IDs, run ID,
Task activation and issue identity, source head, archive/patch hashes, start/end
times, state, reason, attempts, retry count, test results, usage and effective
limits. A queued cancellation has no run ID because no executor started.
`revision: 0` is the first attempt; subsequent `run-activation` attempts for that
Task increment the index. Failed attempts also count. Bounded-autonomy jobs do not
advance it; `autonomy status` numbers their attempts. A cancelled queued item has
zero attempts.

Status contains test command/output hashes and exit results, not commands,
transcripts, Task prompts, patches or raw error messages. Local artifact files
and retained queue payloads have different content boundaries described below.
Historical rows are backfilled with available metadata during migration; unknown
limits or accounting stay null. The migration does not claim that new controls
were enforced on old runs. Records survive restarts and content pruning.

The isolated worker produces a patch, not a published Git commit. After the
operator verifies and publishes that patch, freezes the Task/PR backlinks and
registers the pair, bind the successful run to the published head:

```sh
python3 runtime/worker.py record-pr JOB_ID PR_NUMBER FULL_PUBLISHED_HEAD
```

This command verifies the current open PR head and reciprocal Task identity
through GitHub, then records the association. It does not prove patch equivalence:
the operator must verify the published changes. A run's association cannot be
replaced; a revision is a new authorized run and may bind to a new head of the
same PR. Use `track-pr` once for the frozen pair and `review-scan` as explained in
the [human merge guide](human-merge.md).

`evidence.publication.builtHead` is the recorded published head.
`evidence.review.reviewedHead` retains the last verified review/CI observation for
that run's head. The separate `review` field reports the matching current stored
gate state; it is null if the latest scan observed a different head. Historical
approval never authorizes a changed head. No publication/review head is invented
when no association or verified observation exists.

## Accounting

```text
SDK result received?
       |
       +-- No accounting available -> unavailable; estimatedUsd: null
       |
       +-- Numeric SDK cost -------> estimated; estimatedUsd: reported value

Provider billing statement -------> separate reconciliation; billedUsd: null here
```

The installed SDK describes `total_cost_usd` as a cumulative estimate. We retain
the latest terminal total, not a sum of intermediate totals. Numeric model-usage
counters are aggregated across SDK model entries; unavailable counters remain
null. Crash/startup errors may contain zeroed SDK values: an error with zero cost
and no usage is reported as unavailable. A reported successful zero is distinct
from missing accounting. This command does not retrieve provider invoices and
never labels estimates as billed charges. Interrupted in-flight requests may
have incurred charges even when all local accounting is unavailable.

## Limits

Set trusted operator limits in ignored `runtime/.env` before starting the native
supervisor. They are read at invocation and retained with each run. Changes apply
to subsequent invocations, not a running process. Task-level values can tighten
the effective limit; they cannot raise the operator cap.

| Setting | Default | Allowed range / behavior |
| --- | --- | --- |
| `FACTORY_MAX_TASK_RUNS` | 4 | 1–20 total `run-activation` attempts per Task identity, including its first run; default allows at most three further attempts. Bounded-autonomy attempts are not counted here, and the scope's `--max-runs` and the policy's `execution.maxTaskRuns` cap them; a Task whose manual attempts reached this cap is refused in bounded mode too (`task_run_limit_reached`). |
| `FACTORY_MAX_RUN_TURNS` | 60 | 1–60; also capped by the approved Task's `maxTurns`. |
| `FACTORY_MAX_RUN_MS` | 1800000 | 1000–1800000 ms execution deadline; also capped by approved `timeoutMs`. |
| `FACTORY_MAX_RUN_BUDGET_USD` | 5 | 0.001–100 USD SDK estimate threshold; optional approved `maxBudgetUsd` may lower it. |
| Repository concurrency | 1 | Database session mutex plus renewable lease; failed cleanup blocks another run. |
| Provider proxy | turns + 4 requests | At most 64 requests, 2 MiB each, maximum 16384 output tokens per message; fixed provider/model. |

Worker CPU, memory, process count and temporary storage bounds remain those in
the [isolated-worker guide](isolated-worker.md). Preparation/cleanup use separately
bounded calls outside the execution deadline. Every queued coding job has one
attempt. In the default mode, failed paid work requires fresh human activation, not
automatic retry. Under opt-in bounded autonomy, a `repair_required` decision starts
a new paid attempt automatically within the scope's run limit, and a failed attempt
needs `reconcile` if its reservation is open, then `run --new-attempt`.
The Task cap counts prior durable attempts across fresh activation IDs, restarts
and content pruning. Increasing it is an explicit trusted-operator policy change.

The SDK stops when its estimated budget is exceeded, so the last request can
overshoot it. In-flight requests, pricing differences and lost usage can produce
additional billed cost. SDK controls also cannot constrain an arbitrary program
that calls the worker's proxy directly; the proxy's independent request, token,
body and lifetime bounds still apply. **No hard monetary ceiling is guaranteed.**
Use provider/account spending controls separately where available. No provider
billing configuration is changed by these commands.

## Cancel or stop

```sh
python3 runtime/worker.py cancel JOB_ID
python3 runtime/worker.py status JOB_ID
python3 runtime/worker.py recover
```

Cancellation requires the authenticated runtime database credential and configured
repository, but no GitHub or model authentication. A queued item is settled as
cancelled work without launching the executor. For active work, cancellation is
persisted and polled every 200 ms, with another check immediately before worker
startup. SIGINT/SIGTERM to the supervisor aborts its active execution and prevents
it from beginning further work. Cancellation is not instantaneous: a provider
request already in flight can finish or be billed. The supervisor removes the
worker, proxy and descendants before settling where cleanup succeeds.

`executionMayHaveStarted: true` with no result means effects/accounting can be
uncertain. Inspect before any fresh authorization. A supervisor crash can leave
resources until the lease expires and explicit `recover` removes them; this
never automatically replays the paid attempt. `cleanup_failed` and `lease_lost`
remain visible and prevent unsafe cleanup assumptions. Stopping the webhook
container alone does not stop a separately running native supervisor.

## Local retention and deletion

No automatic content deletion is enabled. To explicitly prune completed/failed
coding payloads and raw results older than 30 days:

```sh
python3 runtime/worker.py prune 30
```

This affects only settled coding items without unresolved worker cleanup. It
retains work identity, delivery hashes, cancellation state, timestamps, minimal
run/test/cost evidence and Task attempt counts. A pruned successful job cannot
re-export its old patch; resubmission still deduplicates and cannot rerun it.
Days must be an integer from 1 to 3650. No shell deletion or manual SQL is needed.

Raw `result.json`, patches and test output in operator-chosen artifact directories
may contain repository content. They are created with private permissions and are
not removed by database pruning; delete them separately under your local policy.
Container logs are disabled. Temporary worker source and SDK session files are
discarded with their containers. No provider/API credential belongs in a report.

Activation proofs and audit receipts are retained for authorization/reconciliation;
they can contain Task content. Backups likewise retain data independently of
pruning. For complete local erasure, stop all consumers/supervisors, clean their
resources, and intentionally remove the dedicated database volume, local artifacts,
backups and ignored configuration/secrets using the [runtime reset procedure](local-runtime.md).
This destroys recovery history. It does not delete GitHub records or provider data.

## Verify the controls

```sh
python3 runtime/test.py
python3 runtime/worker/test.py
```

The suites use disposable PostgreSQL, real containers and the installed SDK with
a synthetic provider. They cover restart-safe metadata, missing usage, queued and
active cancellation, limits, publication/review identity, retention, worker and
database crashes, and backup restore. They require no paid model calls.
