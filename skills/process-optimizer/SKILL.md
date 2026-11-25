---
name: process-optimizer
description: Make slow, repeated or wasteful work faster or cheaper without changing what it produces. Use when a build, test run, render, export, install, data job or any command is slow or keeps being rerun; when asked to optimize, speed up, or cut the time, cost, energy, memory or size of something, including idle CPU, frame drops, a product's runtime or battery budget; and before rerunning an expensive step. Measures first, changes one thing at a time in a copy, proves the result unchanged, reports before and after.
---

# Process optimizer

An optimization is the same result for less cost. This skill is the discipline that keeps both halves true: the cost really went down, and the result really did not change. It applies to anything with a cost you can count and a result you can compare: a build, a test suite, a render, a data job, a page's frame time, a device's energy per use, your own sequence of commands in this session.

`po` below means `node <this skill's folder>/scripts/po.mjs`. It has no dependencies and writes only to its own scratch folder.

## The contract

These hold for every change, however small. They are what makes the work safe to do without asking.

1. **Numbers before and after.** Measure the cost before you change anything and again after, on the same machine with the same inputs. No number, no claim.
2. **The result is the judge.** Before the change, decide how you will prove the result is the same (see "Choosing the judge"). After it, run that comparison. A change that alters the result, even slightly, is a trade-off and not an optimization: stop and put it to the user with the evidence.
3. **Work in a copy.** Try changes in a scratch copy, a worktree or a branch. The real thing stays untouched and runnable until a change is proven, and the old path stays available after.
4. **Nothing outside the copy.** No production, shared service, deploy, push, publish, paid resource, global install or global setting. Never run a process with outside effects (deploy, send, migrate, charge) to measure it: use its dry run, or reason from its logs. Never delete the user's files; `po` keeps its copies in its own folder.
5. **One change at a time.** Otherwise you cannot say which change helped or which one broke the result. Reject on doubt: an unproven speed-up is worth nothing.
6. **Leave the machine usable.** Keep a core or two free and watch memory when adding workers, so the user's other work still runs. Never stop a process you did not start.

## First, avoid the work

Most waste is work that did not need to happen. Before any command that takes more than a few seconds, ask:

- **What question does this run answer, and what is the narrowest run that answers it?** One test instead of the suite, one file instead of the project, one frame or page instead of all of them, a dry run, a smaller input.
- **Is it already answered?** If nothing it reads has changed since it last succeeded, the earlier result still stands. Do not rerun to "make sure".
- **Does this run need full quality?** Use draft settings while iterating and the full run once, at the end.
- **Am I redoing earlier stages to reach a later one?** Keep intermediate results and start from them.
- **Am I verifying by redoing?** Comparing two outputs is usually cheaper than producing a third.
- **Can it overlap with other work?** Start independent commands together, or in the background while you continue.

These cost nothing and change no files, so apply them always, asked or not. Everything below edits how a process works: do that when the user asked for it, or offer it in one line with the measured number and carry on with the task.

## The loop

1. **Define.** Name the cost (wall time, CPU, energy per event, bytes, money, manual steps) and the result that must not change. Note how often the process runs: a saving matters in proportion to cost times frequency. Work that runs once is not worth optimizing.
2. **Measure.** Run these two before reading any build script:
   - `po time -- <command>`: the cost, how many cores were busy, which processes did the work, whether the GPU was used, and what else was running on the machine.
   - `po null --out <outputs> -- <command>`: the same command twice with nothing changed. It shows what an unchanged rerun costs and whether the outputs are deterministic, which decides the judge.

   Then measure each stage of a multi-stage process separately. Time what the user actually runs, cold and warm.
3. **Locate.** Rank the parts by share of the total. Only the biggest matters: halving a step that is 5% of the run saves 2.5%. Read the profile before guessing (table below).
4. **Pick one change**, the highest rung of the ladder that fits the biggest part.
5. **Try it in a copy and judge.** `po trial` runs before and after in two scratch copies, compares the outputs and gives a verdict. For changes it cannot express, do the same by hand: copy, run, snapshot, change, run, compare.
6. **Keep or reject.** Keep only on an unchanged result and a gain outside the noise (repeat runs when the gain is under about 10% or 5 seconds). A change that hangs or runs far longer is a reject; `po trial` stops it at three times the old time. Then measure again from step 2: the bottleneck has moved. When adding workers, go in steps (2, 4, 8) and compare each step with the previous one: they stop paying when a shared resource (one GPU, one disk, memory) is full.
7. **Stop** when the biggest remaining part is small, the next change would alter the result, or the gain is within noise. Stop after three rejected changes in a row: the process is near its floor. Keep the effort in proportion: the time you spend should be repaid by the saving times the runs to come. "Already tuned, nothing safe to gain" with the measurements is a complete answer. Say what is left and why.
8. **Report** (format at the end), and record the new way of running it where the project keeps such notes.

