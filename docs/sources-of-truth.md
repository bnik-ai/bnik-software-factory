# Sources of truth

| Concern | Authoritative source |
| --- | --- |
| Event intake and GitHub credentials | `services/github-app/src` |
| Record policy and audit schema | `services/validator/src` and `services/validator/migrations` |
| Local queue schema, leases and transactional handoffs | `services/local-runtime` |
| Local launcher and operational instructions | `runtime/compose.yaml` and [local runtime](local-runtime.md) |
| Dispatch decisions | `services/orchestrator/src/routingTable.ts` |
| Agent contracts and implementation | `services/agents/src/types.ts` and `services/agents/src/agents` |
| Dependency versions | Each service's `package-lock.json` |
| Generated architecture drawing | `scripts/gen-architecture-diagrams.mjs` and its model |
| Current candidate support boundary | [README](../README.md) |
| Upstream and deployment integration | [Upstream policy](upstream.md) |

GitHub issue/PR records describe requested and reviewed work; source and tests
establish implementation behavior. Documentation cannot turn an untested runtime
path into a supported feature. Run source checks before relying on changes.
Historical design summaries retain stable filenames for source comments, but do
not imply a currently configured repository or deployment.
