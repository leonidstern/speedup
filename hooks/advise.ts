// Advisory only. Times every Bash call, keeps a ledger of the session's commands, and adds at most one
// line after a call when the same work is being repeated or a command is slow. It adds one short section
// to the system prompt: a standing reminder, plus the commands earlier sessions measured as slow here.
// It never blocks, rewrites or withholds a call: on any failure of its own everything goes through untouched.
import type { Register } from 'claude-code'

const SLOW_MS = 60_000 // one run this long is worth a line
const REDO_MS = 10_000 // a repeat of unchanged work this long is worth a line
const STORE_MS = 5_000 // shorter runs are not counted across sessions
const MAX_CALLS = 400
const MAX_FAMILIES = 60
const REDO_TELL = [1, 3, 6, 10]

type Call = { t: number; cmd: string; ms: number; ok: boolean; redo?: true }
type Fam = { n: number; ms: number; next: number; at: number }
type Fams = Record<string, Record<string, Fam>>

const HEADS = /^(npm|pnpm|yarn|bun|npx|git|cargo|go|make|docker|uv|pip3?|gradle|mvn|dotnet|swift|xcodebuild|bundle|rake|mix|just|task|kubectl|terraform|gh)$/

// The same grouping as `family` in skills/process-optimizer/scripts/po.mjs: "cd x && FOO=1 npm run build -- --flag" is "npm run build",
// and a compound command is named by its first step that does real work.
// Split a shell command into its steps at top-level separators, leaving quoted text and heredoc bodies whole.
const shellSteps = (cmd: string): string[] => {
  const src = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, (m: string) => m.slice(0, m.indexOf('\n')).replace(/<<-?\s*['"]?\w+['"]?/, ''))
  const out: string[] = []; let cur = '', q = '', esc = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (esc) { cur += c; esc = false; continue }
    if (c === '\\' && q !== "'") { cur += c; esc = true; continue }
    if (q) { if (c === q) q = ''; cur += c; continue }
    if (c === '"' || c === "'") { q = c; cur += c; continue }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && n === '&') || (c === '&' && n !== '>' && src[i - 1] !== '>')) {
      out.push(cur); cur = ''; if ((c === '&' || c === '|') && n === c) i++; continue }
    cur += c
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}
const TRIVIAL = /^(cd|rm|mkdir|cp|mv|ln|export|set|unset|echo|printf|source|\.|sleep|true|false|cat|ls|touch|chmod|pushd|popd|wait|test|\[|\[\[|trap|ulimit|umask|head|tail|grep|sed|awk|wc|sort|uniq|tee|xargs|uptime|date|pwd|which|nproc|ps|df|du|free|kill|pkill|pgrep|exit|return|local|read|shift|cut|tr|basename|dirname|realpath|readlink|stat|diff|cmp|file|env)$/
export const family = (cmd: string): string => {
  let pick = '', first = ''
  for (let s of shellSteps(cmd)) {
    s = s.replace(/\s+/g, ' ')
    for (let i = 0; i < 8; i++)
      s = s.replace(/^[({!] ?/, '').replace(/^\w+ ?\(\) ?\{? ?/, '').replace(/^(do|then|else|elif|if|while|until|time|\/usr\/bin\/time|nice|sudo|exec|nohup|command|builtin) /, '')
        .replace(/^(timeout|gtimeout) (-\S+ )*\d+\w* /, '').replace(/^taskset (-\S+ )*\S+ /, '').replace(/^for \w+ in .*$/, '').replace(/^case .*$/, '')
        .replace(/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\$\([^)]*\)|\S*) ?)+/, '').trim()
    const head = s.split(' ')[0] ?? ''
    if (!first && s && !/^(done|fi|esac|#|\/\/|[)}])/.test(head)) first = s
    if (!s || !head || TRIVIAL.test(head) || /^(done|fi|esac|\)|\}|#|\/\/|[0-9]*[<>])/.test(head) || /^[)}]/.test(head)) continue
    pick = s; break
  }
  if (!pick) pick = first || cmd.trim().replace(/\s+/g, ' ')
  const words: string[] = []
  for (const w of pick.split(' ')) { if (w.startsWith('-') || /^\d+$/.test(w) || /^[<>0-9]*[<>]/.test(w) || /^["'$]/.test(w)) break; words.push(w.replace(/[)}]+$/, '')); if (words.length === 3) break }
  if (words.length === 3 && !HEADS.test((words[0] || '').split('/').pop() || '')) words.length = 2
  const base = (words.join(' ') || pick.slice(0, 40)).slice(0, 60)
  return words.length === 1 && /^\S+ (-e|-c|-|--eval|-p)( |$)/.test(pick) ? `${base} (inline script)` : base
}

const span = (ms: number): string =>
  ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`

const STANDING =
  'Before a command that takes more than a few seconds, run the narrowest version that answers the question at hand (one test, one file, one frame, a dry run), and do not rerun a command that already succeeded when nothing it reads has changed. Keep full runs for the end.'
const KNOWN_MS = 30_000 // a command family this slow on average is worth naming up front
const KNOWN_DAYS = 30

export const register: Register = on => {
  // What earlier sessions measured in this project, said once in the system prompt, so the cost is known before the command runs.
  on('prompt.compose', async ($, e, next) => {
    const base = await next(e)
    try {
      if ((await $.env.get('PROCESS_OPTIMIZER_QUIET')) === '1') return base
      const root = await $.session.root()
      const now = await $.clock.now()
      const fams = (((await $.store.get('families')) ?? {}) as Fams)[root] ?? {}
      const slow = Object.entries(fams)
        .filter(([, f]) => f.ms / f.n >= KNOWN_MS && now - f.at < KNOWN_DAYS * 86_400_000)
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 5)
        .map(([k, f]) => `\`${k}\` about ${span(f.ms / f.n)} (${f.n} run${f.n === 1 ? '' : 's'})`)
      const known = slow.length > 0 ? ` Slow commands measured here in earlier sessions: ${slow.join('; ')}.` : ''
      return { sections: [...base.sections, { id: 'process-optimizer:costs', text: STANDING + known, scope: 'session' as const }] }
    } catch {
      return base
    }
  }).catch((_, e, next) => next(e))

  const calls: Call[] = []
  const lastOk = new Map<string, { edits: number; t: number; redos: number }>()
  let edits = 0
  let ledger: { path: string; session: string; root: string } | undefined

  // A file edit means the next run of a command is not a repeat of the same work.
  on('tool.call', { tool: 'Edit' }, async (_, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) edits++
    return ran
  }).catch((_, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async (_, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) edits++
    return ran
  }).catch((_, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async (_, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) edits++
    return ran
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const t0 = await $.clock.now().catch(() => 0)
    const ran = await next(e)
    try {
      if (t0 === 0 || ran.deny !== undefined || e.run_in_background === true) return ran
      const t1 = await $.clock.now()
      const ms = t1 - t0
      const ok = ran.isError !== true
      const cmd = e.command.trim()
      const prev = lastOk.get(cmd)
      const isRedo = ok && ms >= REDO_MS && prev !== undefined && prev.edits === edits
      let line: string | undefined

      if (isRedo) {
        prev.redos++
        if (REDO_TELL.includes(prev.redos))
          line = `this exact command already succeeded ${span(t0 - prev.t)} ago and no file was edited since, so this run repeated ${span(ms)} of work. Reuse the earlier result unless you were waiting on something outside the files.`
      }
      // A command that may have changed files counts as an edit for every other command.
      if (ran.isReadOnly !== true) edits++
      if (ok) lastOk.set(cmd, { edits, t: t1, redos: prev?.redos ?? 0 })
      else lastOk.delete(cmd)

      if (ms >= 1000 || isRedo) {
        calls.push({ t: t1, cmd: cmd.slice(0, 400), ms, ok, ...(isRedo ? { redo: true as const } : {}) })
        if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS)
      }

      const root = await $.session.root()
      if (ms >= STORE_MS) {
        const all = ((await $.store.get('families')) ?? {}) as Fams
        const fams = (all[root] ??= {})
        const key = family(cmd)
        const f = (fams[key] ??= { n: 0, ms: 0, next: SLOW_MS, at: 0 })
        f.n++
        f.ms += ms
        f.at = t1
        if (line === undefined && f.ms >= f.next && (ms >= SLOW_MS || f.n >= 3)) {
          line =
            f.n === 1
              ? `this command took ${span(ms)}. If it will run again, use the process-optimizer skill to measure it and cut the time with the output proven unchanged, or run a narrower command that answers the same question.`
              : `"${key}" has now run ${f.n} times here for ${span(f.ms)} in total (this run ${span(ms)}). Use the process-optimizer skill to measure it and cut the time with the output proven unchanged, or run a narrower command that answers the same question.`
          f.next = f.ms * 2
        }
        const keys = Object.keys(fams)
        if (keys.length > MAX_FAMILIES)
          for (const k of keys.sort((a, b) => (fams[a]?.at ?? 0) - (fams[b]?.at ?? 0)).slice(0, keys.length - MAX_FAMILIES)) delete fams[k]
        await $.store.set('families', all)
      }

      if (ms >= 1000 || isRedo) {
        if (ledger === undefined) {
          const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
          const session = await $.session.id()
          if (home !== undefined) ledger = { path: `${home}/.claude/process-optimizer/sessions/${session}.json`, session, root }
        }
        if (ledger !== undefined)
          await $.fs.write(ledger.path, JSON.stringify({ session: ledger.session, root: ledger.root, calls }))
      }

      if (line === undefined || (await $.env.get('PROCESS_OPTIMIZER_QUIET')) === '1') return ran
      return { ...ran, context: [...(ran.context ?? []), `${$.plugin.name}: ${line}`] }
    } catch {
      return ran
    }
  }).catch((_, e, next) => next(e))
}
