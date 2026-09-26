# orchestrator

Part of [BNIK Software Factory](../../README.md). Read the root README for the
candidate support boundary and source-check commands. This package retains its
interfaces, implementations and fixture tests. Use `src/` and `package.json` for
entrypoints and scripts; existing runtime entrypoints and Dockerfiles are
experimental and are not a supported local launcher.

Install locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund`,
then run `npm test`, `npm run lint` and `npm run type-check` in this directory.
These checks do not prove live GitHub/model connectivity or deployment health.
