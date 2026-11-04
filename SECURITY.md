# Security policy

## Reporting

This repository is archived and released as-is (see [SUPPORT.md](SUPPORT.md)); it receives no
security fixes. Do not post exploit details publicly. If the repository offers GitHub's private
vulnerability reporting (a **Report a vulnerability** button on its security page), a private
report reaches the repository's administrators, with no promised response, fix, bounty or
service-level agreement; otherwise there is no private reporting channel. Anyone running or
forking this code owns its remediation.

## Supported versions and scope

No version is supported. The notes below describe the security-relevant boundaries of
`0.1.0-alpha` for anyone who runs or forks it.

Security-sensitive boundaries include webhook authentication, human authorization,
repository scope, archive extraction, worker/proxy isolation, cancellation/recovery,
required review/CI checks and credential handling. Read the [architecture](docs/architecture.md)
and [worker boundary](docs/isolated-worker.md). Containers share the host kernel;
the host, Docker daemon, native supervisor, image and local database are trusted.
Prompt injection and dishonest tests remain possible inside allowed work.

Do not execute untrusted repository code on the operator host. Keep GitHub/App and
provider credentials outside source, prompts and worker files. A provider may receive
source content and charge for interrupted requests. Receipts, database backups and
local result directories can contain sensitive code. Use [retention controls](docs/run-controls.md)
and [recovery procedures](docs/recovery.md); local content pruning does not erase
GitHub history, provider records, filesystem exports or backups.

`npm audit` of all five lockfiles on November 4, 2026, after the remediation in the
[release notes](CHANGELOG.md), reported one advisory: GHSA-xcx6-jx8p-x3h5 (high) in
`@azure/msal-node` 5.2.2, which `@azure/identity` 4.13.1 brings into agents, github-app,
orchestrator and validator. It affects MSAL's authorization-code flow (`acquireTokenByCode`).
This project constructs only `DefaultAzureCredential`, whose credential chain never runs that
flow, and only on the legacy Azure paths; the local profile refuses Azure configuration. The
fix arrived in `@azure/identity` 4.14.1, published on October 29, 2026 after this release's
dependencies were frozen, which accepts the fixed `@azure/msal-node` 7.1.0. It is not applied:
the agents package's dependencies are part of the qualified worker image, so the change would
need a new live qualification. A fork that uses the Azure paths should upgrade. Downgrading to `@azure/identity` 4.13.0, whose
`@azure/msal-node` 3.x is outside the affected range, was evaluated and not chosen: it moves
the authentication library back a major version and brings GHSA-w5hq-g745-h8pq (moderate) in
`uuid`. Audits are point-in-time: re-audit before you deploy; a
passing build is not evidence of no vulnerabilities.
Do not expose development test UI servers or experimental entrypoints as services.
Report vendor vulnerabilities to that vendor's security channel as appropriate;
project maintainers cannot commit to fixes in a vendor's runtime or service.
