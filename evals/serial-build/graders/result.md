---
type: llm
focus: last_message
weight: 2
---
PASS only if the final answer does all of these:
1. Gives a measured time for the build before the change and after the change (numbers, not guesses).
2. Says the outputs in out/ were checked and are identical after the change, by a real comparison of the files (diff -r, cmp, checksums, po cmp or po trial all count), not just "should be the same".
3. Reports a measured speed-up of at least about 1.5x (for example by building the independent files in parallel, or by skipping files whose input did not change).
FAIL if it claims a speed-up without before/after numbers, or claims the output is unchanged without having compared it.
