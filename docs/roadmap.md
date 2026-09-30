# Scope and roadmap

The first alpha is a self-hosted, operator-driven workflow for one GitHub repository:
Task activation, isolated coding, explicit publication, human review and required
CI, human merge and verified Task completion. [SUPPORT.md](../SUPPORT.md) defines
its environment and limitations.

Before the first release: provision the release repository's reporting route and
branch protection, repeat the dependency audit on the release commit, complete independent setup/recovery exercises, verify
the exact source artifact and obtain the owner's publication decision.

Opt-in bounded autonomy (`FACTORY_EXECUTION=bounded`) automates routine execution,
publication and AI review inside owner-configured scope and limits; automatic merge is a
further live-only opt-in (`FACTORY_AUTOMERGE=enabled`). Critical, out-of-scope or
uninspectable changes wait for a human approval of the exact revision. Protected
acceptance tests, a separate fresh-context reviewer and a frozen
[agent-quality protocol](../evals/README.md) gate it.
The [policy contract](autonomy-policy.md), the
[controller, trusted runners and publisher](autonomy-operations.md) and the automatic merge
are implemented. The protocol's deterministic lane, its model lane on a real repository and
the [live proof](live-qualification.md) of a routine merge and a critical hold passed on
the qualified commit `039c43a` ([record](../evals/qualification/039c43a.json)). The default install
remains human-gated; bounded autonomy is enabled explicitly.

Potential later work includes further hardening of automated publication, clearer revision inputs,
additional qualified runtime/model adapters, expanded platform coverage and smoother
operator setup. These are proposals, not implemented features or delivery promises.
Any expansion must preserve human authority, credential isolation and reviewable
run evidence. Broad planning, multi-tenant hosting and autonomous operations require
separate product and security decisions; legacy source does not make them supported.
