# System overview

The factory separates work records, tools, agents, event routing and policy checks.
GitHub holds the work and the validator checks transitions. In the fixture/legacy
pipeline the orchestrator dispatches accepted events to agent roles; the live workflow
runs an isolated coding worker under a trusted supervisor. Consult the
[architecture](architecture.md) and [source map](sources-of-truth.md).

The default product boundary is one repository with human-controlled merge; automatic
merge of routine changes exists only as a further opt-in of bounded autonomy.
Additional planning, operational and deployment handlers remain experimental.
