# Third-party components

Each service has its own `package.json` and `package-lock.json`. Lockfiles are the
version and integrity record; the packages' own license texts control their use.
No `node_modules` directory or container image is part of this candidate.

The Claude adapter uses two distinct dependencies:

- `@anthropic-ai/sdk` is the API client (MIT metadata in the lockfile).
- `@anthropic-ai/claude-agent-sdk` and its platform packages at version 0.3.161
  carry vendor-specific terms. They must not be represented as Apache-licensed
  project code. Inspect the installed SDK's `LICENSE.md` and `README.md` and each
  platform package's license before use or distribution.

Other packages include permissive licenses and the development dependency
`lightningcss` with MPL-2.0 metadata. Consult the exact package license, including
its notices and any conditions applicable to the artifact you build.

Local installation obtains unmodified dependencies from their registries. The
locally built worker image contains the pinned vendor runtime and OS tools, so its
redistribution rights, notices and inventory require a separate review. The worker
Dockerfile installs Bash, Git, Python 3 and CA certificates through Debian apt;
those package versions are not pinned to a repository snapshot. Capture the exact
built-image inventory before any distribution. No prebuilt worker is published. The local
control-plane Dockerfile installs its four locked packages without lifecycle
scripts and excludes the installed Agent SDK. Node/PostgreSQL base images pin
manifest digests; their OS/runtime notices and the full built-image inventory need
review before distribution. Legacy service Dockerfiles remain experimental.
The project license is not yet finalized; no license here overrides vendor terms.
