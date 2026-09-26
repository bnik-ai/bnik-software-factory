# System overview

The factory separates work records, tools, agents, event routing and policy checks.
GitHub holds the work; the validator checks transitions; the orchestrator dispatches
accepted events; agents propose changes through tools. Consult the
[architecture](architecture.md) and [source map](sources-of-truth.md).

The initial product boundary is one repository with human-controlled merge.
Additional planning, operational and deployment handlers remain experimental.
