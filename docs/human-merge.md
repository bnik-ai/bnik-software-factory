# Human review and merge

For Docker-only host operation, use [the container launcher](container-runtime.md).
The low-level commands below describe the optional native profile; the mapping
covers configuration, secret paths, worker/recovery commands and sample artifacts.
Do not mix its `runtime/` state with the launcher's `.factory/` state.

The supported local profile never calls a merge or deployment API. AI review is
advisory. A native GitHub review by a configured human and successful required CI
on the PR's current head are mandatory. That human performs the squash merge in
GitHub. The runtime then verifies the merge and completes its paired Task.

This is an optional, conservative review profile for an organization repository
with enforceable branch protection. It does not publish worker output as PRs itself; publication comes from the explicit operator
steps in the [end-to-end walkthrough](end-to-end-pilot.md) or, when enabled, from the [bounded-autonomy controller](autonomy-operations.md). Historical Azure Ops/Review handlers
are experimental and are not connected to the local live runtime.

## Repository prerequisites

Use a private organization repository on GitHub Team or Enterprise, or another
organization plan where the following controls are available for that repository.
An unavailable protection API is a failed prerequisite. Do not make a private
repository public or turn off protection to get a demonstration to pass. See
[GitHub's protected-branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

Configure the default branch with all of these controls:

- Exactly one required approving review, required CODEOWNER review, dismiss stale
  approvals, and approval of the most recent reviewable push.
- Enforce the protection for administrators; no PR bypass users, teams, or Apps.
- Strict required status checks (branch up to date), with each check bound to its
  expected GitHub App ID. Every required check must appear in the local policy.
- Restrict branch pushes to the configured human mergers only. No App or team
  belongs in the restriction list. Disable force pushes and branch deletion.
- Enable squash merging only. Disable auto-merge, merge commits, and rebase merge.

The automatic-merge profile of [bounded autonomy](autonomy-operations.md#merging) changes
exactly two of these: code-owner review is not required by GitHub (the autonomy policy
decides who may approve critical work), and the merger App is the one App in the push
restriction. Everything else above stays, and the runtime verifies it before every merge.
The merger App's own approving review satisfies the reviewer requirement only for a merge the
App itself made; a human merge under this profile still needs a listed reviewer's approval.
Under this profile GitHub itself no longer enforces code-owner review for human merges: the
merger dismisses its approval whenever its attempt does not merge, and reconciliation parks a
human merge that rested on it, so that check moves from preventive (GitHub) to detective
(the gate).

Commit `.github/CODEOWNERS` to the base branch with a single global rule:

```text
* @example-maintainer
```

All owners must be configured individual humans with current write or admin
access. Multiple humans on this one rule are supported; teams, additional
patterns, and per-directory overrides are not. Changes to this file in a tracked
PR park the gate; change review governance through a separate human maintenance
process and update the local policy together. A bot's native approval, an
`approved` label, and a structural agent comment cannot fulfill human ownership.

CI must be non-deploying. Use the check name and App ID actually returned by
GitHub's check-runs API for your workflow; do not copy the example numeric ID.
Only a completed `success` from that producer on the exact head counts. A newer
failed or pending attempt supersedes an older success. Humans must review changes
to CI definitions and tests themselves; an App ID identifies a producer, not the
quality of its tests. Additional rulesets may impose stricter requirements.

## App and local configuration

Start with [GitHub installation](github-installation.md). For this profile, grant
the single-repository App **Administration: read** and **Issues: write**, in
addition to Contents, Pull requests, Checks, Commit statuses, and Metadata at
**read**. Keep the same seven event subscriptions. No Contents, Pull requests,
Checks, Workflows, or Deployments write permission is accepted. Preflight rejects
extra grants and installations on more than one repository.

The native worker still receives no GitHub write credential. Reads mint scoped
read tokens, and Task reconciliation mints only Issues write plus Metadata read.
Each token is revoked after use. App administration **read** allows inspection of
protection, not modification of it.

Copy `runtime/merge-policy.example.json` to the ignored
`runtime/merge-policy/merge-policy.json` (with `sfac`: `.factory/merge-policy/merge-policy.json`)
and replace its branch, human logins, check names, and check App IDs. This is trusted
operator configuration; never load policy from a PR. The `merge-policy/` directory holds
this file alone: the review services mount the whole directory read-only. The control
plane reads the file again before every look of the merge gate, so any edit, including one
that replaces the file (an editor's atomic save, `sed -i`, `mv`), takes effect at the next
look without a restart, and every observation records the digest of the policy it used. A
missing file (`merge_policy_file_missing`, for example during an editor's non-atomic save) or
one that cannot be read (`merge_policy_unreadable`) parks the look, and the next scan looks
again; an invalid one parks with its validation reason (`merge_policy_invalid`,
`merge_policy_merger_must_match_FACTORY_MERGER_settings`, …). A policy left at the retired
location `runtime/merge-policy.json` (or `.factory/merge-policy.json`), or a symlink in place of
the file, is refused by every command until it is moved into the directory as a regular file. Then start the control plane:

```sh
docker compose --env-file runtime/.env -f runtime/compose.yaml -f runtime/compose.live.yaml -f runtime/compose.worker.yaml -f runtime/compose.review.yaml up -d --build --wait
python3 runtime/worker.py github-check
```

Run database migrations during upgrades as described in the local-runtime guide.
The worker override exposes PostgreSQL on loopback for the trusted native CLI.
The new pairing, observations and merge receipts have insert-only runtime grants;
status and dependency snapshots can be updated. Include all of them in backups.
Omitting the review policy leaves the intake-only profile active and does not
reconcile PRs. Neither profile automatically activates paid work.

## Pair, observe, review, merge

Create the PR through your trusted publication process. Put exactly one
`task-ref: TASK_NODE_ID` line in its body and exactly one `pr-ref: PR_NODE_ID` line
in the Task body. Use GitHub node IDs, not numeric issue numbers, for these links.
Do not add GitHub auto-closing keywords (`Closes #…`) to the PR. The paired Task
must be open, unlocked, `kind:task`, and have exactly one `status:ready` or
`status:in_review` label.

Review the actual pairing and head, then register it locally:

```sh
python3 runtime/worker.py track-pr TASK_NUMBER PR_NUMBER FULL_HEAD_SHA
python3 runtime/worker.py review-scan
python3 runtime/worker.py review-status
```

Pairing stores immutable repository, installation, PR, and Task identities plus
the Task title/body hash. Changing the Task or its backlink parks reconciliation;
the CLI cannot silently replace a registered pair. Head commits may advance, but
each advance needs fresh checks and human review. The human flow's `track-pr` refuses
fork PRs; a pull request that opt-in bounded autonomy publishes from its configured fork
(`--publication fork`) is accepted by the autonomy commands and by the control plane's
scan. Register and observe the open PR before merging it.

A webhook delivery that can change what the gate observes about a tracked, unreconciled
pull request queues its look at once, parked or not: a pull-request event; a review by a
configured reviewer (or, under the automatic profile, the merger App), a dismissal, a change
request by anyone (any user's latest change request parks it), or any review while it is parked
on a change request; an edit, label, lock or state change of its Task; a completed check run or
suite on its head (the gate reads check runs, not commit statuses). Comments, statuses and other
reviews queue nothing. The reviewer list is read from the current policy file. The control plane also scans tracked
PRs once a minute, including after a restart, as the fallback for missed deliveries:
a scan queues one look per never-evaluated or `awaiting_human_merge` pull request, and
looks at a parked one again after 15 minutes, so a repository with many permanently
parked pull requests does not starve fresh ones. A pull request normally has at most one
look queued, and a delivery during a running look queues the next. A pull request parked by a retryable GitHub failure
(server error, rate limit, connection) keeps the one-minute cadence. A scan queues
at most 100 pull requests, stalest first; the rest follow on the next scans.
`review-scan` queues a look at every tracked, unreconciled pull request at once,
parked ones included, in the same durable queue; `review-status` reports
`parked`, `awaiting_human_merge`, or `reconciled`, its reason, head and observation
time. The status is a recorded observation, not a continuously valid permission
to merge. GitHub's native branch protections are the merge-time enforcement.
API failures and missing/failed/stale evidence park visibly and are reconsidered
on the next scan that includes them. Verify protection errors rather than
weakening policy. Start with one active pilot PR; API quotas bound larger queues.

An eligible observation waits for the human to merge. After merge, the runtime
requires the same head, policy and protection, a preceding base observation, a
single-parent squash commit onto that base, a configured human merger, and native
approval/check timestamps no later than the merge. An unobserved merge, changed
base, bot merge, or unreadable surface remains parked for human investigation.
It does not try to reverse an external merge. Administrators of GitHub or the
runtime host remain trusted: these reads do not reconstruct historical protection
changes or provide an atomic lock across GitHub and PostgreSQL.

## Task and dependency reconciliation

After verification, the runtime appends a merge receipt, adds `status:done`, removes
the previous allowed status, and closes only the paired Task. It rechecks the Task
before each write. A crash after a partial label update is safe to retry; unrelated
labels and the body remain intact. This is idempotent recovery, not an exactly-once
transaction across GitHub and the database. A concurrent human edit between a read
and write cannot be locked by the GitHub Issues API and requires investigation if
the subsequent verification detects a changed Task.

After completion, the runtime refreshes a read-only dependency snapshot from up to
499 Tasks in this repository. It reuses the existing `blocked-by:` and issue-form
parser. Node IDs that resolve to a Task in exactly `done` or `abandoned` clear a
dependency; missing, self, ambiguous, nonterminal or unsupported cross-repository
references remain blocked. A listing at the bound or an API failure parks the
refresh instead of assuming the missing records are done. Snapshot readiness is
evidence only: dependents stay open and are not promoted or activated. Inspect
the snapshot in the reconciled PR's `evidence.dependencies` output. Larger and
cross-repository dependency graphs are outside this profile.
