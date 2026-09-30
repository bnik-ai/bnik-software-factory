# Containerized local operation

`./sfac` runs configuration, signed demo submission, supervisor, recovery and result
preparation inside an image containing Python 3, Node 24.21.0 and the five locked
service installs. Only Docker/Compose, a POSIX shell and basic shell utilities are
needed on the operator host. The database stays on the Compose network. This is
local hosting: live operation still depends on GitHub, Anthropic and an operator-owned
HTTPS tunnel/reverse proxy. Publication, review and merge are human in the default
mode; opt-in bounded autonomy publishes routine work, and opt-in automatic merge
merges it, without a human step. It is not an offline model or an automatically
published application.

```text
Host: shell + Docker CLI                   .factory/ (private state/artifacts)
              |                                         |
              +--> operator container (no socket) -------+
              |          | internal network
              |          +--> PostgreSQL <--- control plane <-- HTTPS ingress
              |
              +--> trusted supervisor container (Docker socket)
                             |
                             +--> isolated worker (no socket, host files or network)
                             +--> API proxy (live jobs only)
```

The supervisor has full local Docker daemon authority, including the ability to
start containers with host mounts. Containerizing it does not make it untrusted or
remove that authority. Use trusted factory source/images and a dedicated host for
sensitive workloads. Commands mount individual configuration/secret files according to the table below.
No operator or supervisor command receives the database administrator password.
Only the supervisor commands receive the Docker socket: `worker run`, `run-activation`
and `recover`, and `autonomy intent`, `pin`, `run`, `cancel`, `merge`, `merge-scan`
and `recover`.
Workers retain their existing restricted boundaries.

| Command | Mounted credentials | Other mounts |
| --- | --- | --- |
| `ready` | None | None |
| `demo-source`, `prepare-result` | None; network disabled | Artifacts |
| `status`, `demo-status`, `verify-database`, `compact`, `recovery`; worker `status`, `cancel`, `prune`, `activations` | Runtime database password | Configuration |
| `demo` | Webhook signing secret | Configuration |
| Worker `github-check`, `prepare-task`, `record-pr`, `track-pr`, `review-scan`, `review-status` | Runtime database password, webhook secret, App key | Configuration, artifacts, optional trusted merge policy |
| Worker `recover` | Runtime database password | Configuration, Docker socket |
| Worker `run` | Runtime database password, webhook secret | Configuration, artifacts, Docker socket |
| Worker `run-activation` | Runtime database password, webhook secret, App key, model key | Configuration, artifacts, optional trusted merge policy, Docker socket |
| Autonomy `activate`, `status`, `grant`, `revoke`, `pause`, `resume`, `approve`, `reconcile` | Controller database password, webhook secret | Configuration, autonomy policy |
| Autonomy `intent`, `pin`, `run`, `cancel`, `merge`, `merge-scan`, `recover` (demo; merge refuses) | Controller database password, webhook secret | Configuration, autonomy policy, acceptance bundle, artifacts, Docker socket |
| Autonomy `intent`, `pin`, `run`, `cancel`, `recover`, and `merge`, `merge-scan` without automatic merge (live; merge refuses) | Controller database password, webhook secret, App key, model key, publisher App key | Configuration, autonomy policy, acceptance bundle, artifacts, optional trusted merge policy, Docker socket |
| Autonomy `merge`, `merge-scan` (live, `FACTORY_AUTOMERGE=enabled`) | The above plus the merger App key | The above |

`init` is the bootstrap exception: it writes the fresh state directory and refuses
existing configuration or secrets. Database backup/restore runs inside the database
service under its existing administrator identity; it does not mount that password
into an operator container. Configuration contains non-secret identifiers/settings;
keep credentials in the designated secret files, never in `.env`.

Operator containers have a 512 MiB memory/swap ceiling, one CPU, 128 PIDs and a
128 MiB temporary filesystem. Supervisors use 1 GiB and 256 PIDs, with the same CPU
and temporary-filesystem limits. Ephemeral operator/supervisor Docker logging is
disabled; command output still reaches the caller and may contain source content.
These limits bound the supervisor process, not the privileged Docker daemon or the
separate containers it starts. Socket access remains full daemon authority.
The default daemon socket is `/var/run/docker.sock`; `FACTORY_DOCKER_SOCKET` can
select a daemon-host socket path, but rootless/remote configurations are unqualified.

