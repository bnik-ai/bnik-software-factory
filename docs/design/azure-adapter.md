# Experimental Azure adapter vocabulary

These are logical role names used by source diagrams, not deployed resource IDs.
No subscription, region, tenant, network, or environment is configured by this
file. Azure deployment automation is outside this candidate's supported path.

| Role | Source vocabulary |
| --- | --- |
| HTTP intake | `ca-webhook` |
| Agent API | `ca-agent` |
| Administration | `ca-admin` |
| Optional ingress | `ca-cf-tunnel` |
| Experimental infrastructure endpoint | `ca-terraform` |
| Validator consumer | `caj-validator` |
| Orchestrator consumer | `caj-orchestrator` |
| Experimental infrastructure worker | `caj-tf-apply` |
| Validated intake queue | `validator-events` |
| Verdict dispatch queue | `agent-runs-dispatch` |

Per-role agent consumers use `agent-runs-{role}` queues. Deployment overlays supply
concrete resources and least-privilege identities; the generic schema grants no
permissions to a preselected cloud identity.
