# Run the synthetic Task-to-merge pilot

This walkthrough connects the supported local runtime to a private disposable
GitHub repository and your own Anthropic account. It requires a real model call,
a human request-changes/revision cycle, successful required CI, a human squash
merge, and verified Task reconciliation. A fixture run does not satisfy it.

The sample is [a dependency-free invoice exercise](../examples/invoice/README.md).
Only synthetic code is sent to the model. The runtime remains deliberately
operator-driven: activation, execution and publication are separate actions.
No command below grants an agent permission to approve or merge its own work.

## Prepare identities and a clean environment

Use Node 24.21.0, Python 3 and Docker/Compose. Linux x64 is the contributor CI
configuration; Linux arm64 containers on macOS Docker Desktop are also exercised.
Pin the factory commit and record the worker/control-plane image IDs. Install all
five service lockfiles (the native supervisor imports code across packages):

```sh
for service in agents github-app orchestrator validator local-runtime; do
  npm ci --prefix "services/$service" --ignore-scripts --no-audit --no-fund
done
```

Copy `examples/invoice` into a new private repository **without factory history**.
The pilot needs only `invoice.mjs`, `invoice.test.mjs`, `README.md`, and
`.github/workflows/ci.yml`. Add a global `.github/CODEOWNERS` rule with your human
login. Pin this initial sample commit; leave the default branch unchanged through
both model runs. Run the baseline checks and record the actual `invoice` check's
GitHub App ID.

Configure the native protections in [human merge](human-merge.md), using `invoice`
as the required check and its verified App ID. The CI identity must be able to read
source but must have no deployment or model credential. Restrict base pushes to
the human merger. Do not weaken protection or change visibility when an API fails.

Create a selected-repository App with the exact review-profile grants documented
in that guide. Configure its HTTPS webhook, runtime and trusted merge policy via
[GitHub installation](github-installation.md). Use a fresh Compose project/database
for this pilot and preserve unrelated local configuration. Separately configure a
publisher identity restricted to this repository, with Contents and Pull requests
write, Metadata read, and **no workflow, administration or merge bypass grants**.
Keep that credential outside the model, worker, source and result directories.

The human reviewer must be distinct from the PR author. A dedicated bot publisher
allows the repository owner to perform the native human review. Neither the runtime
review App nor worker receives publication authority. Run `github-check`, confirm
readiness and an actual signed GitHub webhook delivery before activating work.

## First bounded model run

Create an open Task with `kind:task` and `status:proposed`. Put the contents of
`examples/invoice/task.initial.json` in one fenced `factory-task` block. Replace
the deliberately invalid model placeholder with the exact model ID available to
your account. Review the prompt, permitted files, test command and limits.

```sh
python3 runtime/worker.py prepare-task TASK_NUMBER FULL_SAMPLE_COMMIT /tmp/invoice-review-1
```

As the configured human operator, inspect `task.json` and post the printed
`/factory activate …` command yourself as a new issue comment. Observe its actual
webhook delivery and durable activation UUID. Set manual execution and install your
API key as described in the installation guide; never paste it into the Task or PR.

```sh
python3 runtime/worker.py activations
python3 runtime/worker.py run-activation ACTIVATION_UUID /tmp/invoice-result-1
python3 runtime/worker.py status
```

Do not silently retry a failed paid run or substitute another model. Inspect its
failure and obtain a fresh activation for intentional new work. Record job/run IDs,
source/archive/patch hashes, model subtype, reported turns and `costUsd`. A null
cost is unknown, not zero. SDK cost estimates are not provider billing receipts.
The turn/deadline/request caps are not an exact dollar cap.

## Review and publish the exact output

Review `result.json`, each command receipt and `changes.patch`. Prepare the two
permitted files without executing model-generated code on the host:

```sh
python3 examples/invoice/prepare-result.py \
  --repository /absolute/path/to/sample-checkout \
  --receipt /tmp/invoice-result-1/result.json \
  --output /tmp/invoice-publication-1
```

