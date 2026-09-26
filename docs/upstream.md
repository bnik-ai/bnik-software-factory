# Upstream and deployment integration

After the first release, the public BNIK Software Factory repository will be the
canonical home for reusable service code, tests, interfaces, templates and docs.
This development candidate is the prospective upstream implementation. Continue
core development here; do not maintain a second core in a deployment repository.

Private deployment repositories own environment identities, secrets references,
infrastructure state and environment-specific configuration. They consume a pinned
upstream tag or commit and reviewed build artifacts. Record that version beside
each deployment so upgrades and rollbacks are reproducible. Keep infrastructure
provisioning and environment-specific database grants in those overlays.

A core fix goes upstream first, with tests. An urgent private patch must record its
upstream issue, owner, and expiry; contribute it back or remove it at the next
upgrade. Do not copy the service directories into an indefinitely divergent fork.
Extensions should implement the public interfaces without changing policy rules.

Upgrades compare interface/schema changes, exercise overlay integration in a test
environment, and pin the accepted revision. Existing deployments remain on their
current implementation until that migration is verified; a source export does
not update a live service. The old core becomes an archive once consumers migrate.

Proposed repository slug: `bnik-software-factory`. The GitHub owner is undecided.
The existing private npm package identifiers `@sfac/*` remain unpublished and
unchanged for compatibility; any published package or image namespace needs an
explicit release decision. No remote URL or package registry is assumed here.
