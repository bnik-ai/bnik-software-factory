# Trusted autonomy policy

**Status: contract and decision library only.** No runtime path consumes it yet.
The supported workflow remains human-gated: explicit activation, operator
publication, native human review and human merge. Automatic execution,
publication and merge are planned work (see [roadmap](roadmap.md)); nothing in
this document enables them.

The policy decides, for one proposed consequential action, whether the factory
may proceed without a human. Routine work inside configured scope proceeds once
machine evidence passes. Critical, out-of-scope or uninspectable changes hold for
a human approval bound to that exact action. Missing, stale, malformed or
inconclusive evidence never counts as a pass.

Source: `services/local-runtime/src/autonomy/` (policy, classification, evidence,
decision, ledger) and migration `0008_autonomy_policy.sql`.

## Decision flow

```mermaid
flowchart TD
  P[Operator policy file on host] --> D{Policy decision}
  R[Controller request: action, task, base, tree, changes] --> D
  A[Acceptance receipt from trusted runner] --> D
  V[Review receipt from fresh-context reviewer] --> D
  G[Merge-gate observation from GitHub reads] --> D
  D -->|evidence missing, stale or inconclusive| B[blocked: hold]
  D -->|tests fail or important findings| F[repair_required: bounded new revision]
  D -->|critical, out of scope or uninspectable| H[approval_required: human approves exact action]
  D -->|routine and all evidence passes| OK[allow]
  H -->|valid approval for this action digest| OK
  OK --> L{Ledger admission}
  L -->|paused, revoked, expired, over budget or already used| X[refused]
  L -->|consumed once| E[act]
```

Precedence is `blocked` > `repair_required` > `approval_required` > `allow`.
A human approval never converts a failed test, an unresolved finding or missing
evidence into a pass.

## Policy file

The operator selects an absolute, canonical host path (no symlink anywhere in
it) in a directory that is not group- or world-writable. The file is opened
without following a final symlink and checked on the open handle: a regular
file, not group- or world-writable, at most 64 KiB. It is never read
from a PR branch, Task text, labels, worker output or model output. See
[`runtime/autonomy-policy.example.json`](../runtime/autonomy-policy.example.json).

| Field | Meaning |
| --- | --- |
| `revision` | Strictly increases on each activation; an older document cannot be replayed. |
| `mode` | `human_gated` (every action needs a human, today's behavior) or `bounded`. |
| `repository` | Exact name, numeric ID, installation ID and base branch. |
| `allowedPaths` | Path prefixes routine work may change; `.` means the whole repository. |
| `criticalPaths` | Extra `{path, category}` rules. They add to the built-ins and cannot remove them. |
| `execution` | Allowed models, and per-run turns, duration and budget (micro-USD); per-scope budget and per-Task attempt ceilings. |
| `changeLimits` | Largest change that can be routine; larger changes need a human. |
| `mergeEffect` | `deployment` holds every merge for a human. There is no `unknown`. |
| `verification` | Trust roots: acceptance suite, harness and runner image digests, reviewer configuration digest, eval protocol digest, in-repository protected paths and receipt lifetime. |
| `approvers` | Numeric GitHub user IDs allowed to approve holds. |
| `dependencies` | Optional trusted dependency verification: pluggable scanner adapter and digest-pinned image, scanner database maximum age, hold severity, SPDX license allowlist, and whether new dependencies, major upgrades or downgrades may be routine. `null` keeps every dependency change critical. |

Limits cannot exceed the worker's own ceilings (60 turns, 30 minutes, USD 100 per
run, 20 runs per Task). Cost figures are SDK estimates, not provider bills or hard
spending caps.

### Changing the policy

The **active** policy assesses its replacement. Activation computes every
weakening (wider paths, removed critical or protected paths, added models or
approvers, raised limits, `human_gated` to `bounded`, `deployment` to `none`,
enabling or loosening dependency verification, and any trust-root change) and
refuses unless the operator acknowledges exactly that list. A proposed policy cannot vouch for itself. Existing installations have no
active policy and keep today's behavior; enabling `bounded` is an explicit,
acknowledged activation. Activating a new policy invalidates pending decisions and
every scope granted under the old one; pause state carries over.

