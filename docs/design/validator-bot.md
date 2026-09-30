# validator-bot design

The validator parses events, resolves actor and record policy, evaluates finite state machines and writes verdicts to a hash-chained audit ledger. Its migrations define webhook delivery deduplication and audit storage. Queue implementations must preserve ordering and retries without losing accepted verdicts.

See the implementations and tests under `services/` and the
[source map](../sources-of-truth.md). The local runtime reuses its parser, finite state
machines and audit ledger (`services/local-runtime/src/adapters.ts`,
`services/local-runtime/src/github/merge-gate.ts`).
