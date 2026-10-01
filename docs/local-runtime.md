# Local PostgreSQL runtime

For Docker-only host operation, use [the container launcher](container-runtime.md).
The low-level commands below describe the optional native profile; the mapping
covers configuration, secret paths, worker/recovery commands and sample artifacts.
Do not mix its `runtime/` state with the launcher's `.factory/` state.

This private development candidate runs authenticated intake, validation, audit and
routing with durable PostgreSQL queues. The packaged demo uses synthetic GitHub
reads and a receipt-only worker. Live mode verifies GitHub installation and human Task activation, storing durable
authorization receipts. The separate [isolated executor](isolated-worker.md) accepts
explicit requests bound to those receipts. The [end-to-end walkthrough](end-to-end-pilot.md) connects activation, explicit execution, operator publication and human merge. Publication is manual in the default mode (the opt-in [bounded-autonomy controller](autonomy-operations.md), live-qualified on commit `039c43a` ([record](../evals/qualification/039c43a.json); later commits are not themselves qualified), is the exception); the demo is not that live workflow.

For explicitly paired PRs, the optional [human merge profile](human-merge.md) checks
native protection, human review and required CI, then reconciles verified human merges
and, with opt-in automatic merge, the merger App's admitted merges.

## Verified environment and dependencies

The container target is Linux arm64, verified on macOS arm64 with Docker Desktop
(Engine 28.0.4, Compose 2.34.0). Images pin official multi-platform manifest digests:
Node 24.21.0 on Debian Bookworm slim and PostgreSQL 17.11 on Bookworm. Linux x64 database/worker integration has also run in contributor CI; other hosts
remain unqualified. `sfac` packages the language runtimes and needs none of the
native prerequisites below. Node source checks also ran on macOS Node 26.

## Native profile prerequisites

