# Source tooling

Run `node --test scripts/*.test.mjs` from the repository root.

`gen-architecture-diagrams.mjs` derives agent membership and FSM counts from code,
record counts from the architecture tables, and logical Azure names from
`docs/design/azure-adapter.md`. It refuses inconsistent models. Regenerate with
`node scripts/gen-architecture-diagrams.mjs > docs/architecture-diagrams.md` and
check with `node scripts/gen-architecture-diagrams.mjs --check`.

`doc-pr-sync.mjs` compares Mermaid blocks in `PR_BODY` against tracked Markdown.
A block preceded by `<!-- sf:diagram-local -->` is intentionally local to a PR.
These scripts do not create pull requests. The generator's `--slack-notify` option posts to
`SLACK_WEBHOOK_URL` only when someone runs it by hand; no workflow runs it.