## Risk classification

Classification runs on a complete change manifest produced by the trusted
collector from the verified base tree and the frozen candidate tree: every file's
status, both paths, both modes and full text content. Worker-reported diffs are
not used. An incomplete manifest, a traversal path, a `.git` segment or a
duplicate path is refused. Rules are case-insensitive; renames are judged on both
the old and new path.

**Built-in critical paths** (always on): CI and repository automation (including
hosted CI configurations, merge bots, dependency bots and composite actions),
CODEOWNERS, developer hooks, test-runner and build-transform configuration
(including `conftest.py`), factory configuration, `SECURITY.md`, data dependency
manifests and lockfiles (routine only with a passing dependency receipt, below),
executable manifests such as `setup.py`, `Gemfile` and `build.gradle`, registry,
toolchain, wrapper, patch and install-hook configuration, and vendored third-party
code (all always critical), auth/login/session/permission modules
(including camelCase names such as `requireAuth.js`), secret-bearing files,
deployment and container definitions, infrastructure code, migrations, schema
tools and SQL, license and notice files, plus configured `criticalPaths` and
`verification.protectedPaths`.

**Content tripwires** run on an ordered line diff, so moved and reordered lines
count as changes and unchanged lines elsewhere do not escalate. Authorization
rules also look at the unchanged line on each side of a change, so a guard that
code was moved around is noticed. Rules cover auth and crypto code (including
removed checks), code-execution calls, disabled TLS verification, hidden
text-direction controls, recognizable secrets, credential handling, permission
changes, deployment commands, infrastructure resources, destructive SQL, ORM and
filesystem operations, removed license notices, publication commands, test
skipping or focusing (in test files) and failure masking. Deployment and
infrastructure rules do not apply to prose files.

**Test weakening:** deleting a runnable test, renaming it so a runner no longer
picks it up (for example `.test.js.disabled`), or a net reduction in assertions
within a test file is critical. Adding or relocating tests is routine.

**Bounded cost:** file and size limits are applied before any pattern runs; lines
longer than 4,000 characters are not pattern-matched and need a human. Diff work
has one budget for the whole manifest; very large or very different files are
treated as entirely changed rather than diffed, so nothing is skipped.

**Uninspectable:** binary content, symlinks, submodules, non-ASCII paths,
over-long lines, empty changes and changes above `changeLimits` need a human.
File mode changes are critical as permission changes; they hold the merge, not
publication.

These rules are best-effort tripwires, not proofs, and a determined author can
evade pattern matching. The deterministic rules and the separate
reviewer must **both** find a change routine; either one can escalate it, and
neither can downgrade the other. Task text, labels and `intentKind` never lower
risk; `bugfix` only adds the reproducer requirement.

Publication is itself an external effect. Pushing to the base repository runs
its automation and installs its dependencies with that repository's CI
privileges, and anything pushed is disclosed. CI and hook definitions, test-runner
configuration, dependency manifests (unless a passing dependency receipt covers
them) and configuration, new code-execution calls, recognizable secret material,
anything that could not be inspected (and so could hide those),
and a reviewer's escalation of secrets, security or governance risk therefore
need approval **before publish**. This hold is decided on the full set of
reasons, before the reason list is truncated for display. Other critical changes
may be published for review, but their merge holds.

**Residual exposure:** published code, including ordinary tests, executes in the
repository's CI. If that CI can read secrets, agent-written code can reach them;
no content rule can prove otherwise. The planned publisher must publish where CI
has no secrets (for example, pull requests from a fork, which GitHub runs without
repository secrets) or the repository must provide secretless CI for factory
branches. Until then automatic publication is not safe for repositories whose
pull-request CI holds secrets.

## Evidence receipts

