# Third-party components

Each service has its own `package.json` and `package-lock.json`. Lockfiles are the
version and integrity record; the packages' own license texts control their use.
No `node_modules` directory or container image is part of this candidate.

The Claude adapter uses two distinct dependencies:

- `@anthropic-ai/sdk` is the API client (MIT metadata in the lockfile).
- `@anthropic-ai/claude-agent-sdk` and its platform packages at version 0.3.283
  carry vendor-specific terms. They must not be represented as Apache-licensed
  project code. Inspect the installed SDK's `LICENSE.md` and `README.md` and each
  platform package's license before use or distribution.

Other packages include permissive licenses and the development dependency
`lightningcss` with MPL-2.0 metadata. Consult the exact package license, including
its notices and any conditions applicable to the artifact you build.

Local installation obtains unmodified dependencies from their registries. The
locally built worker and operator images contain the pinned vendor runtime and OS tools, so its
redistribution rights, notices and inventories require a separate review. The worker
Dockerfile installs Bash, Git, Python 3 and CA certificates through Debian apt;
those package versions are not pinned to a repository snapshot. Capture the exact
built-image inventory before any distribution. The operator also installs the Docker CLI, Git, Python 3 and CA certificates from Debian, and all five locked service packages. No prebuilt image is published. The local
control-plane Dockerfile installs its four locked packages without lifecycle
scripts and excludes the installed Agent SDK. Node/PostgreSQL base images pin
manifest digests; their OS/runtime notices and the full built-image inventory need
review before distribution. Legacy service Dockerfiles remain experimental.
Project-owned code uses [Apache-2.0](LICENSE); it does not override dependency or
service terms. No SDK/platform binary or installed dependency tree is shipped in
the source distribution. Exact copyright attribution is being finalized.


## Artifact and notice scope

| Artifact | Contents and notice handling |
| --- | --- |
| Project source archive | Project source/docs, lockfiles, LICENSE and provenance; preserve any source notices. No installed third-party implementation is vendored. |
| Locally installed npm packages | Each installed package retains its own license/notice. The lockfile is an inventory reference, not a replacement for license text. |
| Locally built worker/operator/control-plane image | Includes dependencies, OS tools and possibly the vendor SDK; not an approved distribution artifact. Inventory and satisfy exact artifact obligations before redistribution. |
| Provider/GitHub services | Account contracts, acceptable-use, billing and data-processing rules apply separately from source licensing. |

For the pinned Agent SDK, `LICENSE.md` points to Anthropic's
[legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance).
The SDK and platform executables remain Anthropic software under their own terms.
Use your own authorized API key and account; this project supplies no provider
subscription or resale rights. Local build instructions and use of an unmodified
vendor package do not by themselves clear every hosted or redistributed use case.
Review applicable terms for your actual use. Vendor compliance certifications are
not certifications of this project.

Before distributing anything beyond project source, record exact package/image
versions and include the license and attribution texts required for those bytes.
For OS tools such as Git, source-offer or corresponding-source obligations can
differ from npm notices. No review of an earlier source tree clears a later image.