## The ladder

Try the rungs in this order. Higher rungs save more and risk less.

1. **Don't do it.** A step whose output nothing reads; a rerun with unchanged inputs; work done "just in case"; a wait that waits for nothing.
2. **Do less of it.** Only what changed (track by content, not dates); only the scope in question; only when it is actually needed, as late as possible; draft quality while iterating.
3. **Do it once.** Cache it, keep a warm process instead of starting one per item, hoist setup out of a loop, precompute at build time what is recomputed on every run or frame, batch many small calls into one.
4. **Do it at the same time.** Independent items across cores or connections, one process per worker, then join the pieces without re-processing them.
5. **Do it cheaper.** A better algorithm, a faster tool or setting that gives the same result, a hardware path, streaming instead of temporary files.
6. **Do it off the critical path.** Later, lazily, or in the background, so nobody waits for it.

## Check the machine before the method

The cheapest wins are often not in the process at all but in how the machine runs it. Check these first; `po time` reports the first three.

- **The right hardware.** Work that can run on the GPU (rendering, video encoding, image and ML work) quietly falling back to the CPU: an idle GPU while the CPU is busy. Batch and headless runs often ignore the device settings an interactive session uses, so the run must set the device itself. Confirm from the tool's own log which device it used, and compare one frame or item on each.
- **Competing load.** Other processes using the cores: leftover runs from earlier, several sessions or agents doing the same work at once, dev servers, watchers, background renders. They slow the work and make every timing unreliable. `po time` lists them under `others`, and `twins` flags copies of the same program running outside the command. Never stop a process you did not start: name it to the user, who decides.
- **All the cores.** A tool running one worker where the machine has many (see the table below).
- **Where it runs.** A laptop on battery, a throttled container, a network drive or a synced folder (cloud drives, antivirus scanning every write) can cost more than the work. Temporary and output files belong on a fast local disk.

## Reading the measurement

| `po` shows | It means | Look at |
| --- | --- | --- |
| Under about 0.5 cores busy | Waiting, not working | Sleeps and fixed waits, timeouts, retries, serial network or disk requests, a process that idles before exit |
| About 1 core busy, others idle | Serial CPU work | Rungs 1 to 3 first, then parallel workers |
| All cores busy | Already parallel | Only less work helps: rungs 1 to 3 and 5 |
| Between 1 and all cores | Partly parallel | The serial stretch: setup, one single-threaded step, the final join |
| Null run costs as much as the first | Nothing is cached | Skip unchanged inputs; find the step that ignores its cache |
| Null run outputs differ | Not deterministic | Fix the cause (timestamps, random ids, ordering) before judging anything by bytes |
| One process dominates "where" | That tool is the cost | Its own options, how many times it starts, what it is fed |
| Many short-lived processes | Startup cost repeated | One warm process, batching |
| `gpu` idle while the CPU works | The work may be running on the wrong device | The tool's device setting in the run itself, then compare one item on each device |
| `gpu` busy above 80% | The GPU is the bottleneck | Fewer or cheaper GPU passes; more CPU workers will not help |
| `others` high, or `twins` | Something else is competing | Name it to the user; measure again when the machine is quiet |

When a profile does not explain it, time the stages one by one, or use the tool's own profiler. Do not guess.

## Choosing the judge

Pick the strictest comparison the result allows, and pick it before the change.

- **Files from a deterministic process:** byte-identical. `po cmp`, or `po trial` does it.
- **A process that does not repeat itself** (renderers, recorders, anything timing-dependent): run the unchanged command twice; how much those two outputs differ is the noise floor. "Same" then means the change differs from the old output no more than the old output differs from itself. `po trial --noise` does exactly this and prints both numbers. State the floor in the report.
- **Files with known noise** (timestamps, build ids): remove the noise at its source where the tool allows (many build tools take a fixed date from `SOURCE_DATE_EPOCH`; `po trial` sets one date for both runs). Otherwise compare after ignoring exactly those lines, `--ignore-line <regex>`, and name what is ignored. When a few bytes of a binary differ, `po cmp` says how many and where: confirm what they are before calling it noise.
- **Pictures and video:** `po cmp` decodes them and compares pixels, so a re-encode with identical frames passes as equivalent. Use `--px` and `--pct` only for renderer noise you have measured between two unchanged runs, and state the tolerance.
- **Code behaviour:** the project's tests, with the same pass and fail list before and after, test by test and not only the counts (`--check "<test command>"` checks the exit code). Tests that already fail cannot judge; a flaky baseline is reported, not fixed.
- **Runtime behaviour** (an idle page, an app): frames at the same moments are identical, and it still animates, updates and responds the same way.
- **Data:** row counts, checksums, a diff of sorted output.
- **Interactive or visual behaviour:** frames captured at the same moments and diffed; the same script of actions giving the same states.
- **Then look yourself** at whatever differed most. A comparison can pass on something a person would reject.

