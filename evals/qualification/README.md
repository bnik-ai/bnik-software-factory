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
