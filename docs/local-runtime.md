# Local PostgreSQL runtime

This private development candidate runs authenticated intake, validation, audit and
routing with durable PostgreSQL queues. The packaged demo uses synthetic GitHub
reads and a receipt-only worker. Live mode supports the control plane and leaves
agent jobs queued. Live coding, human merge enforcement and onboarding remain
under development; this is not a complete end-to-end alpha installation.

## Verified environment and dependencies

The container target is Linux arm64, verified on macOS arm64 with Docker Desktop
(Engine 28.0.4, Compose 2.34.0). Images pin official multi-platform manifest digests:
Node 24.21.0 on Debian Bookworm slim and PostgreSQL 17.11 on Bookworm. Other hosts
and amd64 are not yet verified. Docker, Compose and Python 3 are required for the
launcher and integration exercise. Node source checks also ran on macOS Node 26.

The control-plane image installs locked dependencies with lifecycle scripts
disabled. It includes no installed Claude Agent SDK or coding worker. Installed
Node dependency and OS image notices still need final artifact review before an
image is distributed. The image is built locally; no registry push is required.

## Start the demo

From the repository root, as a non-root user:

```sh
python3 runtime/configure.py --mode demo
docker compose -f runtime/compose.yaml build
docker compose -f runtime/compose.yaml up -d --wait
curl --fail http://127.0.0.1:8787/readyz
python3 runtime/demo.py
docker compose -f runtime/compose.yaml exec runtime node --import tsx src/main.ts status
```

Configuration creates ignored `runtime/.env` and `runtime/secrets/` once and refuses
to overwrite them. Secrets are generated locally and never printed. The configured
host UID/GID allows the non-root container to read those private files. If port
8787 is occupied, supply `--port <free-port>` when creating configuration.

The database starts with SCRAM host authentication. A one-shot migrator creates
versioned, checksum-verified schema and a separate `factory_runtime` login. The
runtime can update delivery/work state and append audit records, but cannot create
schema, delete work or rewrite the audit ledger. It does not receive the database
administration credential. The local launcher never constructs Azure credentials.

The demo posts one synthetic Task transition attributed to its fixture planner.
The real parser, FSM, assertions, audit writer and router produce a BuildAgent job;
the demo worker records `fixture_completed_no_external_effect`. It creates no PR,
executes no model and does not demonstrate human Task activation or approval policy.
Expect three `done` rows in the status output per accepted demo delivery.

Only the webhook port is exposed, bound to host loopback. PostgreSQL has no host
port in this Compose profile. `read_only`, dropped capabilities, non-root identity
and temporary `/tmp` apply to the control-plane container. They are not a coding
sandbox; the image starts no model-executed shell.

## Configuration and live control-plane mode

`FACTORY_MODE=demo|live`, one `FACTORY_REPOSITORY`, `GITHUB_INSTALLATION_ID`,
`GITHUB_APP_SLUG`, webhook secret and all database coordinates are required.
Passwords/keys accept either `NAME` or `NAME_FILE`, never both. Demo rejects live
model/App credentials. The local profile rejects Azure/Service Bus configuration.

For a fresh live configuration:

```sh
python3 runtime/configure.py --mode live --repository OWNER/REPOSITORY --installation-id INSTALLATION_ID --app-slug APP_SLUG --app-id APP_ID
```

Put your RSA App private key in `runtime/secrets/app_private_key` and model API key
in `runtime/secrets/model_key`, readable only by your user. Then use both files:

```sh
docker compose -f runtime/compose.yaml -f runtime/compose.live.yaml up --build -d --wait
```

Live startup rejects missing or invalid App identity, installation, webhook, model
or database configuration before opening the service. It does not silently choose
fixtures. This configuration check is not a live credential/permission test. App
permissions, activation and real workflow verification must be completed separately.
Live mode does not invoke legacy in-process agents, merge/deploy handlers or demo
workers; agent jobs wait durably for a supported isolated worker adapter.

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
records can be claimed concurrently. The supported control plane uses one database
role; separate role/process isolation and production-scale throughput are not claimed.

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
of GitHub/model effects; future workers must reconcile uncertain external effects.

Malformed work is dead-lettered with a reason; transient failures retry within the
attempt bound, including leases abandoned by crashed processes. Status shows queue
and state counts. Inspect dead-letter records with an authorized database operator;
there is no automatic replay of them or unsupported generic replay CLI here.

Completed raw payloads and result snapshots can be compacted after a chosen number
of days while delivery hashes/keys remain to prevent duplicate execution:

```sh
docker compose -f runtime/compose.yaml exec runtime node --import tsx src/main.ts compact 30
```

Pending/running/dead-letter bodies and the hash-chained audit ledger are retained.
Compaction is explicit, not a background deletion policy. Plan storage and backup
retention for the volume and receipt indexes.

## Backup, restore and reset

Create a private backup without copying App/model credentials into it:

```sh
mkdir -p runtime/backups
(umask 077; docker compose -f runtime/compose.yaml exec -T db pg_dump -U factory_migrator -d software_factory -Fc > runtime/backups/factory.dump)
```

Use a new filename per backup. Backups contain repository/event content; the backup
directory is ignored by Git. Keep the ignored credential files separately. PostgreSQL
custom-format dumps are transactionally consistent; do not copy a running data
directory as if it were a portable backup.

Validate a restore into a **new** database before replacing working data:

```sh
docker compose -f runtime/compose.yaml exec db createdb -U factory_migrator factory_restore_check
docker compose -f runtime/compose.yaml exec -T db pg_restore -U factory_migrator -d factory_restore_check --no-owner < runtime/backups/factory.dump
docker compose -f runtime/compose.yaml exec db psql -U factory_migrator -d factory_restore_check -c 'SELECT queue_name,state,count(*) FROM factory_work GROUP BY queue_name,state;'
```

`createdb` fails if that database already exists. On a new server, initialize the
migrator/runtime roles first using the same credential files; database dumps do not
contain role passwords. Verify schema checksums, row counts and audit-chain integrity
in the restored database. Stop processing before a recovery cutover and explicitly
point both migration and runtime database settings to the verified restore. Database
restore cannot reverse already-completed GitHub/model effects; reconcile them before
resuming future live workers.

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
