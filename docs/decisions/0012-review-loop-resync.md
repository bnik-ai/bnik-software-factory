# Design summary 0012: Review resynchronization

When a PR changes, review work must refer to its current head. Existing marker and resynchronization code lives in the agent and validator packages. The automatic-merge profile's merge boundary passed live qualification on `2d4d48a` ([record](../../evals/qualification/2d4d48a.json)); the human-merge walkthrough's end-to-end run is a separate exercise.

This is a generic summary of the retained design, not a deployment record or a
claim of release readiness. See [source authority](../sources-of-truth.md).
