# GitHub App installation and human Task activation

Use the same shell for the native example so `FACTORY_EXERCISE` remains set.
For Docker-only host operation, use [the container launcher](container-runtime.md).
The low-level commands below describe the optional native profile; the mapping
covers configuration, secret paths, worker/recovery commands and sample artifacts.
Do not mix its `runtime/` state with the launcher's `.factory/` state.

This candidate supports one explicitly configured GitHub.com repository. Start with
a disposable repository containing synthetic data. Live intake records events and
human activation receipts; it never automatically invokes a model. In the default human-gated mode, PR publication is an explicit operator step in the
[end-to-end walkthrough](end-to-end-pilot.md); the opt-in [bounded-autonomy controller](autonomy-operations.md), live-qualified on commit `2d4d48a` ([record](../evals/qualification/2d4d48a.json); later commits are not themselves qualified), publishes under an activated policy instead. The optional [human merge profile](human-merge.md)
adds protected review, CI verification and Task reconciliation for explicitly paired PRs.

## Register a dedicated App

Create a private GitHub App you own, with an active HTTPS webhook ending in
`/webhook`, JSON payloads and SSL verification enabled. Use your own domain/reverse
proxy or an HTTPS tunnel you control to forward only that endpoint to the local
runtime. Keep port 8787 on loopback, keep PostgreSQL private, and do not expose
Docker, credentials, repository files or an administration interface. A temporary
tunnel URL must remain stable for the test; update both App settings and local
configuration when it changes. Network, domain and tunnel provisioning are operator
responsibilities.

For intake alone, use exactly these repository permissions, with no organization/account
permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read-only | Default-branch identity and pinned source snapshot |
| Issues | Read-only | Task, labels and current activation comment |
| Pull requests | Read-only | Observe PR and review events |
| Checks | Read-only | Observe check run and suite events |
| Commit statuses | Read-only | Observe status events |
| Metadata | Read-only | Repository and current collaborator permission |

