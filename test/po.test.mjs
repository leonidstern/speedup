// node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { family } from '../skills/process-optimizer/scripts/po.mjs'

const PO = new URL('../skills/process-optimizer/scripts/po.mjs', import.meta.url).pathname
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'po-test-'))
const po = (cwd, home, ...args) => spawnSync('node', [PO, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PO_HOME: home } })
const project = () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'build.sh'), 'mkdir -p dist\nfor i in 1 2 3; do sleep 0.4; echo "part $i" > dist/$i.txt; done\n')
  return d
}
const tree = d => fs.readdirSync(d, { recursive: true }).sort().join('\n')

test('time reads a waiting command as waiting and passes the exit code on', () => {
  const d = project(), r = po(d, tmp(), 'time', '--', 'sleep 1.2')
  assert.equal(r.status, 0); assert.match(r.stdout, /mostly waiting/)
  assert.equal(po(d, tmp(), 'time', '--', 'exit 3').status, 1)
})

test('null run reports identical outputs and the cost of an unchanged rerun', () => {
  const d = project(), r = po(d, tmp(), 'null', '--out', 'dist', '--', 'sh build.sh')
  assert.match(r.stdout, /byte-identical between the two runs/)
  assert.match(r.stdout, /nothing is cached or skipped/)
})

test('null run catches output that differs between identical runs', () => {
  const d = project(); fs.appendFileSync(path.join(d, 'build.sh'), 'date +%s%N > dist/stamp.txt\n')
  assert.match(po(d, tmp(), 'null', '--out', 'dist', '--', 'sh build.sh').stdout, /NOT identical between two identical runs/)
})

test('trial keeps a change that is faster with identical output, and leaves the project alone', () => {
  const d = project(), before = tree(d), src = fs.readFileSync(path.join(d, 'build.sh'), 'utf8')
  const r = po(d, tmp(), 'trial', '--cmd', 'sh build.sh', '--out', 'dist', '--apply', `sed -i.bak 's/sleep 0.4; echo "part $i" > dist\\/$i.txt; done/(sleep 0.4; echo "part $i" > dist\\/$i.txt) \\& done; wait/' build.sh && rm build.sh.bak`)
  assert.match(r.stdout, /verdict  KEEP: output byte-identical/); assert.equal(r.status, 0)
  assert.equal(tree(d), before); assert.equal(fs.readFileSync(path.join(d, 'build.sh'), 'utf8'), src)
})

test('trial rejects a faster change whose output differs', () => {
  const d = project(), r = po(d, tmp(), 'trial', '--cmd', 'sh build.sh', '--out', 'dist', '--cmd-b', 'mkdir -p dist; echo "part 1" > dist/1.txt')
  assert.match(r.stdout, /verdict  REJECT: the output changed/); assert.equal(r.status, 1)
  assert.equal(fs.existsSync(path.join(d, 'dist')), false)
})

test('trial rejects when the check fails after the change', () => {
  const d = project(), r = po(d, tmp(), 'trial', '--cmd', 'sh build.sh', '--out', 'dist', '--apply', 'echo "touch broken" >> build.sh', '--check', 'test ! -e broken')
  assert.match(r.stdout, /REJECT: the check fails after the change/)
})

test('snap and cmp: same, then changed and missing files', () => {
  const d = project(), home = tmp(); spawnSync('sh', ['build.sh'], { cwd: d })
  po(d, home, 'snap', 'base', 'dist')
  assert.equal(po(d, home, 'cmp', 'base').status, 0)
  fs.appendFileSync(path.join(d, 'dist/1.txt'), 'x\n'); fs.rmSync(path.join(d, 'dist/2.txt'))
  const r = po(d, home, 'cmp', 'base'); assert.equal(r.status, 1)
  assert.match(r.stdout, /different   1/); assert.match(r.stdout, /only in base: 1/)
})

test('cmp ignores named noise lines and nothing else', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'a.txt'), 'built 10:01\nbody\n'); fs.writeFileSync(path.join(d, 'b.txt'), 'built 10:02\nbody\n')
  assert.equal(po(d, tmp(), 'cmp', 'a.txt', 'b.txt').status, 1)
  assert.equal(po(d, tmp(), 'cmp', 'a.txt', 'b.txt', '--ignore-line', '^built ').status, 0)
})

test('cmp treats a re-encoded picture with the same pixels as equivalent', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, () => {
  const d = tmp(), ff = (...a) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { cwd: d })
  ff('-f', 'lavfi', '-i', 'testsrc=s=64x48', '-frames:v', '1', 'a.png'); ff('-i', 'a.png', '-compression_level', '9', 'b.png'); ff('-i', 'a.png', '-vf', 'negate', 'c.png')
  assert.match(po(d, tmp(), 'cmp', 'a.png', 'b.png').stdout, /identical|equivalent/)
  assert.equal(po(d, tmp(), 'cmp', 'a.png', 'b.png').status, 0)
  assert.equal(po(d, tmp(), 'cmp', 'a.png', 'c.png').status, 1)
})

