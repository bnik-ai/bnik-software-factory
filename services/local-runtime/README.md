# Local runtime

The PostgreSQL transport and local control-plane composition for BNIK Software
Factory. It imports the existing intake, validator, routing and wire-format code;
it does not maintain a second policy implementation.

See [local runtime instructions](../../docs/local-runtime.md) for configuration,
startup, shutdown, backup and recovery. `FACTORY_MODE` is mandatory. `demo` uses
synthetic GitHub reads and a receipt-only worker. `live` authenticates GitHub reads
and persists agent jobs; it does not launch a coding, merge or deployment worker.

Each queue provides per-record FIFO, stable delivery keys, payload conflict
detection, renewable claims, bounded retry and persistent dead letters. The
validator commits the audit row, verdict-bearing dispatch message and incoming
settlement together. The orchestrator similarly commits outgoing jobs with its
settlement. The downstream queue row is the transactional outbox.

A committed decision is not recomputed on delivery retry. A failed transaction
has no committed decision and can be evaluated again. External effects remain
at least once; a database lease cannot undo an external API call. Worker isolation
and reconciliation are required before enabling live coding execution.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run lint
npm run type-check
```

`npm run test:integration` requires a disposable PostgreSQL database and the test
configuration. Prefer `python3 runtime/test.py` from the repository root: it creates
and removes its own database/container/network and checks real process crashes.
