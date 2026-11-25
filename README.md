# speedup

A Claude Code plugin that makes an agent notice slow or repeated steps and speed them up safely. It works in any project and on any task.

Two parts:

- **A skill** (`skills/speedup/SKILL.md`): the method. Measure first, find the bottleneck, propose at most 5 changes, apply one at a time, prove the output is the same, report a small table. It covers build / render / test / upload loops, battery and idle CPU, and frame rate and rendering.
- **A hook** (`hooks/speedup-hook.mjs`): times every Bash command. When one took over 60 seconds, or the same command took over 20 seconds for the 2nd time in a session, it adds one line for the agent:

  ```
  speedup: this command took 3m12s (2nd time this session). Consider the speedup skill: measure, find the bottleneck, one safe change, prove same output.
  ```

  That line is all it does. It never blocks a command, never changes one, and exits 0 on any error.

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

From a local copy, use its folder path instead of `leonidstern/speedup`.

Needs Node (any current version). No packages.

## Safety rules

The skill holds the agent to these. If a speed-up needs one of them, it stops and asks.

1. Never change what the project produces or how it behaves.
2. Never delete user data, only temp files it created itself.
3. Never touch production, deploys, shared or global config, or CI settings.
4. Never push, publish or open pull requests.
5. Never install globally or change system settings without asking. Never run `sudo` itself.
6. Never raise parallelism so high the machine becomes unusable: leave at least 2 cores, watch memory.
7. One change at a time, in a copy or behind a new flag; the old command keeps working.
8. Keep a change only if the output is proven the same (hashes, pixel or frame diff with a stated tolerance, the project's own tests) and it is faster by at least 10% or 5 seconds. Otherwise undo it.

## Tune the hook

Set these in the environment Claude Code runs in (seconds):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPEEDUP_SLOW_S` | `60` | a command slower than this gets the line |
| `SPEEDUP_REPEAT_S` | `20` | the same command slower than this, 2 or more times in a session, gets the line |

For example in `~/.claude/settings.json`: `"env": { "SPEEDUP_SLOW_S": "120" }`.

"The same command" means the first 120 characters with numbers collapsed, so `--shard=1/8` and `--shard=2/8` count as one step.

The hook keeps small files in your temp folder under `speedup-hook/` (start times and a per-session count of slow commands) and removes them after a day. It stores a shortened form of slow commands there, nothing else, and sends nothing anywhere.

## Test

```
node --test
```

## License

MIT, see [LICENSE](LICENSE).
