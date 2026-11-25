---
name: speedup
description: Make a slow or repeated step faster without changing what it produces. Use when a step took over about 60 seconds, the same slow step ran 2 or more times, a build / render / record / test / upload loop keeps being repeated, something drains battery or keeps the CPU or GPU busy while idle, a page or app drops frames or feels janky, or the user asks to make something faster or lighter. Also use when a hook line starting with "speedup:" appears. Method - measure, find the bottleneck, one safe change at a time, prove the output is the same, keep it only if the number improved.
---

# speedup

Make the slow thing faster. Change nothing else. Works in any project, on any task.

## When to use

- A step took more than about 60 seconds.
- The same slow step ran 2 or more times.
- You are in a loop: build, render, record, test, upload, repeat.
- Something uses CPU, GPU or battery while nothing is happening.
- A page or app drops frames, stutters or scrolls badly.
- The user asks to make something faster, lighter or smoother.
- A line starting with `speedup:` appeared after a command (the plugin's hook).

Don't use it for a step that runs once and is already done. Finish the task first if the speed-up would take longer than the time it saves.

## Safety rules (hard)

These come before any speed gain. If a change needs one of them, stop and ask the user.

1. Never change what the project produces or how it behaves. Same files, same pixels, same results, same pass/fail.
2. Never delete user data. Only delete temp files you created yourself.
3. Never touch production, deploys, shared or global config, or CI settings.
4. Never push, publish or open pull requests.
5. Never install anything globally or change system settings without asking. Never run `sudo` yourself.
6. Never raise parallelism so high the machine becomes unusable. Leave at least 2 cores free and watch memory.
7. Keep the old command working. The fast path is a copy, a new file or a new flag until it is proven.

## 1. Measure first

No change before a number. Write the baseline down (in your reply or a scratch note), so "after" has something to be compared with.

**Time and machine use**

| What | How |
| --- | --- |
| Wall time, CPU time, peak memory | macOS: `/usr/bin/time -l <cmd>`. Linux: `/usr/bin/time -v <cmd>` |
| Cores | macOS: `sysctl -n hw.ncpu`. Linux: `nproc` |
| CPU use vs cores | (user + sys) / real. Near 1.0 on a 10-core machine means 9 cores sat idle |
| Memory free | macOS: `memory_pressure` or `vm_stat`. Linux: `free -m` |
| How often the step ran | count it: this session, per loop, per file |
| Failures and retries | count them; a retry doubles the cost of a step |
| Where the time goes inside | the tool's own timing flag (`--profile`, `--verbose`, `--durations`, `-stats`), or time each stage separately |

Run the unchanged command twice. The first run may be a cold cache, and the difference between the two outputs is your **noise floor**: the old output is often not repeatable (dates, encoders, timing). Write it down; step 5 uses it as the tolerance.

If the project's default already overloads the machine (more workers than cores, memory swapping), say so, and judge by measured load, not by the worker count.

**Energy and battery** (something stays busy while idle)

| What | How |
| --- | --- |
| CPU of one process while idle | macOS: `top -l 2 -pid <pid> -stats pid,command,cpu,power` (read the 2nd sample). Linux: `top -b -n 2 -p <pid>` |
| Wake-ups, energy impact | macOS: `top -l 2 -stats pid,command,cpu,idlew,power`. `powermetrics` needs sudo: only if the user allows it and runs it; never run sudo yourself |
| A page while idle | Playwright: open a CDP session, call `Performance.getMetrics` at 0 s and at 10 s with nobody touching the page; compare `TaskDuration`, `ScriptDuration`, `LayoutCount`, `RecalcStyleCount`. An idle page should add close to nothing |
| When to sample | wait about 3 s after pausing or settling before the sample: animation libraries keep ticking briefly |
| A whole browser | add up ALL its processes by name (renderer, GPU, network helpers). WebKit's helpers are not children of the process you launched |
| Loops that never stop | count `requestAnimationFrame` callbacks and timer fires over 10 s idle (wrap them in a test page, or use the Performance panel) |
| Network while idle | count requests and bytes over 60 s idle (Playwright `page.on('request')`, or the Network panel) |

**Screen and rendering** (frames)

| What | How |
| --- | --- |
| Frame time | in the page, record the time between `requestAnimationFrame` callbacks for a few seconds of the real interaction. Report median, 95th percentile and worst |
| Long frames | count frames over 25 ms and over 42 ms (1.5 and 2.5 refreshes at 60 Hz). A threshold right on a refresh multiple (like 34 ms) flips with noise |
| Both engines | measure in Chromium AND WebKit (Playwright has both). They differ a lot on filters, blur and compositing |
| Real time | play it back at real speed, not stepped frame by frame; stepping hides dropped frames |
| What the frame was spent on | first time the page's own callbacks (rAF, timers, handlers): that splits script from paint. Then Chromium: trace or Performance panel. WebKit has no trace: switch one suspect off at a time in a throwaway copy and measure again |
| Headless numbers | relative only: compare before with after on the same setup, don't quote them as what the user sees |

## 2. Find the bottleneck

One thing is usually most of the time. Find it before touching anything. Common waste, and the safe fix for each:

**Builds, renders, tests, loops**

| Waste | Sign | Fix |
| --- | --- | --- |
| Serial work on idle cores | CPU use near 1 core | Split into N workers, N about cores minus 2. Separate processes, not tabs or pages inside one process. First find what the workers share: one GPU flattens at 2-4 processes, so does one disk, and start-up bursts collide. Watch real CPU idle and load, not the worker count |
| One browser, many pages | screenshots or recordings queue up | One browser per worker. Screenshots in one browser run one after another |
| Writing files only to read them back | lots of temp frames or chunks on disk | Pipe from one step into the next (`a - \| b -`) |
| Full rebuild every time | nothing changed, same wait | Rebuild only what changed. Cache by content hash of the inputs, not by date |
| Repeated downloads or installs | the same packages or assets fetched again | Cache them; reuse the project's own cache folder |
| Flaky local server under load | timeouts, retries, random failures when parallel | Keep-alive server, a startup check before work starts, retries with a limit |
| Final-quality encoder used for drafts | slow preset on every try | A draft mode (fast preset, lower size) for looking, the final mode once at the end. The final output stays as it was |
| GPU not used | renderer on CPU while the GPU idles | Check the backend the tool picked (Blender: Metal / `--gpu-backend`; ffmpeg: hardware encoders; browsers: GPU flags) |
| Tests run serially, or all of them every time | one worker, full suite per edit | Shards or workers; run the failed and affected tests first, then the full suite once |
| Expensive work per frame | every frame recomputes the same thing | Do it once and reuse: bake SVG filters, pre-render static layers, cache measurements |
| Waiting on fixed sleeps | `sleep 5` "to be safe" | Wait for the real condition (port open, file exists, element visible) |
| Cold starts in a loop | the same tool boots hundreds of times | Start it once and feed it all the items (batch mode, a long-running worker) |

**Battery and energy**

| Waste | Sign | Fix |
| --- | --- | --- |
| CPU or GPU busy while idle | process above about 1-2% CPU with nothing happening | Find the loop that runs and stop it while there is nothing to do |
| `requestAnimationFrame` or timers running while nothing changes | callbacks keep firing on a still screen | Stop the loop when paused, hidden or settled; start it again on demand (input, data, play). When you gate a loop on a state, find EVERY place that changes that state (keyboard, API, end of media, code), not only the button |
| Polling instead of events | a timer asks "anything new?" | Use the event: file watcher, WebSocket or SSE, observer, callback. If polling must stay, make it slower and back off |
| Animations off-screen or in hidden tabs | work continues with nothing visible | Pause on `visibilitychange` and with `IntersectionObserver`; resume when visible |
| Wake-ups from intervals | many short timers, high idle wake-ups | Merge timers, lengthen them, remove the ones nobody reads |
| Oversized network refreshes | the whole list fetched again for one change | Fetch only what changed (delta, ETag / `If-None-Match`, a longer interval); stop while hidden |

**Screen and rendering**

| Waste | Sign | Fix |
| --- | --- | --- |
| Long frames | rAF deltas above the frame budget | Find which stage is long (script, layout, paint) and fix that stage only |
| Layout thrash | layout is read after a write, inside a loop | Read everything first, then write everything; or cache the measurement |
| Animating non-composited properties | `top` / `left` / `width` / `height` animate | Animate `transform` and `opacity` instead, with the same end positions |
| SVG filters or blur on moving or large elements | paint time jumps, WebKit worst | Bake the effect into an image or a static layer; move the baked result |
| Huge DOM rendered while hidden | thousands of nodes nobody sees | `content-visibility: auto`, or `display: none` when it is safe (state and scroll position kept) |
| Images decoded at the wrong size | a 4000 px image in a 200 px box | Serve or pre-scale to the shown size times the pixel ratio |
| Device pixel ratio overdraw | canvas or video rendered at 3x where 2x looks the same | Cap the ratio for the heavy layer only, if a pixel diff at the shown size stays inside the tolerance |

If the cause is not on the list, measure the stages one by one until one of them is most of the time.

## 3. Propose at most 5 changes

List them cheapest and safest first. For each: what changes, the expected saving (seconds or percent, from your measurement), and the risk. Example:

1. Run the 40 renders in 8 processes instead of 1: about 6m to about 1m. Risk: memory, check peak.
2. Pipe frames into the encoder instead of writing PNGs: about 40 s saved. Risk: none for output.

If one change is clearly most of the gain, do that one and stop.

## 4. Apply ONE change at a time

- Put it in a copy, a new file or a new flag (`render-fast.sh`, `--workers 8`). The old command keeps working unchanged.
- One change, then measure. Two changes at once and you don't know which one helped or which one broke the output.
- Raise parallelism in steps (2, 4, 8...) and watch memory and real load. Compare each step with the previous step, not with the baseline; stop where it no longer gets faster.
- Changing the number of workers or slices can change the output (video keyframes land elsewhere, test order shifts). Keep the old split, or prove sameness again for the new one.
- Run every trial under a time limit, about 3x the baseline. A hang counts as "output differs".
- A requested change to the output (for example `setsar=1` for square pixels) is a separate step. Do it and report it apart from the speed-up, never mixed in.

## 5. Prove the output is the same

Before keeping a change, show the result is the same as before. First know the noise floor from step 1 (the unchanged command run twice): a change is "the same" when it differs from the old output no more than the old output differs from itself. Pick what fits:

| Output | Proof |
| --- | --- |
| Files | byte compare (`cmp`, `diff -r`) or hashes (`shasum -a 256`) of old and new output. Stamped files (PNG / MP4 metadata, dates) never match by bytes: compare the decoded pixels or frames |
| Images, video, pages | pixel or frame diff at fixed times: mean difference per frame plus the share of pixels over a threshold (or PSNR), with the tolerance stated. Not the max per channel: one noisy pixel decides it |
| Code behaviour | the project's own tests: same set passes, same set fails. Timing-sensitive tests can flip under load: name that as a risk. A baseline that is already flaky is reported, not "fixed" |
| Test speed-ups | the same list of tests ran, with the same pass/fail per test |
| Energy and rendering changes | frame or pixel diff at fixed times, and the same behaviour: it still animates, updates and responds when it should |

Then the rule:

- Output differs by more than the noise floor, or the run hung or hit the time limit: undo the change. Say what the tolerance was and where it came from.
- Not faster by at least 10% or 5 seconds (or, for energy and frames, the measured number did not improve): undo the change. It is not worth the extra code. When stepping a parameter up, compare with the previous step.
- Otherwise keep it, and go to the next change.

Clean up the temp files you created, including temp folders left behind by runs you killed. Remove only what you can prove you made; list the rest in the report. Leave everything else as it was.

## 6. Report

A small table, nothing more:

| Step | Before | After | Same output proven by |
| --- | --- | --- | --- |
| Render 40 clips | 6m10s, 1 core | 58s, 8 workers | decoded frames: mean diff 0.02/255, same as two old runs |
| Idle page CPU | 14% | 0.3% | frame diff at 0/1/2 s: 0 pixels; animation still plays on hover |
| Test suite | 48s, already parallel | - | measured, nothing safe to change: left alone |

"Measured, nothing safe to change, left alone" is a valid result. So is "cause found, fix not safe, left alone": say what the cause is.

Add one line for anything tried and undone, one line for anything that needs the user's OK (a safety rule), and a separate line for any requested change to the output.
