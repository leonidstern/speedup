import { expect, mock, test } from 'claude-code/testing'
import { family, redact } from './advise'

type World = { clock: ReturnType<typeof mock.clock>; written: { path: string; text: string }[]; env: Record<string, string> }

// The engine beneath the plugin: a Bash call takes `took` ms and answers as given.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const world = (on: any, took: () => number, answer: () => any = () => ({ result: {} })): World => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w: World = { clock, written: [], env: { HOME: '/home/u' } }
  on('env.get', (_: unknown, e: { name: string }) => ({ value: w.env[e.name] }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => { w.written.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('tool.call', async (_: unknown, e: { tool: string }) => {
    if (e.tool !== 'Bash') return { result: {} }
    await clock.sleep(took())
    return answer()
  })
  return w
}
const bash = async ($: any, w: World, command: string, ms: number, extra: object = {}) => {
  const call = $.tool.call({ tool: 'Bash', command, ...extra })
  await w.clock.advance(ms)
  return call
}

test('a fast command gets no line and its result is untouched', async ($, on) => {
  const w = world(on, () => 300)
  const ran = await bash($, w, 'ls', 300)
  expect(ran.context).toBeUndefined()
  expect(ran.deny).toBeUndefined()
  expect(w.written.length).toBe(0)
})

test('a command over a minute gets one line, and the ledger is written', async ($, on) => {
  const w = world(on, () => 84_000)
  const ran = await bash($, w, 'cd web && npm run build', 84_000)
  expect(ran.context?.length).toBe(1)
  expect(ran.context?.[0]).toMatch(/^speedup: this command took 84 s\./)
  const last = w.written.at(-1)
  expect(last?.path).toBe('/home/u/.claude/process-optimizer/sessions/s1.json')
  const ledger = JSON.parse(last?.text ?? '{}')
  expect(ledger.root).toBe('/work/app')
  expect(ledger.calls[0].cmd).toBe('cd web && npm run build')
  expect(ledger.calls[0].ms).toBe(84_000)
})

test('the same command again with no edit in between is called a repeat', async ($, on) => {
  const w = world(on, () => 20_000)
  expect((await bash($, w, 'npm test', 20_000)).context).toBeUndefined()
  const again = await bash($, w, 'npm test', 20_000)
  expect(again.context?.[0]).toMatch(/already succeeded .* ago and no file was edited since/)
  expect(JSON.parse(w.written.at(-1)?.text ?? '{}').calls[1].redo).toBe(true)
})

test('an edit in between makes the second run legitimate', async ($, on) => {
  const w = world(on, () => 20_000)
  await bash($, w, 'npm test', 20_000)
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' })
  expect((await bash($, w, 'npm test', 20_000)).context).toBeUndefined()
})

test('a failed run is not a result to reuse', async ($, on) => {
  let isError = true
  const w = world(on, () => 20_000, () => (isError ? { result: {}, isError: true } : { result: {} }))
  await bash($, w, 'npm test', 20_000)
  isError = false
  expect((await bash($, w, 'npm test', 20_000)).context).toBeUndefined()
})

test('a command that adds up over three runs gets a line once, then backs off', async ($, on) => {
  const w = world(on, () => 25_000)
  const lines: (string | undefined)[] = []
  for (let i = 0; i < 5; i++) {
    await $.tool.call({ tool: 'Edit', file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' })
    lines.push((await bash($, w, `npm run build -- --n ${i}`, 25_000)).context?.[0])
  }
  expect(lines[0]).toBeUndefined()
  expect(lines[1]).toBeUndefined()
  expect(lines[2]).toMatch(/"npm run build" has now run 3 times here for 75 s in total/)
  expect(lines[3]).toBeUndefined()
  expect(lines[4]).toBeUndefined()
})

test('PROCESS_OPTIMIZER_QUIET=1 keeps the ledger and drops the line', async ($, on) => {
  const w = world(on, () => 94_000)
  w.env.PROCESS_OPTIMIZER_QUIET = '1'
  const ran = await bash($, w, 'make all', 94_000)
  expect(ran.context).toBeUndefined()
  expect(w.written.length).toBe(1)
})

test('a background command and a denied call are left alone', async ($, on) => {
  const w = world(on, () => 94_000)
  const bg = await bash($, w, 'npm run dev', 94_000, { run_in_background: true })
  expect(bg.context).toBeUndefined()
  expect(w.written.length).toBe(0)
})

test('a broken world beneath never breaks the call', async ($, on) => {
  const clock = mock.clock(on, { now: 5 })
  on('store.get', () => { throw new Error('store down') })
  on('session.root', () => { throw new Error('no root') })
  on('tool.call', async () => { await clock.sleep(94_000); return { result: {}, text: 'built' } })
  const call = $.tool.call({ tool: 'Bash', command: 'make' })
  await clock.advance(94_000)
  const ran = await call
  expect(ran.text).toBe('built')
  expect(ran.context).toBeUndefined()
})

test('commands group by what they run, not by their flags', () => {
  expect(family('cd web && FOO=1 npm run build -- --watch')).toBe('npm run build')
  expect(family('node film.cjs --mp4')).toBe('node film.cjs')
  expect(family('pytest -x tests/unit')).toBe('pytest')
  expect(family('./scripts/render.sh scene 12')).toBe('./scripts/render.sh scene')
  expect(family('make -j8 all')).toBe('make')
  expect(family('cargo test --release | tail -5')).toBe('cargo test')
  expect(family('rm -rf out && mkdir out && blender -b scene.blend -a')).toBe('blender')
  expect(family('export X=1; for i in 1 2 3; do ./render.sh scene $i; done')).toBe('./render.sh scene')
  expect(family("python3 - <<'E'\nprint(1)\nE")).toBe('python3 (inline script)')
  expect(family("node -e \"\nconst { chromium } = require('playwright')\n\"")).toBe('node (inline script)')
  expect(family('run(){ name=$1; echo $name; }; run film')).toBe('run film')
  expect(family('(time node tools/rec.cjs film.html out.mp4) 2>&1 | head -5')).toBe('node tools/rec.cjs')
  expect(family('timeout 600 taskset -c 0-3 blender -b s.blend -a 2>/dev/null')).toBe('blender')
  expect(family("cat > x.cjs <<'EOF'\nconst a = 1\nEOF\nnode x.cjs")).toBe('node x.cjs')
})

test('the system prompt gets one section, naming commands measured as slow earlier', async ($, on) => {
  const w = world(on, () => 84_000)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are…', scope: 'shared' }] }))
  const FACTS = { model: 'm', promptModel: 'm', surfaces: [], tools: ['Bash'], outputStyle: null, traits: [] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compose = () => ($ as any).prompt.compose(FACTS)
  const before = await compose()
  expect(before.sections.length).toBe(2)
  expect(before.sections[1]?.id).toBe('process-optimizer:costs')
  expect(before.sections[1]?.text).not.toMatch(/Slow commands measured here/)
  await bash($, w, 'node film.cjs --mp4', 84_000)
  const after = await compose()
  expect(after.sections[1]?.text).toMatch(/Slow commands measured here in earlier sessions: `node film.cjs` about 84 s \(1 run\)\./)
  w.env.PROCESS_OPTIMIZER_QUIET = '1'
  expect((await compose()).sections.length).toBe(1)
})

test('credentials never reach the ledger', () => {
  expect(redact('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx1234 npm run build')).toBe('GITHUB_TOKEN=*** npm run build')
  expect(redact("curl -H 'Authorization: Bearer abc.def.ghi1234567' https://api.x.com")).not.toMatch(/abc\.def/)
  expect(redact('mysql --password=hunter22 -u root db')).toBe('mysql --password=*** -u root db')
  expect(redact('git clone https://leo:s3cretpass@github.com/x/y')).toBe('git clone https://leo:***@github.com/x/y')
  expect(redact('deploy --api-key sk-live_0123456789abcdefABCD')).not.toMatch(/0123456789/)
  expect(redact('export OPENAI_API_KEY="sk-proj-aaaaaaaaaaaaaaaaaaaa"')).toBe('export OPENAI_API_KEY=***')
  expect(redact('npm run build -- --minify')).toBe('npm run build -- --minify')
  expect(redact('node film.cjs --mp4 && ls -la out')).toBe('node film.cjs --mp4 && ls -la out')
})
