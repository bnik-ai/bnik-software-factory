# Architecture

The local profile has two explicit paths: a credential-free demonstration of the
validator/router pipeline, and an operator-driven live workflow. PostgreSQL stores
durable work, authorization and run/review receipts. GitHub holds Tasks, PRs,
reviews, CI results and the human merge. These paths share source packages but
must not be confused when evaluating what a demo proves.

The [container launcher](container-runtime.md) packages operator tools and the trusted
supervisor with Python and Node. Only the supervisor receives the Docker socket;
this remains full daemon authority. PostgreSQL needs no host port.

## Live operator workflow

```text
GitHub signed webhook
        |
        v
Authenticated intake --> PostgreSQL delivery + activation receipt
        |                              |
  observe ordinary events       explicit operator command
                                       |
                             recheck human + Task + head
                                       |
                             trusted supervisor container
                                  /           \
                    scoped source read    durable job/run lease
                                  \           /
                            disposable coding container
                                       |
                               patch + test receipts
                                       |
                        operator reviews and publishes PR
                                       |
                         explicit immutable Task/PR pairing
                                       |
                     native human review + current-head CI
                                       |
                          human performs squash merge
                                       |
                       runtime verifies merge + closes Task
```

Ordinary issue/comment events do not start paid work. The supervisor revalidates
an unchanged human activation, Task snapshot and default-branch head before
execution. A separately configured operator/publisher transfers reviewed output
to GitHub; the worker has no push or merge credential. The review profile checks
native protection, human approval and required CI, then verifies the actual human
merge before completing the paired Task. AI review is advisory and the legacy
ReviewAgent is not automatically wired into this local path.

The worker receives a bounded source snapshot and tools in a non-root, read-only
Docker container with temporary workspace and no direct network. A separate proxy
holds the provider API key and allows only bounded requests to the configured
provider/model. Host source, Docker socket, GitHub keys and database credentials
are absent from the worker. The host/Docker daemon and supervisor are trusted;
containers share the kernel. See [worker boundaries](isolated-worker.md).

## Credential-free control-plane demo

```text
Synthetic signed Task -> Raw event queue -> Validator + audit
                                                  |
                                           Verdict queue
                                                  |
                                           Orchestrator
                                                  |
                                           BuildAgent queue
                                                  |
                                     Fixture completion receipt
```

The demo uses fixture GitHub reads and a receipt-only worker. It exercises parser,
finite-state-machine policy, audit and routing without a real model, PR or human
approval. It is not the live execution path above. Azure and the broader planning/
operations handlers are experimental adapters, not deployed components of this
local profile.

## Components and durable boundaries

| Component | Responsibility |
| --- | --- |
| GitHub App surfaces | Signed intake, installation/repository identity and scoped reads |
| Validator | Record FSM/assertions and hash-chained audit decisions |
| Orchestrator | Route accepted verdicts to role jobs in the fixture/legacy pipeline |
| Local runtime | PostgreSQL queues, migrations, activation, run/merge evidence and operational CLIs |
| Native supervisor | Revalidate authorization, claim/fence a job, fetch source, supervise containers and settle receipts |
| Agent adapter/worker | Execute bounded coding work and capture patch, command and SDK accounting results |
| Human/operator | Define and activate work, review/publish output, review changes and merge |

Intake and its receipt commit together. In the demo pipeline, validator audit,
verdict, outgoing work and acknowledgement share a transaction; routing and agent
job insertion also settle atomically. Renewable leases and fencing prevent stale
owners from committing database effects. Each coding job has one execution attempt;
failed paid work requires a fresh human activation. These rules do not make external
provider or GitHub effects exactly once. Recovery must preserve uncertain outcomes.

Run records retain source/published/reviewed heads, effective limits, tests and
estimated or unavailable accounting. Hash chaining can reveal ledger alteration
but is not an external immutable anchor. Content pruning preserves deduplication
and audit identities and does not erase remote or backup copies. See
[run controls](run-controls.md) and [recovery](recovery.md).

## Records and source map

### Records

#### Primitives

| Primitive | Purpose |
| --- | --- |
| **Issue** | Work item with a kind marker |
| **Pull Request** | Proposed implementation |
| **Review** | Feedback and approval record |
| **Release** | Versioned delivery, experimental |
| **Deployment** | Environment delivery, experimental |

#### Issue kinds

| Kind | Purpose |
| --- | --- |
| **Goal** | Desired outcome, experimental |
| **Spec** | Acceptance criteria, experimental |
| **Design** | Implementation design, experimental |
| **Task** | Bounded work |
| **Incident** | Operational event, experimental |
| **Decision** | Recorded rationale, experimental |


Tasks are bounded issue records with explicit definitions and activation hashes.
PRs propose implementations; native Reviews and CI authorize a specific current
head under the configured human policy. Goal, Spec, Design, Incident, Decision,
Release and Deployment records exist in source but are outside the supported
Task workflow unless [SUPPORT.md](../SUPPORT.md) explicitly says otherwise.

See [generated source diagrams](architecture-diagrams.md) for broader source-derived
counts, [source authority](sources-of-truth.md) for implementation locations, and
[Azure adapter vocabulary](design/azure-adapter.md) for experimental roles. Generated
source diagrams describe code structure, not live wiring or support commitments.
