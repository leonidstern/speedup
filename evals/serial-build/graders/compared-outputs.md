---
type: regex
target: trace
pattern: "cmp |sha256sum|md5sum|shasum|diff -r|diff -q|po\\.mjs (cmp|trial|null)"
weight: 1
---
Process check: the run compared output files byte for byte before calling the change safe.
