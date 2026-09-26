# Design summary 0012: Review resynchronization

When a PR changes, review work must refer to its current head. Existing marker and resynchronization code lives in the agent and validator packages; the complete human merge boundary still requires end-to-end validation.

This is a generic summary of the retained design, not a deployment record or a
claim of release readiness. See [source authority](../sources-of-truth.md).
