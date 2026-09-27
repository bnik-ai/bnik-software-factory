# Operational rules

Treat agent output as a proposal. Scope credentials to the configured repository,
keep secrets out of prompts and logs, and require a human for merge and deployment.
Verify CI and approval against the current PR head. The local profile enforces these checks for explicitly paired Tasks/PRs; follow
[human merge](../human-merge.md) and the [operator walkthrough](../end-to-end-pilot.md).
Experimental entrypoints are not covered by that installation contract.

Keep environment configuration and database role grants in deployment overlays.
Use [the upstream policy](../upstream.md) to contribute reusable changes.
