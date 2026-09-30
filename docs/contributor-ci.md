# Contributor checks and candidate builds

Ordinary pull requests run `Contributor CI` on fresh GitHub-hosted Ubuntu 24.04
x64 runners with Node **24.21.0**. The stable required check is `contributor-ci`;
it succeeds only after every service and integration job succeeds. Configure that
check as a required native repository protection when provisioning the public repo.
There are no path filters that silently omit a required check.

Five services run locked installs, tests, Biome lint and TypeScript checks. Script
contracts and generated diagrams are checked too, and so are the native CLIs' and the live
qualification driver's host-side contracts (`runtime/cli-test.py`,
`runtime/evals/live-test.py`; no Docker, network or model). Docker integration starts disposable
PostgreSQL and exercises durability, recovery and isolated worker contracts with a
synthetic model provider. It does not call a paid model. Installs use
`npm ci --ignore-scripts --no-audit --no-fund`; npm lifecycle scripts are not trusted.
Action references use full commit hashes, npm versions/integrities come from the
five lockfiles, and Node/PostgreSQL container bases use manifest digests.

## Trust boundary

Workflows use `pull_request`, never `pull_request_target` or privileged `workflow_run`.
They grant only `contents: read`, do not persist checkout credentials, and do not
use self-hosted runners, shared caches, environments, OIDC, secrets, registry logins,
releases, deployments or publishing. PR code is executable and must be treated as
hostile. Keep fork workflow write tokens and secrets disabled in repository settings;
require approval for outside contributors as appropriate. A PR can change its tests,
so a green check is not a substitute for maintainer review of code and workflow changes.

`node scripts/ci-boundary.mjs` checks for accidental operator credentials and Git
credential persistence. The script contracts simulate a hostile npm lifecycle
script and reject an inherited credential canary. These checks are regression
tripwires, not a sandbox against arbitrary code. The actual boundary is an ephemeral
hosted runner, no operator secrets, and GitHub's read-only fork token policy.
See [GitHub secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use).

Live model tests are separate operator actions: the
[explicit activation flow](github-installation.md) with the [isolated worker](isolated-worker.md),
and the maintainer-run [live qualification](live-qualification.md) job. They are not invoked
by any CI workflow. A future paid workflow requires separate
maintainer configuration and review; adding credentials to contributor CI is not
supported. CI can consume GitHub Actions runner minutes; no zero-runner-cost claim
is made.

## Deterministic source artifact

The manual `Candidate source artifact` workflow takes a full 40-character commit
SHA and builds twice, comparing every byte. It stores the tarball, per-file manifest
and `SHA256SUMS` as a seven-day workflow artifact. This is source packaging, not a
release approval or publication. No package, image, tag or GitHub Release is pushed.
The provisional version is `0.1.0-alpha`; the complete commit SHA qualifies every
artifact name and is recorded in its manifest.

From a checkout, with Python 3 and Git:

```sh
python3 scripts/build-candidate.py --commit "$(git rev-parse HEAD)" --output dist/candidate
```

Use a new output directory. The builder reads only committed Git blobs, ignoring
worktree edits and untracked files. Archives have normalized owners, commit timestamps,
file modes and gzip headers. Submodules, symlinks, private paths and obvious private
key contents are rejected. The manifest lists each included path, size and SHA-256.
Review the complete artifact before any disclosure; pattern checks cannot prove
that all unknown secrets or third-party rights issues are absent.

Only tracked source is shipped. No `.git`, dependencies, credentials, database,
container image or internal release plan belongs in the artifact. The project
license/provenance notices are included; source packaging is not publication
approval or permission to redistribute separately licensed vendor components.

## Runtime and build limits

The CI contract is Linux x64, Ubuntu 24.04, Node 24.21.0 and Docker. Linux arm64
runtime/worker containers have also been exercised through macOS Docker Desktop;
macOS Node 26 is a development check, not the selected CI runtime. Windows native,
other Node versions and non-Docker installations are unqualified.

Source tarballs are reproducible for a fixed commit under the verified Python/Git
builders. Container images are **not claimed byte-reproducible**: the worker uses
Debian apt without a snapshot, and the hosted runner image receives updates. Images
are local test inputs and are not published. Before distributing one, capture its
OS/package inventory and resolve the vendor SDK and operating-system notice obligations
in [THIRD_PARTY.md](../THIRD_PARTY.md).

Dependency audits are a separate review input, not an automatic `npm audit fix`.
Record advisory IDs, affected locked versions, runtime/dev scope and exposure;
choose targeted fixes and rerun relevant checks. The five lockfiles audited clean on
September 30, 2026; re-audit before each release. Passing CI does not imply a clean
dependency audit.

The `container-operator` job runs `runtime/operator/restrictive-test.py`, which runs
`runtime/operator/test.sh` from a restrictive source export with fresh state and unique
image tags. It blocks host Node/npm/Python in PATH and exercises the demo,
worker/cached result, cancellation, recovery, backup/restore and restart. It uses
synthetic data only and participates in the required aggregate check.

## Restrictive source and operator boundaries

`python3 runtime/operator/restrictive-test.py` exports the current Git-visible
source into a private temporary directory with files at 0600, executables at 0700
and directories at 0700. It runs `runtime/operator/test.sh` with host Python/Node/npm
blocked for all product commands, then confirms source permissions were unchanged.
Python and Git are dependencies of this contributor harness only.

The suite builds all three images, exercises onboarding, worker execution and
cached results, backup/restore and persistence. Synthetic credential canaries check
the actual mounts of every operator role, including the live role without making
provider calls. Container assertions verify memory/PID limits and artifact parsing's
network isolation. Scoped image cleanup must reject active installations and retain
configuration/backups after teardown. Real PostgreSQL integration tests separately
reject changed migration digests, invalid ledger hashes, broken links and gaps.
