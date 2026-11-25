# Patterns by kind of work

Each pattern names its rung on the ladder and the judge that fits. They are candidates to measure, not rules to apply: a pattern counts only after `po trial` or an equal comparison says KEEP.

## Builds and installs

- **Unchanged inputs should cost nothing** (rung 1). If `po null` shows the second run costing as much as the first, find what is rebuilt needlessly: a step with no up-to-date check, a clean before every build, a tool run with its cache off or its cache folder wiped.
- **Track change by content** (rung 2). Hash each step's inputs (files, config, tool version) into a state file and skip the step when the hash matches. Dates miss restored and regenerated files.
- **Install once** (rung 3). Reuse the dependency folder and the package manager's cache; use the lockfile install; do not reinstall on every run. Check that an install with nothing to do is near instant.
- **One entry command** (rung 1, for mistakes). A single command that runs every step in order removes forgotten steps and stale caches, the waste that costs whole reruns.
- **Fail fast.** Check preconditions (inputs exist, versions match, disk space, assets loaded) before the long part, so a doomed run costs seconds.
- **Use the cores** (rung 4). Many build tools are serial by default and take a jobs flag. Independent targets, packages or pages can be built by separate processes.
- **Skip outputs nothing reads** (rung 1): source maps, previews, reports, extra formats, verbose logs produced on every iteration.
- **Draft and final modes** (rung 2). A fast mode for checking, the full mode for the deliverable. The final mode stays byte-identical to before.
- **Fold manual post-steps into the build**, so the result does not depend on someone remembering them.
- Judge: output folder byte-identical; where the tool embeds timestamps or ids, fix that first or ignore exactly those lines.

## Tests

- **Run what the change touches** (rung 2) while iterating, the whole suite once before handing over.
- **Find the slow few** (rung 2). A handful of tests usually holds most of the time: read the runner's slowest-tests report before anything else.
- **Waiting is not testing** (rung 1). Real sleeps, network calls, long timeouts and retry loops inside tests show as low CPU. Fake the clock, shorten the wait, or stub the call, only where the test's meaning is unchanged.
- **Shared setup once** (rung 3): expensive fixtures per session instead of per test, when tests do not mutate them.
- **Parallel workers** (rung 4), one process each, when tests do not share files, ports or databases. Run the suite twice in parallel and in random order to expose hidden coupling before trusting it.
- Judge: the same list of passed, failed and skipped tests before and after, by name, not only the counts. A test that was passing must not become skipped.

## Renders, exports and media

- **The device first.** Check the renderer or encoder actually uses the GPU or hardware encoder the machine has. Batch runs commonly default to the CPU because they do not load the interactive preferences; set the device in the render script or command line, and read the run's log to confirm. An idle GPU in `po time` during a render is the sign.
- **One machine, one heavy job.** Several renders, recordings or sessions started at once on one machine share the same cores and GPU, and each runs slower than alone; several workers of one job only pay when the machine has room (measure 1, 2, 4 workers). Check `po time` for `others` and `twins` before deciding.
- **Render only what changed** (rung 2): frames, tiles, pages or scenes whose inputs changed, joined with the untouched ones.
- **Stream, don't spill** (rung 5). Pipe frames into the encoder instead of writing thousands of temporary files.
- **One process per worker** (rung 4). Tabs in one browser, threads behind one lock, or several jobs on one GPU context often do not run in parallel; separate processes do. Split into ordered slices and join losslessly (stream copy, not re-encode).
- **Bake what is recomputed** (rung 3): effects, filters, layouts or transforms evaluated per frame that have the same value every time.
- **Cheaper settings only when the pixels are the same** (rung 5): encoder presets and thread counts usually change bytes but not necessarily pixels. Check.
- Judge: decoded frames identical (`po cmp` on the files), or frames captured at the same moments and diffed. A tolerance needs a measured noise floor from two unchanged runs.

## Data jobs

- **Read less** (rung 2): only the needed columns, partitions and date range; filter before joining.
- **Do not recompute stable stages** (rung 3): keep intermediate results keyed by the content of their inputs.
- **Batch** (rung 3): one query or request for many items instead of one each.
- **Parallelize independent partitions** (rung 4) and join in a fixed order.
- Judge: row counts, per-column checksums, a diff of sorted output. Floating point sums can differ by order of operations: compare with a stated tolerance and say so.

## Interactive runtime: frame time, latency, startup

- **Measure the worst case, on the slowest target** (the oldest device, the weakest browser engine), not the average on a fast machine. One long frame is a visible stall even if the mean is fine.
- **Find what is redone per frame or per request** that has the same value each time, and compute it once (rung 3).
- **Defer what is not needed yet** (rung 6): load, parse, connect or render on first use.
- **Shrink what is processed** (rung 2): fewer nodes, smaller regions, lower update rate where nothing visible changes.
- Judge: frames or responses captured at the same moments before and after and diffed; the same sequence of actions gives the same states.

## Idle cost: battery, CPU and network while nothing happens

- **Measure idle first.** CPU of every process of the app over 10 seconds while paused or hidden (a browser counts all its helper processes), animation-frame and timer callbacks per second, network requests per minute. Idle should be close to zero.
- **Loops that run while nothing changes** (rung 1): an animation loop that keeps running when paused, hidden or finished; polling where an event exists; timers nobody clears. Stop the loop when the state settles, and restart it from every place that can change the state (play, seek, keys, API calls, end of media), or it will not resume.
- **Off-screen work** (rung 2): animations in hidden tabs or scrolled-away elements; pause them on visibility change.
- **Oversized refreshes** (rung 2): re-downloading whole resources where a conditional request or a delta would do.
- Judge: frames at fixed moments identical before and after, and the same behaviour on every engine the product supports.

## Frame time

- Record frame times while it plays in real time, not stepped: median, 95th percentile, worst, and the count over 25 ms and over 42 ms. A threshold sitting on a refresh multiple (34 ms) flips with noise.
- Measure each engine the users have; headless numbers are relative only.
- Time the page's own callbacks first, then layout, style and paint. For an engine without a profiler, switch one suspect off at a time in a throwaway copy.

## Energy, cost and other budgets

Use this when the cost is a budget per use (energy per transaction, money per request, bytes per page) rather than a time you can run.

- **Itemize per event.** For each component: power or price while active, how long it is active per event, events per period, plus the standing cost when idle. The total is the sum; the share column tells you where to look.
- **The biggest item first.** A component that is half the budget is the only one worth the first hour.
- **On only while needed** (rungs 1 and 2). The largest cuts usually come from switching something on later and off sooner: a radio field, a display light, a sensor scan, a server that idles.
- **Lower duty before lower power** (rung 2): fewer updates, slower polling, sleep between events.
- **Standing costs set the ceiling.** When the active budget is small, idle draw and self-discharge (or fixed fees) dominate and further active cuts do nothing. Say so.
- **Requirements are the judge.** List what the product must still do (every user-visible step, safety and certification constraints). A cut that removes or delays one of them is a trade-off for the user to decide, not an optimization.
- **Estimates stay estimates.** Give the range, the assumption that matters most, and the bench measurement that would settle it. Compare alternatives with the same optimizations applied to each.

## Your own session

- Read `po ledger` (with the plugin's hook) or look back over the commands you ran: which command took the most total time, and which were rerun with nothing changed.
- Replace a repeated full run with the narrowest run that answers the question, and keep the full run for the end.
- When the same sequence of steps has run twice, make it one command.
- Record the fast path where the project keeps its notes, so the next session starts from it.
