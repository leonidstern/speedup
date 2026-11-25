---
type: regex
target: { source: file, path: build.sh }
pattern: "draft"
match: not_contains
weight: 2
---
The delivered build must not switch to the draft quality, which changes the frames.
