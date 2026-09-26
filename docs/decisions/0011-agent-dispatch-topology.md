# Design summary 0011: Dispatch by role

The validator publishes verdict-bearing messages. The orchestrator drops non-accept verdicts and enqueues accepted work by agent role. The Azure adapter uses per-role queues; equivalent local durability is still being integrated.

This is a generic summary of the retained design, not a deployment record or a
claim of release readiness. See [source authority](../sources-of-truth.md).
