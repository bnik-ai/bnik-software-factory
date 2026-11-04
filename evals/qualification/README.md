# Qualification records

One record per qualified candidate commit, written by `runtime/evals/qualify.py` and
committed after the commit it describes (a record cannot live inside the commit it
qualifies). Each record carries the configuration fingerprint the protocol lists, both
lanes with every trial as judged, the digest of each report it summarises, the threshold
evaluation and the open gates (`a3619e7.json`, `8d6434e.json`, `a1bbff8.json` and `039c43a.json`
keep only the model lane's totals). A lane that did not run is `NOT_RUN`; any lane that is not
`PASS`, and a functional regression beyond the tolerance of the registered baseline, leaves
`qualification: "open"`.

[`baseline.json`](baseline.json) registers the first record of each configuration (author model)
that met qualification (every absolute threshold, every case run), with that record's digest, its fingerprint and every
model-lane trial as judged (held-out layouts withheld); it is written only by
`runtime/evals/qualify.py --register-baseline` (`--replace` re-registers the same run after its
record gained evidence).
The registered baseline for `claude-sonnet-5` is [`039c43a.json`](039c43a.json); the latest
qualified commit is `b42a3c2` ([`b42a3c2.json`](b42a3c2.json)), judged against that baseline.

No record here claims a model-lane run or a live merge until one has happened under a
written owner authorization; see [live qualification](../../docs/live-qualification.md).

Before publication the candidate's history was rewritten twice: the commits a rebase had stamped
with a maintainer's personal address took the preparation identity as committer, the local paths
in these records became a tree-relative path or a file name, as `qualify.py` writes them now, and
three credential-shaped test fixture strings (a synthetic key header and two fake API keys) were
split so that no source file holds a scannable shape; their runtime values are unchanged. Messages,
authors, dates, code and every fingerprinted file are otherwise unchanged; the records keep the
commit identities they measured. Those commits in this history:

| Recorded commit | Commit in this history |
| --- | --- |
| `a3619e7` | `8b6d08e8f8f4ec4fa3a9b79d0a1e72b3df8cdfa2` |
| `8d6434e` | `b12af1ca712678f264a26ae805ba563d67d35c86` |
| `a1bbff8` | `d9be5504d24a29ab95145f897ef605fb132be3c9` |
| `039c43a` | `5f5d4eaf298724b574a4aa540255bf275f552c4f` |
| `5247e48` | `cb765bd810a65fba0583865901f5df9316d71b76` |
