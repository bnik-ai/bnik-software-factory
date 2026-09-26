# Operational rules

Treat agent output as a proposal. Scope credentials to the configured repository,
keep secrets out of prompts and logs, and require a human for merge and deployment.
Verify CI and approval against the current PR head. The candidate does not yet
provide a complete supported installation enforcing all these rules.

Keep environment configuration and database role grants in deployment overlays.
Use [the upstream policy](../upstream.md) to contribute reusable changes.