The [human merge profile](human-merge.md#app-and-local-configuration), which automatic
merge requires, replaces them with its own exact set.

Subscribe to **Issues, Issue comment, Pull request, Pull request review, Check run,
Check suite, Status**. Installation lifecycle and ping deliveries are liveness
records only. Write grants and extra permission categories are rejected by the intake
profile. Use a dedicated App instead of expanding an existing broadly privileged
installation. Use a separate, narrowly scoped publisher for the explicit publication step described
in the end-to-end walkthrough.

Install using **Only select repositories**, selecting exactly the intended one.
“All repositories” is rejected even if the account currently has only one repo.
The repository must have an initial commit/default branch and be enabled and
unarchived. Record its numeric repository ID, `OWNER/REPOSITORY`, App ID and slug,
and the installation ID. These IDs are distinct. GitHub Enterprise Server,
multiple repositories and owner-wide installations are unsupported.

Generate/download the App's RSA private key. Use a random webhook secret and set
the same value in GitHub and your local secret file. Never commit or paste keys
into issues, Task definitions or model prompts. Official references:
[App webhooks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps),
[App manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

## Apps for bounded autonomy (opt-in)

Bounded autonomy ([operations](autonomy-operations.md)) adds no grant of its own to the
intake App. When the merge policy is configured, which `--automerge` requires, the intake
App holds the [human merge profile](human-merge.md#app-and-local-configuration)'s grants,
and publication uses its Issues write to pair the Task with its pull request. Bounded
autonomy uses up to two more Apps, each registered and installed separately, each holding only what
its step needs, each minting one short-lived installation token per action and revoking it:

| App | Repository permissions | Installed on | Used by |
| --- | --- | --- | --- |
| Publisher | Contents: read and write, Pull requests: read and write, Metadata: read-only | the repository the branch is written to (the fork with `--publication fork`, or the base with the secretless-CI attestation) and the base | `./sfac autonomy run` when a verified change is published |
| Merger (`--automerge`) | Contents: read and write, Pull requests: read and write, Metadata: read-only | the base repository only | `./sfac autonomy merge` and `merge-scan`; it approves routine work as itself and squash-merges the exact head, under the [automatic-merge protection profile](human-merge.md) |

The publisher and the merger must be different Apps (the installer refuses the same App id),
and neither is a bypass allowance in branch protection: the merger App is a restricted
pusher, nothing more. Their private keys live at `secrets/publisher_private_key` and
`secrets/merger_private_key`; the merger key is mounted only into the container that runs
the merge commands. Both Apps stay unused, and their keys need not exist, until the
corresponding opt-in is configured. This path passed live qualification on commit `2d4d48a`
([record](../evals/qualification/2d4d48a.json)). Later commits are not themselves qualified; see
[live qualification](live-qualification.md).

## Configure and verify intake

With Docker/Compose, Python 3 and host Node/npm installed, from this repository root:

```sh
python3 runtime/configure.py --mode live --repository OWNER/REPOSITORY --repository-id REPOSITORY_ID --installation-id INSTALLATION_ID --app-slug APP_SLUG --app-id APP_ID --webhook-url https://YOUR-HOST/webhook --operators HUMAN_LOGIN --execution disabled
```

Replace all placeholders with your own values. The command creates ignored
`runtime/.env` and private `runtime/secrets/` once; it refuses to overwrite existing
configuration. Put your PEM in `runtime/secrets/app_private_key` (mode 0600), and
copy the generated `runtime/secrets/webhook_secret` value into your App's webhook
secret setting. If using the manifest registration flow, put its generated webhook
secret in this file instead. Do not add a model key for intake verification.
`--operators` accepts a comma-separated list of human logins, not bots or teams.
Current repository write/admin permission is also required; this list alone is
not authorization.

```sh
for service in agents github-app orchestrator validator local-runtime; do
  npm ci --prefix "services/$service" --ignore-scripts --no-audit --no-fund || exit 1
done
docker compose -f runtime/compose.yaml -f runtime/compose.live.yaml -f runtime/compose.worker.yaml up --build -d --wait
python3 runtime/worker.py github-check
curl --fail http://127.0.0.1:8787/readyz
```

This starts the intake profile. With the
[human merge profile](human-merge.md#app-and-local-configuration)'s grants, which automatic
merge requires, start with that section's command instead, which adds
`runtime/compose.review.yaml`; this one refuses those grants
(`installation_permissions_or_events_invalid`).

The worker override exposes PostgreSQL only on `127.0.0.1:55432` for the trusted
native CLI. Use `--port` and `FACTORY_DATABASE_PORT` for alternate free local ports.
Startup authenticates the App ID/slug, installation owner/ID, exact permissions,
required subscriptions, selected repository ID/name and secure webhook URL. Tokens
are restricted and revoked after each protected read. A failed check prevents
startup. `/readyz` checks the local database; it is not a continuous GitHub health
or authorization check. No model credential is mounted into the live service.

Create an ordinary issue in the configured repository. In the App's **Recent
deliveries**, verify an actual GitHub `issues` delivery received HTTP 202 and note its
`X-GitHub-Delivery` UUID. `status` prints work counts by queue and state, including
`GitHubIntake`:

```sh
docker compose -f runtime/compose.yaml exec runtime node --import tsx src/main.ts status
```

To match the UUID itself, an authorized database operator can inspect
`webhook_deliveries.delivery_id` and
`factory_work` (`queue_name = 'GitHubIntake'`, `delivery_key` is the same UUID).
An ordinary event settles as `observed_no_activation`. HTTP 202 means durable
intake, not activation or execution. Invalid signatures, repository/installation
mismatches and unsupported events are rejected before dispatch. Redelivery of the
same UUID/body is idempotent; a conflicting payload returns HTTP 409.

## Review and activate one Task

Create labels `kind:task` and `status:proposed` in the selected repository. Create
an open, unlocked issue from [the Task template](../templates/app-repo/factory-task.md),
with both labels and no other `status:` label. Its single fenced `factory-task`
JSON block specifies `prompt`, `tests`, `model`, `maxTurns` and `timeoutMs`. Review
all issue text, source code, test commands and cost limits as untrusted inputs.
Do not include credentials. No label, author association, structural comment or
model-generated statement authorizes execution.

Obtain the full 40-character current default-branch commit and run:

```sh
FACTORY_EXERCISE=$(mktemp -d "${TMPDIR:-/tmp}/factory-exercise.XXXXXX")
python3 runtime/worker.py prepare-task ISSUE_NUMBER FULL_COMMIT_SHA $FACTORY_EXERCISE/factory-task-review
```

The new private directory contains `task.json`, including the exact issue snapshot
and parsed request. Review it and the pinned source. Then, as a configured human
operator, post the printed command directly on that issue:

```text
/factory activate FULL_COMMIT_SHA TASK_SHA256
```

Use a new comment, not an edit. The receiver checks the signed repository and
installation identity, human sender/comment identity, configured operator list,
current write/admin permission, unchanged current comment, current issue hash and
current default-branch head. The command must be no older than one hour. Task text
can suggest work, but cannot grant authority. Outsiders filing issues/commenting,
App/bot comments and edited commands cannot start paid jobs.

```sh
python3 runtime/worker.py activations
```

A successful record has its own UUID, issue/comment IDs, human login, source commit
and Task hash. Authorization and delivery settlement commit together. A duplicate
comment cannot create another activation, even with another delivery UUID. Rejected
activation attempts are dead-lettered with a reason; transient GitHub failures retry
within the queue limit. Approval remains revocable: current facts are checked again
before execution.

## Optional explicit model execution

Only after reviewing the activation, set `FACTORY_EXECUTION=manual` in ignored
`runtime/.env` and store your own Anthropic API key in `runtime/secrets/model_key`
(mode 0600). Select a model ID actually available to your account in the Task;
there is no default/substitution. This command spends your provider quota:

```sh
docker build -f runtime/worker/Dockerfile -t software-factory-worker:development .
python3 runtime/worker.py run-activation ACTIVATION_UUID $FACTORY_EXERCISE/factory-task-result
```

The native supervisor revalidates authorization before source download and again
under its lease before execution. It produces a local patch and actual test-command
receipts. The live Compose service remains intake-only even with manual execution
selected locally. Bare JSON jobs are accepted only in demo mode. See the
[isolated worker contract](isolated-worker.md) for source/tool limits, cancellation,
cleanup, proxy credential isolation and uncertain external effects. This step
neither publishes a PR nor marks a Task complete.

## Distinguish fixture checks from live evidence

`runtime/demo.py` is a clearly synthetic validator/router demonstration with fixture
GitHub reads and no provider calls. `runtime/test.py` exercises signatures, scope,
unauthorized activation, durable transactions and revocation using fixture GitHub
responses against real PostgreSQL. `runtime/worker/test.py` exercises real disposable
worker containers with synthetic inputs. None proves a live GitHub installation.
A real check must correlate GitHub's Recent deliveries UUID/status with a stored
receipt and an authorization record from an actual human-created comment in a
separate disposable repository. Keep evidence private and redact payloads/headers
that contain credentials or repository content.

After a disposable exercise, stop the runtime and tunnel, uninstall the test App
from the test repo, and revoke/delete its test-only key. Keep any retained repository
private. Preserve needed receipts before discarding the dedicated database; see
[backup and reset](local-runtime.md#backup-restore-and-reset). Never remove another
installation or overwrite an existing operator configuration during a test.
