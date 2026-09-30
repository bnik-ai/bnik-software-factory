# Design summary 0004: Runtime adapters

Azure Service Bus and managed-identity adapters remain experimental implementation references. The supported local runtime implements the shared queue interfaces on PostgreSQL (`services/local-runtime/src/adapters.ts`) and refuses cloud configuration.

This is a generic summary of the retained design, not a deployment record or a
claim of release readiness. See [source authority](../sources-of-truth.md).