## Files and commands

State defaults to `.factory/` beside `sfac`. Set an absolute `SFAC_STATE_DIR` to
reuse private state across source upgrades. Custom state must be **outside the source
build context**; `sfac` refuses a custom state directory inside the checkout, because
Docker would receive private files during a build. Do not share state between
installations. Do not change its persisted `project` name.

Operator commands run from `/artifacts`, backed by `.factory/artifacts/`. Pass
relative paths there or absolute `/artifacts/...` paths, not arbitrary host paths.
For example, `./sfac demo-source input` creates `.factory/artifacts/input/`.
A `run` output directory must be new. To retrieve an existing completed demo run,
repeat the same job with a different output path; it does not execute again.
Source snapshot transfers into the worker still use stdin, with no host bind mount.

| Native guide command/path | Container equivalent |
| --- | --- |
| `python3 runtime/configure.py ...` | `./sfac init ...` |
| Install five lockfiles; build control/worker images | `./sfac build` |
| Compose start/stop/logs | `./sfac up`, `stop`, `logs`, `ps` |
| `python3 runtime/worker.py ...` | `./sfac worker ...` |
| `python3 runtime/recovery.py ...` | `./sfac recovery ...` |
| `python3 runtime/worker/demo-source.py DIR` | `./sfac demo-source DIR` |
| `python3 examples/invoice/prepare-result.py ...` | `./sfac prepare-result ...` |
| `runtime/.env`, `runtime/secrets/`, `runtime/merge-policy/merge-policy.json` | `.factory/.env`, `.factory/secrets/`, `.factory/merge-policy/merge-policy.json` |
| `python3 runtime/autonomy.py …` with `autonomy-policy.json` and `acceptance/` | `./sfac autonomy …` with `.factory/autonomy-policy.json` and `.factory/acceptance/` (see [autonomy operations](autonomy-operations.md)) |
| `/tmp/example-input`, `/tmp/example-result` | Unique names under `/artifacts/` |

The native guides remain useful for explicit low-level operation. With `sfac`, do
not add `compose.worker.yaml`, expose PostgreSQL, install host Node/Python or mix
native configuration paths into the container commands. The launcher adds the live
override automatically when configured live and, in live mode, the review overrides
when `merge-policy/merge-policy.json` exists. Supply your App/model files and policy
using private permissions before startup. No provider keys are inherited from the host environment.

For the live sample, put your trusted sample checkout under `.factory/artifacts/`
and pass `/artifacts/SAMPLE` to `prepare-result`. Publishing the reviewed files to
GitHub remains a separate operator action using the GitHub UI or your chosen Git
publishing client. It is not a factory runtime dependency or an automatic action.
In the default mode, human Task approval, review and merge remain mandatory as
described in the live guides. Opt-in bounded autonomy and automatic merge are
described in [autonomy operations](autonomy-operations.md).

`./sfac worker cancel JOB_ID` is idempotent: `requested:0` means no matching active
work was changed, not that a job with that ID existed. A cancelled run can have a
`dead` queue row; inspect the run reason as well as queue state. `recovery inspect`
needs no daemon socket. `worker recover` does, because it removes labeled orphan
worker resources after leases expire; it never replays a paid run.

## Builds and verification

Image builds normalize image-owned source to readable files/searchable directories,
including exports made with `umask 077`. Host source and private secret modes are
unchanged. The contributor harness tests an actual restrictive source export.

Each installation builds its own operator/control/worker tags. Debian packages are
resolved at build time, so these are not byte-reproducible image claims. Existing
native test scripts also build unique per-run tags and remove only those tags.
To intentionally reuse an image, pass both `--skip-build --image EXACT_TAG`; the
script leaves a supplied image intact. Never rebuild another installation's tag.

The demo and boundary suites exercise synthetic workflows. An independent fresh
checkout retest, a clean-machine exercise and outside-human live onboarding remain
separate evidence. A container package change does not by itself requalify a paid
provider/GitHub end-to-end run or every OS/architecture.