test('family groups commands the same way as the hook', () => {
  assert.equal(family('cd web && FOO=1 npm run build -- --watch'), 'npm run build')
  assert.equal(family('node film.cjs --mp4'), 'node film.cjs')
  assert.equal(family('pytest -x tests/unit'), 'pytest')
  assert.equal(family('rm -rf out && mkdir out && blender -b scene.blend -a'), 'blender')
  assert.equal(family('export X=1; for i in 1 2 3; do ./render.sh scene $i; done'), './render.sh scene')
  assert.equal(family("python3 - <<'E'\nprint(1)\nE"), 'python3 (inline script)')
  assert.equal(family("node -e \"\nconst { chromium } = require('playwright')\n\""), 'node (inline script)')
  assert.equal(family('run(){ name=$1; echo $name; }; run film'), 'run film')
  assert.equal(family('(time node tools/rec.cjs film.html out.mp4) 2>&1 | head -5'), 'node tools/rec.cjs')
  assert.equal(family('timeout 600 taskset -c 0-3 blender -b s.blend -a 2>/dev/null'), 'blender')
  assert.equal(family("cat > x.cjs <<'EOF'\nconst a = 1\nEOF\nnode x.cjs"), 'node x.cjs')
})

test('trial runs both copies at the same path, so output that embeds its folder still compares equal', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'build.sh'), 'mkdir -p dist\nsleep 0.6\npwd > dist/where.txt\n')
  const r = po(d, tmp(), 'trial', '--cmd', 'sh build.sh', '--out', 'dist', '--apply', "sed -i.bak 's/sleep 0.6/sleep 0.1/' build.sh && rm build.sh.bak")
  assert.match(r.stdout, /verdict  KEEP: output byte-identical/)
})

test('trial --fresh starts from a clean checkout: ignored build output is left behind', () => {
  const d = project(), git = (...a) => spawnSync('git', a, { cwd: d })
  fs.writeFileSync(path.join(d, '.gitignore'), 'dist/\ncache/\n'); fs.mkdirSync(path.join(d, 'cache')); fs.writeFileSync(path.join(d, 'cache/stale'), 'x')
  fs.appendFileSync(path.join(d, 'build.sh'), 'test ! -e cache/stale\n')
  git('init', '-q'); git('add', '-A')
  assert.equal(po(d, tmp(), 'trial', '--cmd', 'sh build.sh', '--out', 'dist', '--cmd-b', 'sh build.sh').status, 1)
  const r = po(d, tmp(), 'trial', '--fresh', '--cmd', 'sh build.sh', '--out', 'dist', '--cmd-b', 'sh build.sh')
  assert.match(r.stdout, /compare before ↔ after: 3 files/); assert.match(r.stdout, /NO GAIN/)
})

test('trial gives both runs one build date, and a binary difference is counted', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'build.sh'), 'mkdir -p dist\nsleep 0.5\nprintf "built %s" "${SOURCE_DATE_EPOCH:-$(date +%s%N)}" > dist/stamp\n')
  const r = po(d, tmp(), 'trial', '--cmd', 'sh build.sh', '--out', 'dist', '--apply', "sed -i.bak 's/sleep 0.5/sleep 0.1/' build.sh && rm build.sh.bak")
  assert.match(r.stdout, /verdict  KEEP/)
  fs.writeFileSync(path.join(d, 'a.bin'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])); fs.writeFileSync(path.join(d, 'b.bin'), Buffer.from([0, 1, 9, 9, 4, 5, 6, 7]))
  assert.match(po(d, tmp(), 'cmp', 'a.bin', 'b.bin').stdout, /2 of 8 bytes differ in 1 place, first at offset 2/)
})

test('time lists another copy of the same program running outside the command', () => {
  const d = tmp(), busy = 'const e=Date.now()+%d;while(Date.now()<e){}'
  const bg = spawn('node', ['-e', busy.replace('%d', '6000')], { stdio: 'ignore' })
  try {
    const r = po(d, tmp(), 'time', '--', `node -e "${busy.replace('%d', '2500')}"`)
    assert.match(r.stdout, /others   other processes used/)
    assert.match(r.stdout, /twins    1 other node process/)
  } finally { bg.kill() }
})

test('trial --noise keeps a change whose output varies no more than the unchanged command varies', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'build.sh'), 'mkdir -p dist\nsleep 0.8\necho stable > dist/a.txt\nnode -e "console.log(Math.random() < 2 ? \'run \' + process.hrtime.bigint() : \'\')" > dist/b.txt\n')
  const fast = "sed -i.bak 's/sleep 0.8/sleep 0.1/' build.sh && rm build.sh.bak"
  assert.match(po(d, tmp(), 'trial', '--cmd', 'sh build.sh', '--out', 'dist', '--apply', fast).stdout, /REJECT: the output changed/)
  const r = po(d, tmp(), 'trial', '--noise', '--cmd', 'sh build.sh', '--out', 'dist', '--apply', fast)
  assert.match(r.stdout, /already differs from itself in 1 of 2 files/)
  assert.match(r.stdout, /KEEP: output within the run-to-run noise/)
  const worse = fast + ' && echo "echo extra >> dist/a.txt" >> build.sh'
  assert.match(po(d, tmp(), 'trial', '--noise', '--cmd', 'sh build.sh', '--out', 'dist', '--apply', worse).stdout, /a\.txt: BEYOND its own noise[\s\S]*REJECT/)
})

test('trial stops a change that hangs', () => {
  const d = project(), r = po(d, tmp(), 'trial', '--cmd', 'sh build.sh', '--out', 'dist', '--cmd-b', 'sleep 30', '--timeout', '3')
  assert.match(r.stdout, /REJECT: the change hangs or runs far longer/)
})
