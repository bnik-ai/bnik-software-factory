# Scope and roadmap

The first alpha is a self-hosted, operator-driven workflow for one GitHub repository:
Task activation, isolated coding, explicit publication, human review and required
CI, human merge and verified Task completion. [SUPPORT.md](../SUPPORT.md) defines
its environment and limitations.

Before the first release: finish licensing and public maintainer configuration,
review dependency findings, complete independent setup/recovery exercises, verify
the exact source artifact and obtain the owner's publication decision.

In progress before the first release: automate routine execution, publication and
merge inside owner-configured scope and limits, while critical, out-of-scope or
uninspectable changes wait for a human approval of the exact revision. Protected
acceptance tests, a separate fresh-context reviewer and a frozen
[agent-quality protocol](../evals/README.md) must pass first. The
[policy contract and decision library](autonomy-policy.md) exist; no runtime path
uses them yet, and the alpha remains human-gated until that work is verified.

Potential later work includes safer publication automation, clearer revision inputs,
additional qualified runtime/model adapters, expanded platform coverage and smoother
operator setup. These are proposals, not implemented features or delivery promises.
Any expansion must preserve human authority, credential isolation and reviewable
run evidence. Broad planning, multi-tenant hosting and autonomous operations require
separate product and security decisions; legacy source does not make them supported.
