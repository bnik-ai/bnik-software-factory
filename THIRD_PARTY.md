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

Local installation obtains unmodified dependencies from their registries. A future
prebuilt worker image would also contain vendor runtime and OS components, so its
redistribution rights, notices and inventory require a separate review. Existing
Dockerfiles are experimental and are not a cleared image distribution recipe.
The project license is not yet finalized; no license here overrides vendor terms.
