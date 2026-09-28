# Qualification records

One record per qualified candidate commit, written by `runtime/evals/qualify.py` and
committed after the commit it describes (a record cannot live inside the commit it
qualifies). Each record carries the configuration fingerprint the protocol lists, both
lanes with every trial as judged, the digest of the report it summarises, the threshold
evaluation and the open gates. A lane that did not
run is `NOT_RUN`; any `NOT_RUN` or failed threshold leaves `qualification: "open"`.

No record here claims a model-lane run or a live merge until one has happened under a
written owner authorization; see [live qualification](../../docs/live-qualification.md).
