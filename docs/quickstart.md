# Quickstart

Use a fresh checkout of tag `v0.1.0-alpha` or an extracted source archive, owned by
your non-root user. Run these commands from the source root.

## Requirements and costs

Install Docker Desktop (macOS) or Docker Engine with the Compose v2 plugin (Linux), and
select the intended local Unix-socket Docker context. Your non-root user must be able
to use that context (on Linux usually through the `docker` group); `sfac` refuses to
run as root. The launcher uses a POSIX shell and standard shell utilities;
**host Python, Node, npm and a PostgreSQL port are not required**. Git is needed
only to obtain a checkout (an extracted source archive also works). Builds download
pinned base images and locked npm packages, plus Debian packages. Allow disk and
memory for the database, control plane and worker; the worker alone is limited to
2 GiB and two CPUs. See [support](../SUPPORT.md) for platform qualification.

This demo uses synthetic data, generated local secrets and no GitHub/model account.
Live use needs your own GitHub App, repository, reachable HTTPS webhook endpoint
and model credentials. Model calls spend your provider quota; thresholds are not
billing caps. Read [run controls](run-controls.md) before authorizing live work.

## Configure, build and start

```sh
./sfac init --mode demo
./sfac build
./sfac up
./sfac ready
```

`init` first builds the trusted operator image, then creates `.factory/.env` and
private `.factory/secrets/`. It refuses to overwrite configuration. Select another
free loopback port with `--port 8788` during initialization. Each installation gets
a persisted unique Compose project, database volume and image tags. `.factory/` is
ignored by Git and Docker builds. Keep this directory private and preserve it
across source upgrades; do not copy it to create a second installation.

Expect `{"ready":true,"mode":"demo","liveWorkerEnabled":false}`. The migrator
exits after checking/applying migrations; database and runtime remain healthy.
The false flag means coding execution requires an explicit operator command.
Readiness tests database connectivity, not GitHub/model availability. Only the
webhook port is published on loopback; PostgreSQL has no host port.

## Observe a completed demo

```sh
./sfac demo
./sfac status
./sfac demo-status
```

Processing is asynchronous; repeat the two status commands after a few seconds.
For one delivery in a fresh database, `status` shows one `done` row each for
`validator`, `orchestrator` and `BuildAgent`. `demo-status` displays the actual
`fixture_completed_no_external_effect` receipt. Additional demos increase counts.
This proves fixture intake/routing; the [isolated worker example](isolated-worker.md)
executes real test commands without a paid model.

## Persistence, backup and cleanup

```sh
./sfac stop
./sfac up
./sfac status
./sfac verify-database
./sfac backup demo.dump
./sfac restore-check demo.dump
./sfac down
```

Counts survive restart. Backups are created with private permissions under
`.factory/artifacts/`; existing filenames are refused. `restore-check` restores to
a new temporary database, verifies migration checksums, counts and the stored
audit hash chain, then drops only that temporary database. Both verification commands
print each migration version and SHA-256, plus `auditRows` and the hex `auditHead`
(all zeros for an empty ledger). Migration checks compare recorded digests with the
image's SQL files; they are not a complete inspection of the database schema. Compare its counts with
`verify-database` when no new work is arriving. This verifies the ledger's stored
hash chain, not independent authenticity of the original webhook contents or
protection against a database administrator rewriting the whole chain.

Ordinary `down` retains the database volume. To discard only this disposable
project's data after saving anything needed, use `./sfac down --volumes`.
After `down`, run `./sfac clean-images` to remove only this installation's three
image tags. It refuses while installation containers still exist and never uses
force deletion. Configuration, artifacts, retained database volumes and shared
build cache remain. Remove private state manually only when no longer needed;
never use a global Docker prune. Rebuild with `./sfac build` before the next `up`. Keep the project file
until its containers/volume have been removed so the launcher can address them.

## Troubleshooting and next steps

| Symptom | Action |
| --- | --- |
| Docker connection fails | Start Docker and inspect `docker context show`; remote contexts are unsupported. |
| Configuration exists | Preserve it; use a fresh source directory and another free port. See [credentials](credentials.md). |
| Port busy | Initialize a fresh demo with another `--port`. |
| Permission denied | Use the same non-root UID/GID that initialized state. Rootless Docker and Windows native are unqualified. |
| Build fails | Check registries/network; preserve pins and disabled npm lifecycle scripts. |
| Start fails | Run `./sfac ps -a` and `./sfac logs migrate runtime`; preserve failed data. |
| Pending/dead work | Inspect `./sfac recovery inspect`; HTTP acceptance alone is not completion. |

See [container operation](container-runtime.md) for commands, file paths, trust
boundaries and mapping the native live guides. Continue with [GitHub installation](github-installation.md),
[human merge](human-merge.md) and the [live walkthrough](end-to-end-pilot.md) using a
separate live configuration. Source builds are supported; prebuilt image distribution
is not approved. Logs and receipts can contain source content; redact before sharing.
