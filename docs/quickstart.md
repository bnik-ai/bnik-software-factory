# Quickstart

Start with a disposable checkout or extracted candidate source in a directory you
own. Run commands from its root as a non-root user. There is no public clone URL
or released tag yet; use the exact candidate commit supplied by your maintainer.
Do not reuse a live operator checkout for this demo.

## Prerequisites and costs

- Docker Engine with Compose v2, running in the intended **local** Docker context.
  Linux arm64 containers on macOS arm64 Docker Desktop and Linux x64 contributor
  CI have been exercised. See the [version/support matrix](../SUPPORT.md).
- Python 3 for configuration and demo commands; Git for a source checkout; `curl`
  for the readiness check. Host Node/npm is needed only for the separate native
  worker/contributor steps, where Node 24.21.0 is the selected version.
- Network access to the pinned Node/PostgreSQL base images and npm registry during
  the build, free local port 8787, and disk space for images and the database.
  The optional worker alone is limited to 2 GiB RAM and two CPUs; Docker must have
  additional capacity for PostgreSQL, the proxy and control plane. No universal
  minimum host capacity or build-time estimate has been qualified.

The demo uses generated local database/webhook secrets and synthetic GitHub data.
It needs **no GitHub App, callback URL or Anthropic credential** and makes no model
call. Docker downloads, local storage and hosted CI may still have costs.
The optional real workflow uses your own Anthropic API account, GitHub repository
and HTTPS webhook endpoint. Every intentional revision is another authorized run.
The default SDK budget threshold is USD 5 per run, with up to four attempts per
Task; this is **not a billing cap or price quote**. Read [usage and limits](run-controls.md)
and your provider's current account pricing before activating a real Task.

## 1. Configure once

```sh
python3 runtime/configure.py --mode demo
```

Expect `Local configuration created. Secret values were not printed.` The command
creates ignored `runtime/.env` and `runtime/secrets/` with private permissions.
It refuses to overwrite either existing path. For another free port, add
`--port 8788` now and use that port in the readiness URL below.

Use one consistent Compose project for all commands. The default project name is
`software-factory`; to run a separate copy alongside another installation, set a
unique name and port before starting it:

```sh
export COMPOSE_PROJECT_NAME=factory-quickstart
```

This environment variable must remain set for subsequent `build`, `up`, `exec`,
`stop` and `down` commands in this terminal. Each project has its own database
volume; images use shared development tags, so coordinate rebuilds with other
local operators.

## 2. Build and start

```sh
docker compose -f runtime/compose.yaml build
docker compose -f runtime/compose.yaml up -d --wait
curl --fail http://127.0.0.1:8787/readyz
```

Expect HTTP 200 with:

```json
{"ready":true,"mode":"demo","liveWorkerEnabled":false}
```

The migrator exits successfully after creating/checking the schema. PostgreSQL
and the runtime stay healthy. The false worker flag is expected: this service does
not automatically execute coding jobs. Readiness checks the database, not GitHub
permissions or provider availability. Only loopback port 8787 is published;
PostgreSQL has no host port in this profile.

## 3. Submit a synthetic Task

```sh
python3 runtime/demo.py
docker compose -f runtime/compose.yaml exec -T runtime node --import tsx src/main.ts status
```

The demo prints an accepted-delivery response and explains that no external PR or
model run was created. Processing is asynchronous; repeat `status` after a few
seconds if work is still pending. For one accepted delivery in a fresh database,
expect three completed rows in the queue summary: one each for raw events,
validation verdicts and BuildAgent jobs. The final worker result is
`fixture_completed_no_external_effect`. A later demo invocation creates a new
synthetic delivery, so counts grow. This proves local intake, validation and
routing, not model execution or the human merge policy.

## 4. Check persistence and stop

```sh
docker compose -f runtime/compose.yaml stop
docker compose -f runtime/compose.yaml up -d --wait
docker compose -f runtime/compose.yaml exec -T runtime node --import tsx src/main.ts status
docker compose -f runtime/compose.yaml down
```

The completed counts survive the restart. Ordinary `down` removes this project's
containers/network while retaining its database. It does not remove configuration,
local images or credential files.

If this is a disposable demo and its data is no longer needed, discard **only
this project's** volume using:

```sh
docker compose -f runtime/compose.yaml down --volumes
```

Back up anything needed first using [backup and restore](local-runtime.md#backup-restore-and-reset).
After stopping the disposable stack, remove its generated `runtime/.env` and
`runtime/secrets/` if you no longer need them. Never delete another installation's
configuration or use a global Docker prune for this cleanup.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Docker connection fails | Start the local daemon and inspect `docker context show`; do not switch to a remote production daemon. |
| Configuration already exists | Preserve it. Use a fresh source directory for the demo; do not change a live configuration to demo mode. |
| Port is in use | Stop only your conflicting demo or configure a fresh copy with another `--port`; update the readiness URL. |
| Secret file permission denied | Configure as the same non-root host user who runs Docker; retain generated UID/GID and private file permissions. |
| Pull/npm install fails | Check registry access and pinned image/package availability; do not remove pins or enable lifecycle scripts as a workaround. |
| `up --wait` fails | Inspect `docker compose -f runtime/compose.yaml ps -a` and logs for `migrate`/`runtime`; readiness needs a migrated database. |
| Migration checksum mismatch | Preserve the database and installed commit. Follow [recovery](recovery.md); do not edit recorded checksums. |
| Status is pending or dead-lettered | Allow normal queue processing, then use [recovery inspection](recovery.md); successful HTTP intake is not workflow completion. |

Logs and receipts may contain repository content. Redact them before sharing.

## Next: isolated execution, then real GitHub work

Try the [credential-free isolated worker](isolated-worker.md) in a fresh demo
checkout. It runs actual test commands in disposable containers and returns a
patch, without a paid model. Its override exposes a loopback-only database port
for the trusted native supervisor.

For real work, use a **separate fresh configuration** and follow these guides in
order; placeholder values must be replaced with your own verified IDs:

1. [GitHub installation](github-installation.md): register a selected-repository
   App with exact permissions, set its HTTPS `/webhook` callback and shared secret,
   install the private key locally, and verify an actual delivery. No OAuth callback
   or user-login server is part of this installation.
2. [Human merge profile](human-merge.md): configure protection, expected CI App IDs,
   human owners/mergers and the trusted local policy before opening a tracked PR.
3. [End-to-end walkthrough](end-to-end-pilot.md): install the five service lockfiles,
   configure your own model key, review a Task with an exact accessible model ID,
   post a fresh activation, execute explicitly, review/publish output, request a
   revision, approve and merge as a human, and verify Task reconciliation.
4. [Run controls](run-controls.md) and [recovery](recovery.md): inspect accounting,
   cancel or recover uncertain work and retain evidence. Do not automatically retry
   a paid failure. On teardown, stop the tunnel, remove only test installations and
   revoke their credentials as described in the installation guide.

No example authorizes publishing this factory, inviting outside users or distributing
vendor-containing images. See [third-party terms](../THIRD_PARTY.md).
