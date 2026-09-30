# github-app design

The Hono application authenticates webhooks and hands accepted deliveries to an event queue. Its source also contains admin, agent and infrastructure surfaces. App permissions, repository activation and credential boundaries require deployment-specific validation.

See the implementations and tests under `services/` and the
[source map](../sources-of-truth.md). The local runtime reuses its webhook handling
(`services/local-runtime/src/main.ts`); its admin, agent and infrastructure surfaces
remain experimental.
