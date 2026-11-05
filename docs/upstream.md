# Upstream and deployment integration

This repository receives no upstream development; it stays open until December 31, 2026, then is
archived at `0.1.0-alpha` unless a new maintainer takes over. A team that builds on it makes its
fork the upstream: keep reusable service code, tests, interfaces,
templates and docs there, and do not maintain a second core in a deployment repository.

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

The release is published as the GitHub repository `bnik-ai/bnik-software-factory`. The npm
package identifiers `@sfac/*` are unpublished and unchanged for compatibility; no package or
image is published to any registry.
