# Sources of truth

| Concern | Authoritative source |
| --- | --- |
| Event intake and GitHub credentials | `services/github-app/src` |
| Record policy and audit schema | `services/validator/src` and `services/validator/migrations` |
| Local queue schema, leases and transactional handoffs | `services/local-runtime` |
| Local launcher and operational instructions | `sfac` (with `runtime/operator/` and `runtime/compose*.yaml` as inputs), [container runtime](container-runtime.md) and [local runtime](local-runtime.md) |
| Autonomy policy, risk rules, evidence receipts, ledger, controller, sandboxes and publisher (opt-in) | `services/local-runtime/src/autonomy`, `runtime/autonomy.py`, [autonomy policy](autonomy-policy.md) and [autonomy operations](autonomy-operations.md) |
| Agent-quality qualification protocol and corpus | `evals/` |
| Isolated execution and credential boundary | `services/local-runtime/src/worker`, `runtime/worker` and [worker guide](isolated-worker.md) |
| Dispatch decisions | `services/orchestrator/src/routingTable.ts` |
| Agent contracts and implementation | `services/agents/src/types.ts` and `services/agents/src/agents` |
| Dependency versions | Each service's `package-lock.json` |
| Generated architecture drawing | `scripts/gen-architecture-diagrams.mjs` and its model |
| Current release support boundary | [SUPPORT.md](../SUPPORT.md) |
| Upstream and deployment integration | [Upstream policy](upstream.md) |

GitHub issue/PR records describe requested and reviewed work; source and tests
establish implementation behavior. Documentation cannot turn an untested runtime
path into a supported feature. Run source checks before relying on changes.
Historical design summaries retain stable filenames for source comments, but do
not imply a currently configured repository or deployment.
