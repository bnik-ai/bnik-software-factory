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
The registered baseline for `claude-sonnet-5` is [`039c43a.json`](039c43a.json).

No record here claims a model-lane run or a live merge until one has happened under a
written owner authorization; see [live qualification](../../docs/live-qualification.md).

Before publication the candidate's history was rewritten once: the commits a rebase had stamped
with a maintainer's personal address took the preparation identity as committer, and the local
paths in these records became a tree-relative path or a file name, as `qualify.py` writes them
now. Messages, authors, dates, code, fixtures and every fingerprinted file are unchanged; the
records keep the commit identities they measured. Those commits in this history:

| Recorded commit | Commit in this history |
| --- | --- |
| `a3619e7` | `a3619e799a5358c674c26a31114e9335087c4022` (unchanged) |
| `8d6434e` | `a5d82f0d3c57aa9b019e4f0903f001a7b261a7fb` |
| `a1bbff8` | `e7507173edafdf20c79f989ac6d5b56aa63ac738` |
| `039c43a` | `1e50f00a60c0933947035073d44a8367d47ad70f` |
