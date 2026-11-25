# speedup

Make slow, repeated or wasteful work faster or cheaper **without changing what it produces**.

A plugin for Claude Code with three parts:

- **A skill**, `process-optimizer` (`skills/process-optimizer`), that gives the method: name the cost and the result that must not change, measure, find the biggest part, change one thing in a copy, prove the result is the same, keep or reject, report before and after. It works for builds, test suites, renders, exports, data jobs, interactive frame time, and budgets you cannot run (energy per use, cost per request).
- **A tool**, `po`, that does the measuring and the proving. No dependencies, Node 18+.
- **An advisory hook** that times the commands a session runs, adds one line when a command is slow, keeps adding up, or was rerun with nothing changed, and tells each new session which commands were slow here before. It never blocks or changes a command.

## Why it is safe

- Every claim needs a number before and after.
- The result is the judge: outputs are compared byte for byte, then pixel by pixel for pictures and video, or by the project's own tests. A change that alters the result is rejected, or put to you as a trade-off.
- Changes are tried in scratch copies. `po` writes only to its own folder (`PO_HOME`, default `<tmp>/process-optimizer`) and never edits, moves or deletes your files.
- Nothing outside the copy: no production, deploys, pushes, paid resources or global settings.

## Install

In Claude Code:

```
/plugin marketplace add leonidstern/speedup
/plugin install speedup@speedup
```

Or from a terminal:

```
claude plugin marketplace add leonidstern/speedup
claude plugin install speedup@speedup
```

Only the skill: copy `skills/process-optimizer` into `~/.claude/skills/` (or a project's `.claude/skills/`). The skill and `po` work without the hook.

## Use

Ask for it in your own words: "the build is slow, make it faster", "optimize the test run", "cut the battery use of this design". Or let the hook point at a slow or repeated command.

`po` on its own:

```
node skills/process-optimizer/scripts/po.mjs time -- npm run build
```
```
time: npm run build
  wall     41.2 s
  cpu      40.6 s = 0.99 of 8 cores
  reading  one core busy while 7 sit idle: serial CPU work. Candidates: skip unchanged work, cache, or split into parallel workers
  where    node 38.9 s · esbuild 1.4 s
```

```
po null --out dist -- npm run build
```
Runs the command twice with nothing changed. Tells you what an unchanged rerun costs, and whether the outputs are identical between runs, which decides if a byte compare can be the judge.

```
po trial --cmd "npm run build" --out dist --patch faster.patch
```
```
trial in copies of /work/app
  before   41.2 s   0.99 of 8 cores
  after    13.0 s   3.41 of 8 cores
  change   68% less time (3.17x)
  compare before ↔ after: 214 files
    identical   214
    verdict     SAME
  verdict  KEEP: output byte-identical, 68% less time
  the real project was not touched; remove the scratch copies with: po clean
```

| Command | What it does |
| --- | --- |
| `po time [--runs N] -- <command>` | Wall time, CPU time, cores used, which processes, and a reading of what that means |
| `po null [--out PATH]... -- <command>` | The same command twice: cost of an unchanged rerun, and whether outputs are deterministic |
| `po snap <name> <path>...` | Keep a copy of outputs to compare against later |
| `po cmp <a> [<b>]` | Compare snapshots, files or folders: bytes first, then decoded pixels (needs ffmpeg) or text lines |
| `po trial --cmd ... --out ... (--patch F \| --apply "sh" \| --cmd-b "cmd")` | Before and after in two scratch copies run at the same path, compared, with a verdict. `--fresh` starts from a clean checkout |
| `po ledger` | What the session spent its time on, and which reruns were avoidable (needs the hook) |
| `po clean [--all]` | Remove scratch older than 30 minutes, or all of it |

`--noise` runs the unchanged command twice and accepts a change whose output differs no more than the unchanged command differs from itself (renderers and recorders that never repeat exactly). A changed run that takes three times longer is stopped and rejected (`--timeout S` to set the limit). Compare options: `--ignore-line REGEX` drops known noise lines such as timestamps; `--px N --pct P` accepts pictures where at most P% of pixels differ by more than N levels. `--check "<command>"` on a trial also requires that command to pass after the change.

## The hook

After a Bash command the hook may add one line that only the model reads:

- the command took over a minute;
- the same kind of command has run three or more times and keeps adding up (it backs off: 1 min, then 2, 4, 8 in total);
- the exact command had already succeeded and no file was edited since.

It also adds one short section to the system prompt: a standing reminder to run the narrowest command that answers the question and not to rerun unchanged work, followed by the commands earlier sessions measured as slow in this project (`node build.js about 94 s (12 runs)`), so the cost is known before the command runs.

Set `PROCESS_OPTIMIZER_QUIET=1` to keep the ledger and drop the lines and the section.

## What it stores

Nothing leaves your machine: there is no network code in the hook or in `po`.

- **Session ledger**, one JSON file per session in `~/.claude/process-optimizer/sessions/`, read by `po ledger`. For each Bash command that ran a second or more it holds the time, how long it took, whether it succeeded, and the command's first 400 characters, with anything that looks like a credential replaced by `***` (values of variables and flags named like a token, key, secret or password, Authorization headers, passwords in URLs, common token formats). Ledgers older than 30 days are deleted whenever `po` reads or cleans them; `po clean --all` deletes all of them.
- **Command timings** in Claude Code's plugin store: the short name of each command (such as `npm run build`), its run count and total time, at most 60 per project, used for the line in the system prompt.
- **Scratch copies** made by `po trial`, `po null` and `po snap` in `PO_HOME` (default `<tmp>/process-optimizer`). `po clean` removes those older than 30 minutes, `po clean --all` all of them.

## Develop

```
node --test test/po.test.mjs     # the tool
claude plugin test .             # the hook
claude plugin validate . --profile directory --strict
claude plugin eval . --model sonnet --scaffold --allow-tools Bash Write Edit   # 5 cases, with and without the plugin
```

The eval cases in `evals/` build small projects from scratch and check the result, not the wording: a serial build to speed up with the output proven identical, a render whose obvious fast flag changes the frames, a build already too fast to be worth changing, a battery budget to cut without dropping a feature, and a slow test run that should not be run twice. Last run (Sonnet, 3 runs each): 1.00 with the plugin, 0.86 without. Without it, Sonnet often skipped timing the old build, so it could not show a before and after.

## License

MIT
