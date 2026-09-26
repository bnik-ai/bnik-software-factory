# review-agent design

ReviewAgent reads PR changes and produces structured feedback. Trusted bot markers distinguish its own work from untrusted issue text. Feedback and resynchronization logic are covered by source tests; agent review cannot replace required CI or human approval.

See the implementations and tests under `services/` and the
[source map](../sources-of-truth.md). Broader runtime integration remains in development.
