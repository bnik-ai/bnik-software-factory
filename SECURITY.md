# Security policy

## Reporting

This private candidate has no public release repository or verified public security
contact yet. Before external distribution, the maintainer
([@bnikanjam](https://github.com/bnikanjam)) must enable and test GitHub private
vulnerability reporting in that repository and identify any fallback private contact
in this file.

The proposed release reporting route is the repository's **Security → Advisories →
Report a vulnerability** action. If that action is unavailable, do not post exploit
details publicly: ask through an existing private maintainer channel, or open a
non-sensitive issue requesting a private contact. Do not include the vulnerability
itself, credentials or customer data in that issue. This is not an emergency service.

A private report should include affected commit/version, environment, prerequisites,
a minimal synthetic reproduction, expected/actual behavior and possible impact.
Redact keys, tokens, repository content and personal data. Coordinate disclosure
with the maintainer; acknowledgements and fixes are best effort, with no promised
response deadline, bounty or service-level agreement.

## Supported versions and scope

The proposed policy covers the latest alpha and current development branch, as
listed in [SUPPORT.md](SUPPORT.md). No released version exists yet. Report problems
in experimental code too, but its remediation and support are not guaranteed.

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

`npm audit` of all five lockfiles on October 29, 2026, after the remediation in the
[release notes](CHANGELOG.md), reported one advisory: GHSA-xcx6-jx8p-x3h5 (high) in
`@azure/msal-node` 5.2.2, which `@azure/identity` 4.13.1 brings into agents, github-app,
orchestrator and validator. It affects MSAL's authorization-code flow (`acquireTokenByCode`).
This project constructs only `DefaultAzureCredential`, whose credential chain never runs that
flow, and only on the legacy Azure paths; the local profile refuses Azure configuration. The
fix (`@azure/msal-node` 7.1.0) is outside the range every released `@azure/identity`
supports, so it is not forced. Audits are point-in-time: re-audit before each release; a
passing build is not evidence of no vulnerabilities.
Do not expose development test UI servers or experimental entrypoints as services.
Report vendor vulnerabilities to that vendor's security channel as appropriate;
project maintainers cannot commit to fixes in a vendor's runtime or service.