The optional native profile needs Docker, Compose, Python 3, curl and Node 24.21.0
with npm on the host. Install the locked dependencies of all five services as in
[local checks](../CONTRIBUTING.md#local-checks); the native worker, recovery and
autonomy commands (`runtime/worker.py`, `runtime/recovery.py`, `runtime/autonomy.py`)
refuse to start until `services/local-runtime` is installed.

Those commands reach PostgreSQL on host loopback port 55432, which only
`runtime/compose.worker.yaml` publishes. When you use them, add
`-f runtime/compose.worker.yaml` to every Compose command in these guides, so a later
`up` keeps the port. To choose another port, set `FACTORY_DATABASE_PORT` in
`runtime/.env`; Compose and the native commands both read it there.

The control-plane image installs locked dependencies with lifecycle scripts
disabled. It includes no installed Claude Agent SDK or coding worker. Installed
Node dependency and OS image notices still need final artifact review before an
image is distributed. The image is built locally; no registry push is required.

## Start the demo

From the repository root, as a non-root user:

```sh
export COMPOSE_PROJECT_NAME="factory-native-$(date +%Y%m%d%H%M%S)-$$"
export FACTORY_LOCAL_IMAGE="$COMPOSE_PROJECT_NAME-local:development"
export FACTORY_WORKER_IMAGE="$COMPOSE_PROJECT_NAME-worker:development"
python3 runtime/configure.py --mode demo
docker compose -f runtime/compose.yaml build
docker compose -f runtime/compose.yaml up -d --wait
curl --fail http://127.0.0.1:8787/readyz
python3 runtime/demo.py
docker compose -f runtime/compose.yaml exec runtime node --import tsx src/main.ts status
```

Keep these project/image variables set for every native command, including worker
builds (`docker build -f runtime/worker/Dockerfile -t "$FACTORY_WORKER_IMAGE" .`).
The raw Compose fallback tags are shared; the variables isolate this installation.

Configuration creates ignored `runtime/.env` and `runtime/secrets/` once and refuses
to overwrite them. Secrets are generated locally and never printed. The configured
host UID/GID allows the non-root container to read those private files. If port
8787 is occupied, supply `--port <free-port>` when creating configuration.

The database starts with SCRAM host authentication. A one-shot migrator creates
versioned, checksum-verified schema and separate `factory_runtime` and
`factory_controller` logins. The
runtime can update delivery/work state and append audit records, but cannot create
schema, delete work or rewrite the audit ledger. It does not receive the database
administration credential. The local launcher never constructs Azure credentials.

The demo posts one synthetic Task transition attributed to its fixture planner.
The real parser, FSM, assertions, audit writer and router produce a BuildAgent job;
the demo worker records `fixture_completed_no_external_effect`. It creates no PR,
executes no model and does not demonstrate human Task activation or approval policy.
Expect three `done` rows (`validator`, `orchestrator`, `BuildAgent`) per delivery.
To inspect the actual completion marker:

```sh
docker compose -f runtime/compose.yaml exec runtime node --import tsx src/operator.ts demo-status
```

Only the webhook port is exposed, bound to host loopback. PostgreSQL has no host
port unless `runtime/compose.worker.yaml` is added (see
[native profile prerequisites](#native-profile-prerequisites)). `read_only`, dropped capabilities, non-root identity
and temporary `/tmp` apply to the control-plane container. They are not a coding
sandbox; the image starts no model-executed shell.

## Configuration and live control-plane mode

`FACTORY_MODE=demo|live`, one `FACTORY_REPOSITORY`, `GITHUB_INSTALLATION_ID`,
`GITHUB_APP_SLUG`, webhook secret and all database coordinates are required.
Passwords/keys accept either `NAME` or `NAME_FILE`, never both. Demo rejects live
model/App credentials. The local profile rejects Azure/Service Bus configuration.

Follow the [GitHub installation guide](github-installation.md) for the exact read-only
App permissions, event subscriptions, single-repository selection, HTTPS endpoint,
operator list and credentials. Live mode additionally requires immutable repository
ID, App ID/key, webhook URL and explicit `FACTORY_EXECUTION=disabled|manual|bounded`.
`disabled` rejects a model key. `manual` and `bounded` require one, and only the
supervisor commands receive it; `bounded` is the opt-in
[bounded-autonomy](autonomy-operations.md) mode. The Compose live service is always
intake-only and receives no model credential.

Live startup authenticates the App and verifies the installation, permissions,
repository selection and webhook settings before listening. Unsupported settings
fail closed without a default repository or fixture fallback. Ordinary issues,
comments and PR events do not dispatch paid work. Only a current, unchanged command
from a configured human with current repository write permission can create an
activation receipt. A separate local command rechecks that authorization before
isolated execution. Live intake does not run the legacy validator/agent pipeline;
the demo exercises that pipeline separately. Existing raw and `BuildAgent` jobs
are not consumed by live intake or by the isolated executor.

The generic service can also run natively after installing its four sibling/source
packages and its own lockfile. Use explicit `POSTGRES_HOST`, `POSTGRES_PORT`,
`POSTGRES_DATABASE`, `POSTGRES_USER`, `POSTGRES_PASSWORD_FILE` and `POSTGRES_TLS`.
`disable` is permitted only for loopback or the Compose `db` hostname; remote
connections require `verify-full`, optionally with `POSTGRES_CA_FILE`. Run migrations
with a separate owner credential and `FACTORY_DB_PASSWORD_FILE`, then start with
the restricted runtime login. Use a dedicated empty database; migrations refuse
unmanaged pre-existing factory tables and fail on checksum drift.

## Durability, limits and operations

Each queue serializes enqueue/claim decisions briefly; processing happens without
holding a database transaction. FIFO is per record within a queue, not a global
ordering across roles or a guarantee of GitHub event arrival order. Independent
records can be claimed concurrently. The control plane's queues use one database role,
`factory_runtime`; the opt-in bounded-autonomy controller connects as a separate
`factory_controller` role. Per-consumer role/process isolation and production-scale
throughput are not claimed.

Defaults: 30-second renewable leases, five attempts, exponential retry from one
second capped at 60 seconds, pool size eight, ten-second statement and outbound
read timeouts. Environment overrides are `FACTORY_LEASE_MS`, `FACTORY_MAX_ATTEMPTS`,
`FACTORY_RETRY_MS`, `FACTORY_MAX_RETRY_MS`, `POSTGRES_POOL_MAX`, `FACTORY_POLL_MS`
and `FACTORY_SHUTDOWN_MS`. Numeric bounds are validated at startup. The input body
limit is 1 MiB. Same delivery IDs with conflicting payloads return HTTP 409.

A lost/expired token cannot acknowledge, renew or commit database effects. Renewal
failure aborts the handler signal. On SIGTERM/SIGINT, intake stops and active work
gets a bounded drain while leases renew; an unresponsive process exits after ten
seconds and its uncommitted claims expire. Normal shutdown leaves the data volume.

```sh
docker compose -f runtime/compose.yaml stop
docker compose -f runtime/compose.yaml up -d --wait
```

The durable downstream queue is the outbox: audit/decision/publication/settlement
commit together, and routing/job insertion/settlement commit together. If the
process dies inside a transaction, PostgreSQL rolls it back. If it dies after the
commit response is lost, the stored decision and outgoing job remain intact.
Retries never recompute a committed verdict. This is not exactly-once execution
of GitHub/model effects; uncertain external effects are reconciled as described in
the [recovery runbook](recovery.md#reconcile-uncertain-effects).

Malformed work is dead-lettered with a reason; transient failures retry within the
attempt bound, including leases abandoned by crashed processes. Status shows queue
and state counts. The [recovery runbook](recovery.md) provides authenticated
inspection, quarantine and one-attempt replay for eligible intake/reconciliation
items. Paid coding jobs are never replayed: the default mode requires fresh human
activation, and bounded autonomy a `run --new-attempt` within its scope.

Completed raw payloads and result snapshots can be compacted after a chosen number
of days while delivery hashes/keys remain to prevent duplicate execution:

```sh
docker compose -f runtime/compose.yaml exec runtime node --import tsx src/main.ts compact 30
```

Pending/running/dead-letter bodies, Task activation proofs and the hash-chained
audit ledger are retained.
Compaction is explicit, not a background deletion policy. Plan storage and backup
retention for the volume and receipt indexes.

## Backup, restore and reset

Create a private backup without copying App/model credentials into it:

```sh
mkdir -p runtime/backups
chmod 700 runtime/backups
(umask 077; set -C; docker compose -f runtime/compose.yaml exec -T db pg_dump -U factory_migrator -d software_factory -Fc > runtime/backups/factory.dump)
```

Use a new filename per backup. Backups contain repository/event content; the backup
directory is ignored by Git. Keep the ignored credential files separately. PostgreSQL
custom-format dumps are transactionally consistent; do not copy a running data
directory as if it were a portable backup.

Validate a restore into a **new** database before replacing working data:

```sh
docker compose -f runtime/compose.yaml exec db createdb -U factory_migrator factory_restore_check
docker compose -f runtime/compose.yaml exec -T db pg_restore -U factory_migrator -d factory_restore_check --no-owner < runtime/backups/factory.dump
docker compose -f runtime/compose.yaml exec -e POSTGRES_DATABASE=factory_restore_check runtime node --import tsx src/operator.ts verify-database
```

`createdb` fails if that database already exists. On a new server, initialize the
migrator, runtime and controller roles first using the same credential files; database dumps do not
contain role passwords. Verify schema checksums, row counts and audit-chain integrity
in the restored database. Stop processing before a recovery cutover and explicitly
point both migration and runtime database settings to the verified restore. Database
restore cannot reverse already-completed GitHub/model effects; reconcile them before
resuming live supervisors or the autonomy controller.

To intentionally discard only this Compose project's local data, first keep a
verified backup, then run `docker compose -f runtime/compose.yaml down --volumes`.
A later `up` initializes an empty database. Ordinary `stop`/`down` without `--volumes`
preserves it. Configuration and credential files are separate and are not removed.

## Reproduce the failure checks

```sh
python3 runtime/test.py
```

This builds the pinned image, creates a disposable database/network, runs unit and
real PostgreSQL contracts, kills consumers at transaction boundaries, kills and
restarts PostgreSQL, verifies a backup restored into a new database, and removes
its fixtures. It uses no live GitHub/model keys.
A successful result establishes transport/storage behavior, not production readiness.
