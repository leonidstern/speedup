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

Run it twice if it is cheap: the first run may be a cold cache.

**Energy and battery** (something stays busy while idle)

| What | How |
| --- | --- |
| CPU of one process while idle | macOS: `top -l 2 -pid <pid> -stats pid,command,cpu,power` (read the 2nd sample). Linux: `top -b -n 2 -p <pid>` |
| Wake-ups, energy impact | macOS: `top -l 2 -stats pid,command,cpu,idlew,power`. `powermetrics` needs sudo: only if the user allows it and runs it; never run sudo yourself |
| A page while idle | Playwright: open a CDP session, call `Performance.getMetrics` at 0 s and at 10 s with nobody touching the page; compare `TaskDuration`, `ScriptDuration`, `LayoutCount`, `RecalcStyleCount`. An idle page should add close to nothing |
| Loops that never stop | count `requestAnimationFrame` callbacks and timer fires over 10 s idle (wrap them in a test page, or use the Performance panel) |
| Network while idle | count requests and bytes over 60 s idle (Playwright `page.on('request')`, or the Network panel) |

**Screen and rendering** (frames)

| What | How |
| --- | --- |
| Frame time | in the page, record the time between `requestAnimationFrame` callbacks for a few seconds of the real interaction. Report median, 95th percentile and worst |
| Long frames | count frames over 16.7 ms (60 Hz) or 8.3 ms (120 Hz), and over 50 ms |
| Both engines | measure in Chromium AND WebKit (Playwright has both). They differ a lot on filters, blur and compositing |
| Real time | play it back at real speed, not stepped frame by frame; stepping hides dropped frames |
| What the frame was spent on | Chromium trace or Performance panel: script, style, layout, paint, composite |

## 2. Find the bottleneck

One thing is usually most of the time. Find it before touching anything. Common waste, and the safe fix for each:

**Builds, renders, tests, loops**

| Waste | Sign | Fix |
| --- | --- | --- |
| Serial work on idle cores | CPU use near 1 core | Split into N workers, N about cores minus 2. Separate processes, not tabs or pages inside one process |
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
| `requestAnimationFrame` or timers running while nothing changes | callbacks keep firing on a still screen | Stop the loop when paused, hidden or settled; start it again on demand (input, data, play) |
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
- Raise parallelism in steps (2, 4, 8...) and watch memory; stop where it no longer gets faster.

## 5. Prove the output is the same

Before keeping a change, show the result is the same as before. Pick what fits:

| Output | Proof |
| --- | --- |
| Files | byte compare (`cmp`, `diff -r`) or hashes (`shasum -a 256`) of old and new output |
| Images, video, pages | pixel or frame diff at fixed times, with the tolerance stated (for example "max 1/255 per channel", "0 pixels differ") |
| Code behaviour | the project's own tests: same set passes, same set fails |
| Test speed-ups | the same list of tests ran, with the same pass/fail per test |
| Energy and rendering changes | frame or pixel diff at fixed times, and the same behaviour: it still animates, updates and responds when it should |

Then the rule:

- Output differs: undo the change. A stated, tiny tolerance is fine only where exact bytes can't match (encoders, anti-aliasing), and say so.
- Not faster by at least 10% or 5 seconds (or, for energy and frames, the measured number did not improve): undo the change. It is not worth the extra code.
- Otherwise keep it, and go to the next change.

Clean up the temp files you created. Leave everything else as it was.

## 6. Report

A small table, nothing more:

| Step | Before | After | Same output proven by |
| --- | --- | --- | --- |
| Render 40 clips | 6m10s, 1 core | 58s, 8 workers | sha256 of all 40 files identical |
| Idle page CPU | 14% | 0.3% | frame diff at 0/1/2 s: 0 pixels; animation still plays on hover |

Add one line for anything tried and undone, and one line for anything that needs the user's OK (a safety rule).
