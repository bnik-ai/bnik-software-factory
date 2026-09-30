# BNIK Software Factory — Source Diagrams

<!-- GENERATED FILE — do not edit by hand.
     Source: scripts/gen-architecture-diagrams.mjs (+ .model.mjs).
     Regenerate: node scripts/gen-architecture-diagrams.mjs > docs/architecture-diagrams.md
     Check drift with the generator --check option. -->

> **Snapshot:** sources as of `content-derived` · sha256 `51c7318`
>
> Deterministically generated ASCII rendering of the architecture; the enumerable facts (agents, FSMs, queues, container apps, record kinds) are derived from their source-of-truth files and the layout is held in the generator's static model. Successive snapshots `diff` cleanly. Source of truth:
> - [`architecture.md`](architecture.md) — source responsibilities and record tables
> - [`design/azure-adapter.md`](design/azure-adapter.md) — experimental Azure role vocabulary
> - [`decisions/0011-agent-dispatch-topology.md`](decisions/0011-agent-dispatch-topology.md) — per-role Service Bus fan-out
>
> Regenerate with `node scripts/gen-architecture-diagrams.mjs > docs/architecture-diagrams.md`; compare evolution with `git log -p docs/architecture-diagrams.md`.

## Source flow

```text
GitHub webhook -> intake -> validator + audit -> verdict gate -> role dispatcher
                                                            -> agent -> GitHub PR
```

7 per-kind FSMs; 5 prims · 6 kinds.

## Agent roles present in source

```text
║   ┌──────┐ ┌────────┐ ┌─────────┐ ┌───────┐ ┌────────┐ ┌──────┐ ┌──────┐                          ║
║   │ Spec │ │ Design │ │ Planner │ │ Build │ │ Review │ │ Ops  │ │ SRE  │                          ║
║   └──────┘ └────────┘ └─────────┘ └───────┘ └────────┘ └──────┘ └──────┘                          ║
```

The role inventory includes experimental planning and operations handlers.
It does not imply all roles are deployed or supported. The supported workflow
uses the Build role with native human review, required CI and human merge; the
Review role is the experimental AI ReviewAgent, which the local runtime does not
invoke.

## Experimental Azure roles

The logical HTTP roles are ca-webhook, ca-agent, ca-admin, ca-cf-tunnel and
ca-terraform. Consumer roles include caj-validator, caj-orchestrator and
caj-tf-apply. validator-events carries intake; agent-runs-dispatch carries
verdicts. These names identify roles, not a configured cloud environment.