Receipts are written by trusted factory code from observed facts: exit statuses
the trusted runner collected, a reviewer's structured output parsed by the
supervisor, and GitHub API reads. Worker output, test logs, PR text and labels are
data inside receipts, never their authors. Unknown fields are refused, including in
receipts for checks the policy has not enabled.

| Receipt | Bound to | Passes only when |
| --- | --- | --- |
| Acceptance | repository, Task, base, tested tree, change digest; suite, harness and runner-image digests | Fresh; `passed` with a non-empty suite, no failures or skips; tests did not modify candidate source; bug fixes have a reproducer that fails on base and passes on the candidate. |
| Review | same subject, intent digest, reviewer configuration digest | Fresh-context, `complete`, no limitations, risk consistent with categories, no high or medium findings. Low findings are nits and never interrupt. |
| Merge gate | repository, base branch, PR head, head tree, base | Observed within 5 minutes; PR open; head tree equals the tested tree; base unchanged; protection verified; required checks passed; no human change request. |
| Approval | action digest (policy, Task, base, head, tree, changes, limits) | From a configured human GitHub user for that exact action. A new head, base, tree or policy needs a new approval. |
| Dependency | same subject; scanner adapter and image from the policy; the manifest paths it covered | Fresh; scanner database within its maximum age at scan time; `complete`; lockfiles reproduced from the manifests; no manifest field outside dependency specifications changed; the set of packages whose install scripts run is unchanged; every added or upgraded package comes from a registry; no new dependency, major upgrade or downgrade unless the policy allows it; every added or upgraded license in the allowlist; no finding at or above `holdSeverity` and none of unknown severity. Passing makes `dependency_manifest` routine for exactly the listed paths; each failed check holds for a human instead; `unsupported` holds; `error`, `timeout`, a stale database, an inconsistent package story or omitted findings at the threshold block. |

A human change request blocks any PR, routine or not. Failed required checks
send the change to repair.

### Protected acceptance trust root

The protected suite and harness are content-addressed bundles pinned by digest
in the policy (`contentTreeDigest` over path, mode and SHA-256 of each file). The
trusted runner mounts them read-only into a fresh verification sandbox with the
frozen candidate tree; it does not reuse the author's processes, configuration or
installed dependencies, and it treats test logs as untrusted data. An in-repository
copy listed in `protectedPaths` is governance-critical to change, and merging such
a change does not update the pinned bundle: only an acknowledged policy activation
can.

### Reviewer permissions

The reviewer receives the approved intent, pinned source, the actual diff and
trusted test receipts. It does not receive the author's conversation or
self-assessment, and it has no authoring, policy, publication or merge authority
or credentials. Optional execution runs in a separate restricted sandbox. Fresh
context reduces shared assumptions; it is not proof of independence or
correctness. It is distinct from regression retesting (which may use prior
findings) and from outside-human onboarding.

### Dependency verification

A clean vulnerability scan is not proof that a dependency change is safe: scanners
see known versions, not a lockfile whose download URL or integrity hash was
altered, a brand-new malicious package, or an install script. The receipt
therefore combines deterministic checks with the scanner, and both must pass:

| Check | Routine when | Otherwise |
| --- | --- | --- |
| Coverage | The receipt lists exactly which manifest and lockfile paths it re-resolved; only those become routine, and a listed path outside the change blocks | uncovered paths stay critical |
| Reproduction | The committed lockfiles are byte-identical to a clean re-resolution of the manifests in a fresh sandbox with install scripts disabled | `lockfile_not_reproducible` holds |
| Manifest fields | Nothing outside dependency version specifications changed: no `scripts`, `overrides`, `resolutions`, `replace`, `workspaces`, `patchedDependencies`, `onlyBuiltDependencies` or embedded tool configuration | holds per field |
| Install scripts | The set of packages whose install-time scripts run is the same before and after | holds |
| Source | Every added or upgraded package resolves from a registry, not git, a URL, a path, a link or a workspace | holds per package |
| Shape | No new dependency, major upgrade or downgrade unless the policy allows them. The runner's `major` flag may add a break the digits do not show (it is ecosystem-aware) but may not deny one they do, including 0.x minor bumps; its `direction` must agree with the numbers; a resolved registry version starts with a number; one package has one story | holds per package; disagreement blocks |
| Licenses | Every added or upgraded package carries an allowlisted SPDX identifier | holds per package |
| Scanner | No finding at or above `holdSeverity`; a finding of unknown severity counts as at the threshold. The runner may omit findings below a stated severity to bound the list, but never at or above the threshold | holds per finding; omission at the threshold blocks |
| Scanner health | Adapter and image match the policy; the database was no older than `databaseMaxAgeMs` at scan time; status `complete` | `error`, `timeout` or stale database blocks; `unsupported` holds |