The helper validates receipt/patch hashes, passing live outcome/command fields,
source commit, regular file modes and the two-file scope. It writes a complete
candidate pair and `publication-plan.json`. Local receipts are not signed proof;
review them together with the durable database record. The helper cannot publish,
execute tests, approve a review or merge anything.

Using the separately configured trusted publisher, upload only those reviewed
`invoice.mjs` and `invoice.test.mjs` bytes to a new branch based on the pinned sample
commit. Create a PR with its Task node-ID reference (`task-ref: …`), exact runtime
run/hash evidence, test receipts, model identity and limitations. Do not include
GitHub auto-closing keywords. Record the PR node ID/head and confirm required CI
runs against that exact head. The public runtime does not automate this publication
step; report it as manual intervention.

## Request changes and execute a revision

The human reviews the actual first head and submits a native **Request changes**
review. For this exercise, request input validation and integer overflow handling,
with tests. The first Task intentionally assumed valid inputs; this is a scope
refinement after review, not a manufactured claim that the initial CI failed.
Record the review ID, author, body and reviewed head. Confirm merge remains blocked.

Before immutable pairing, update the same Task definition using
`task.revision.json`, customized to the actual review. Keep `status:proposed` and
pin the unchanged default branch. Obtain a **new** human activation using a new
review directory/comment; changed Task text invalidates the old approval.
Run it into `/tmp/invoice-result-2` and prepare `/tmp/invoice-publication-2`.
The runtime currently executes default-branch snapshots: the revision prompt must
state the complete requested result, not assume the prior PR files are present.

Publish the complete revised pair on the same PR branch as a new commit whose
parent is its current head. Verify the expected previous head and fast-forward the
branch; never force-push or move the base branch. Preserve governance and workflow
files. Record old/new heads and refreshed CI. Refresh the PR description around
the final output and link the real request-changes review and revised run evidence.

## Pair, obtain human approval, and reconcile

After the last model run, freeze the Task title/body, add exactly one
`pr-ref: PR_NODE_ID` backlink and replace its status with `status:in_review`.
Keep the reciprocal Task reference in the PR body. Register only now: the merge
pair binds the Task content immutably, and later Task edits would park it.

```sh
python3 runtime/worker.py track-pr TASK_NUMBER PR_NUMBER FULL_REVISED_HEAD
python3 runtime/worker.py review-scan
python3 runtime/worker.py review-status
```

Wait for successful current-head CI and a fresh native human approval. Record the
new review ID/head. Scan while the PR is open and confirm `awaiting_human_merge`
before the human personally squash-merges it in GitHub. The assistant must not
perform a human review or merge to manufacture this evidence.

After GitHub delivers the merge event, scan and verify `human_merge_reconciled`,
exactly one immutable merge receipt, and the paired Task closed with `status:done`.
Record merge commit/parent, merger, timing, policy/protection hashes and final Task
state. Do not manually close the Task to make the walkthrough appear successful.

## Recovery, evidence and cleanup

Capture redacted evidence before cleanup. Stop and restart this pilot's Compose
services without deleting the database volume. Recheck readiness, worker state,
merge receipt and Task state. Confirm restart does not invoke another model, create
a second receipt or change unrelated Tasks. Preserve a tested database backup or
retain the offline pilot volume according to the local retention policy.

The annotated transcript should record factory/sample/image commits; Task and
activation identities; both run IDs, costs or unknowns and command receipts; both
PR heads, reviews and CI checks; human merge; reconciliation; restart; every manual
intervention; and the limits of what was verified. Keep private account/repository
identities and credentials out of the public factory repository.

Stop the pilot stack and tunnel, revoke temporary installation tokens, remove only
the dedicated test Apps/keys, and retain the sample repository privately (archive
it after completion). Preserve unrelated state. No product release, image/package
publication, production deployment or public announcement is part of this pilot.