If no comparison is possible, the change is not provable and does not qualify.

## When you cannot run it

Some costs cannot be timed here: a device not built yet, production traffic, a monthly bill, battery life. Then the model is the measurement.

1. Write the budget as a table: each item, its cost per event, events per period, share of the total. Give every number its source: datasheet, measurement, or assumption.
2. Rank by share and take the ladder to the biggest item. The result that must not change is the list of requirements: what the user or the product must still be able to do.
3. Report the outcome as an estimate. Name the assumption it is most sensitive to and the measurement that would confirm it.
4. Compare alternatives on equal terms: give each side the same optimizations and conditions, or the comparison is not honest.

For runtime work (frame time, latency, startup), judge by the worst case on the slowest target that matters, not the average on your machine.

## `po`

```
po time   [--runs N] -- <command>                 wall time, CPU, cores used, which processes
po null   [--out PATH]... -- <command>            same command twice, nothing changed
po snap   <name> <path>...                        keep a copy of outputs to compare against
po cmp    <a> [<b>]                               snapshot, file or folder; bytes, then pixels or lines
po trial  --cmd "<command>" --out PATH... (--patch FILE | --apply "<shell>" | --cmd-b "<command>")
          [--check "<command>"] [--runs N] [--fresh] [--exclude PATH]...
po ledger                                         what this session spent its time on (with the plugin's hook)
```

`po trial` copies the project twice, runs the command unchanged in one copy and with the change in the other, compares the `--out` paths and prints `KEEP`, `NO GAIN` or `REJECT`. `--patch` and `--apply` change files in the copy; `--cmd-b` runs a different command. It exits 0 only on `KEEP`. The real project is never touched; apply a kept change yourself afterwards. Compare options: `--ignore-line REGEX`, `--px N --pct P`.

Both copies run at one and the same path, so output that embeds its build folder still compares. `--fresh` starts each copy as a clean checkout (files git ignores are left out): use it to measure a build from scratch, and when the folder holds things that store their own location. Prefer `po time` to a bare `time`: it also says how many cores were busy, which is what picks the next move.

## Traps

- **A faster wrong answer.** Minifiers, optimizers and "safe" flags that rename, merge, reorder or round can break whatever reads the output. Allow only named, structure-preserving transforms, and judge.
- **Caches that lie.** A cache keyed on less than everything the step reads returns stale results. Key on content of all inputs, including config and tool versions.
- **Parallel work that shares state.** Workers writing the same file, port, temp folder or cache corrupt each other. Give each its own, and join in a fixed order.
- **Re-slicing changes the output.** Splitting work differently (workers, chunks, shards) can move video keyframes, test order or random seeds. Keep the old split, or prove sameness again.
- **A requested output change is not an optimization.** If the user asked for something that changes the output on the way (a format fix, a new size), make it a separate step and report it apart from the speed-up.
- **Moving the cost instead of removing it.** A faster step that makes a later one slower, or a build-time saving paid at run time. Measure the whole.
- **Warm against cold.** The second run of anything is faster. Compare like with like, and say which.
- **Copies with absolute paths.** Build folders and virtual environments store their own location: a copy can break, or quietly keep using the original. Start the copy clean (`--fresh`, `--exclude`) and set it up again inside the copy.
- **Another machine.** Core counts, disks, encoders and fonts differ. Say where each number was measured, and measure again where it will run.
- **Noise.** One run proves little when the gain is small. Repeat, and report the median.

More patterns by kind of work (builds and installs, tests, renders and media, data jobs, interactive runtime, energy and cost budgets) are in `patterns.md` next to this file. Read the section that fits when the ladder alone does not suggest a move.

## The report

Keep it to what the user needs to decide and to trust the result:

- **Before and after**, per change and in total, with where it was measured: `build 94 s → 31 s (3.0x), 4-core Linux container`. The headline counts only changes proven to keep the result.
- **Trade-offs apart from the headline:** a change that alters the result is listed separately, with what it would add and exactly what it changes, for the user to decide.
- **What was compared and the verdict:** `214 output files byte-identical`, `3,600 frames identical`, `tests: same 412 pass`.
- **What changed**, in a line each, and how to undo it.
- **What was tried and rejected**, with the reason, and what is left on the table.
- "Measured, nothing safe to change, left alone" and "cause found, no fix proven safe, left alone" are complete results. Say them plainly with the numbers.
- Estimates labelled as estimates.