Never made routine by a receipt: executable manifests (`setup.py`, `Gemfile`,
`*.gemspec`, `build.gradle`, `mix.exs`, MSBuild project files and others that run
at install or build time); registry, mirror and install-hook configuration
(`.npmrc`, `.yarnrc`, `.pnpmfile.cjs`, `.cargo/`, `nuget.config`, `.gitmodules`);
toolchain and wrapper pins (`.tool-versions`, `.node-version`, `rust-toolchain`,
`gradlew`, `mvnw`, wrapper properties); `patches/` and `.yarn/`; and vendored
third-party code (`vendor/`, `third_party/`, committed `node_modules/`). Content
rules also apply to all of these.

The scanner is a pluggable adapter chosen by name and digest-pinned image in the
policy; the trusted runner normalizes its output into the receipt. The default
adapter is decided when the runner is built (OSS-20). Verified against their
documentation on September 27, 2026: Trivy scans a filesystem or repository with
`--scanners vuln,license`, emits `--format json`, and runs offline with
`--skip-db-update`, `--skip-java-db-update`, `--cache-dir` and `--offline-scan`
after its databases (distributed as OCI images) are fetched; some lockfiles need the
installed tree for license detection, which the clean re-resolution provides.
OSV-Scanner runs offline with `--offline` and `--download-offline-databases`, but
its `--licenses` data comes from the deps.dev API. Commercial scanners (Checkmarx,
Snyk, Socket) can be configured as adapters by operators who hold accounts; none
is required, and contributor CI never runs a scanner with credentials.

## Ledger

`AutonomyLedger` stores policy activations, pause state, standing scopes,
recorded decisions, single-use admissions and budget reservations in PostgreSQL.

- **Scope:** an owner grant listing Tasks, models, a micro-USD budget, a per-Task
  run limit and an expiry of at most 30 days, all within the active policy.
- **Admission:** an `allow` decision is consumed at most once per controller
  request, and each human approval admits at most one action: single use is keyed
  on the approved action digest, so re-rendering the same approval does not reuse it. Consumption happens
  within 10 minutes, re-checks active policy, pause, scope revocation, expiry and
  membership, then reserves budget and counts the attempt. Admission, pause and
  revocation are serialized per repository: once a pause or revocation returns,
  nothing further is admitted.
- **Attempts:** the per-Task run limit counts across every scope of the
  repository, so overlapping scopes cannot multiply the policy ceiling.
- **Reservations:** `released` only when execution provably never started;
  `unknown` keeps the full reservation until reconciled; `settled` records the
  estimated cost, which may exceed the reservation.
- **Access:** migrations grant the internet-facing runtime role `SELECT` only and
  revoke anything else on every run. Writes need the trusted operator identity.
  Serialization uses a row lock on the repository's control row, which the
  read-only role cannot take, so it cannot stall pause, revocation or admission.

## Not provided

No bypass or exception mechanism; no automatic cross-provider substitution; no
exactly-once guarantee for external effects (ambiguous outcomes are reconciled,
not replayed); no protection against a compromised host or operator account.
The planned controller, publisher and merger must still collect these receipts,
use a guarded exact-head merge, and reconcile the actual merge afterwards.
