#!/usr/bin/env node
// po: measure a process, compare what it produces, and try a change in a copy.
// No dependencies. Node 18+. ffmpeg/ffprobe are used for picture and video compares when present.
//
//   po time   [--runs N] [--cwd DIR] -- <command>
//   po null   [--out PATH]... [--cwd DIR] -- <command>
//   po snap   <name> <path>...
//   po cmp    <a> [<b>] [--px N] [--pct P] [--ignore-line REGEX]...
//   po trial  --cmd "<command>" --out PATH... (--patch FILE | --apply "<shell>" | --cmd-b "<command>")
//             [--src DIR] [--fresh] [--noise] [--exclude PATH]... [--check "<command>"] [--runs N] [--timeout S] [--px N] [--pct P] [--ignore-line REGEX]...
//   po ledger [--session ID] [--all]
//   po clean  [--all]
//
// It never edits, moves or deletes anything outside its own scratch folder (PO_HOME, default <tmp>/process-optimizer).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'

const HOME = process.env.PO_HOME || path.join(os.tmpdir(), 'process-optimizer')
const NCPU = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
const MEDIA = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|mp4|m4v|mov|webm|mkv|avi|apng)$/i
const out = s => process.stdout.write(s + '\n')
const die = (s, code = 2) => { process.stderr.write(`po: ${s}\n`); process.exit(code) }
const secs = ms => ms < 10000 ? `${(ms / 1000).toFixed(2)} s` : ms < 600000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60000).toFixed(1)} min`
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const has = bin => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0
const sha = f => { const h = crypto.createHash('sha256'), fd = fs.openSync(f, 'r'), b = Buffer.allocUnsafe(1 << 20); let n
  while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); fs.closeSync(fd); return h.digest('hex') }

// ---------- arguments ----------
const MULTI = new Set(['out', 'exclude', 'ignore-line'])
const FLAGS = new Set(['all', 'json', 'fresh', 'noise'])
function parse(argv) {
  const o = { _: [], cmd: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { o.cmd = argv.slice(i + 1).join(' '); break }
    if (!a.startsWith('--')) { o._.push(a); continue }
    const k = a.slice(2)
    if (FLAGS.has(k)) { o[k] = true; continue }
    const v = argv[++i]; if (v === undefined) die(`--${k} needs a value`)
    if (MULTI.has(k)) (o[k] ||= []).push(v); else o[k] = v
  }
  return o
}

// ---------- running and measuring ----------
// CPU per process in the tree, read while the command runs. Exact total CPU comes from the shell's `times`.
function procTable() {
  const rows = []
  if (fs.existsSync('/proc/self/stat')) {
    for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue
      try { const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'), r = s.lastIndexOf(')'), f = s.slice(r + 2).split(' ')
        rows.push({ pid: +d, ppid: +f[1], cpu: (+f[11] + +f[12]) / 100, name: s.slice(s.indexOf('(') + 1, r) }) } catch {} }
    return rows
  }
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,time=,comm='], { encoding: 'utf8' })
  for (const line of (r.stdout || '').split('\n')) { const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/); if (!m) continue
    const t = m[3].split(/[-:]/).map(Number).reverse(), cpu = (t[0] || 0) + (t[1] || 0) * 60 + (t[2] || 0) * 3600 + (t[3] || 0) * 86400
    rows.push({ pid: +m[1], ppid: +m[2], cpu, name: path.basename(m[4].trim()) }) }
  return rows
}

// GPU busy %, where the machine tells it without extra rights: Apple GPUs through ioreg, NVIDIA through nvidia-smi.
// Returns null when no GPU can be read, so nothing is said about one.
let GPU
function gpuProbe() {
  if (GPU !== undefined) return GPU
  GPU = null
  if (process.platform === 'darwin') {
    const r = spawnSync('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { encoding: 'utf8', timeout: 3000 })
    if (/"Device Utilization %"=\d+/.test(r.stdout || '')) {
      const name = ((r.stdout.match(/"model"\s*=\s*"([^"]+)"/) || [])[1] || 'GPU').replace(/^Apple /, 'Apple ')
      GPU = { name, read: () => { const o = spawnSync('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { encoding: 'utf8', timeout: 3000 }).stdout || ''
        const v = [...o.matchAll(/"Device Utilization %"=(\d+)/g)].map(m => +m[1]); return v.length ? Math.max(...v) : null } }
    }
  } else {
    const q = () => spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu,name', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000 })
    const r = q()
    if (r.status === 0 && /\d/.test(r.stdout || '')) {
      const name = (r.stdout.split('\n')[0].split(',')[1] || 'NVIDIA GPU').trim()
      GPU = { name, read: () => { const v = (q().stdout || '').split('\n').map(l => parseInt(l, 10)).filter(n => n >= 0); return v.length ? Math.max(...v) : null } }
    }
  }
  return GPU
}

// The caller and its ancestors (this tool, the shell, the agent that started it) are not "other" load.
function ancestors(rows) {
  const byPid = new Map(rows.map(r => [r.pid, r])), out = new Set([process.pid]); let p = byPid.get(process.pid)
  while (p && p.ppid > 1 && !out.has(p.ppid)) { out.add(p.ppid); p = byPid.get(p.ppid) }
  return out
}

function runTimed(cmd, { cwd = process.cwd(), log, timeoutMs } = {}) {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32'
    const logFd = log ? fs.openSync(log, 'a') : 'ignore'
    const t0 = process.hrtime.bigint()
    const child = isWin ? spawn(cmd, { cwd, shell: true, stdio: ['ignore', logFd, logFd] })
      : spawn('sh', ['-c', `(\n${cmd}\n)\n__po=$?\ntimes >&3\nexit $__po`], { cwd, stdio: ['ignore', logFd, logFd, 'pipe'], detached: !!timeoutMs })
    let timedOut = false, killer
    if (timeoutMs && !isWin) killer = setTimeout(() => { timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000).unref() }, timeoutMs)
    let timesOut = ''; if (!isWin) child.stdio[3].on('data', d => { timesOut += d })
    const seen = new Map(), other = new Map(); let peak = 0, busySum = 0, samples = 0, mine = null
    const gpu = gpuProbe(), gpuVals = []
    const sample = () => { if (isWin) return
      const rows = procTable(), kids = new Map(); for (const r of rows) (kids.get(r.ppid) || kids.set(r.ppid, []).get(r.ppid)).push(r)
      mine ??= ancestors(rows)
      const stack = [child.pid], tree = new Set([child.pid]); let busy = 0
      while (stack.length) for (const r of kids.get(stack.pop()) || []) { stack.push(r.pid); tree.add(r.pid)
        const key = r.pid + ':' + r.name, prev = seen.get(key); if (prev && r.cpu > prev.cpu) busy++
        if (!prev || r.cpu > prev.cpu) seen.set(key, { name: r.name, cpu: r.cpu }) }
      // Everything else on the machine: first and latest CPU time per process, to see what competed during the run.
      for (const r of rows) { if (tree.has(r.pid) || mine.has(r.pid) || r.pid <= 2 || r.ppid === 2) continue
        const key = r.pid + ':' + r.name, o = other.get(key); if (o) o.last = r.cpu; else other.set(key, { name: r.name, first: r.cpu, last: r.cpu }) }
      if (gpu) { const v = gpu.read(); if (v !== null) gpuVals.push(v) }
      peak = Math.max(peak, busy); busySum += busy; samples++ }
    sample()
    const timer = setInterval(sample, 500)
    child.on('error', e => { clearInterval(timer); resolve({ wallMs: 0, code: 127, error: e.message }) })
    child.on('close', code => {
      clearInterval(timer); clearTimeout(killer); if (typeof logFd === 'number') fs.closeSync(logFd)
      const wallMs = Number(process.hrtime.bigint() - t0) / 1e6
      sample()
      const t = [...timesOut.matchAll(/(\d+)m([\d.,]+)s/g)].map(m => +m[1] * 60 + +m[2].replace(',', '.'))
      const byName = {}; for (const v of seen.values()) byName[v.name] = (byName[v.name] || 0) + v.cpu
      const sampled = Object.values(byName).reduce((a, b) => a + b, 0)
      const cpuS = t.length >= 4 ? t[2] + t[3] : sampled
      const top = Object.entries(byName).filter(([n, c]) => c >= 0.05 && n !== 'sh').sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, c]) => ({ name, cpuS: c }))
      const oth = {}; for (const v of other.values()) { const d = v.last - v.first; if (d <= 0) continue; const e = oth[v.name] ||= { n: 0, cpuS: 0 }; e.n++; e.cpuS += d }
      const othS = Object.values(oth).reduce((a, e) => a + e.cpuS, 0), wallS = wallMs / 1000
      const others = { cores: wallS > 0 ? othS / wallS : 0, top: Object.entries(oth).sort((a, b) => b[1].cpuS - a[1].cpuS).slice(0, 4).map(([name, e]) => ({ name, n: e.n, cores: e.cpuS / wallS })) }
      // Same program as this command's main work, running outside it: leftovers or parallel sessions.
      const ownNames = new Set(top.filter(x => x.cpuS >= 0.2 * cpuS).map(x => x.name))
      const twins = Object.entries(oth).filter(([n, e]) => ownNames.has(n) && e.cpuS / wallS >= 0.1).map(([name, e]) => ({ name, n: e.n, cores: e.cpuS / wallS }))
      const g = gpuVals.length ? { name: gpu.name, avg: gpuVals.reduce((a, b) => a + b, 0) / gpuVals.length, peak: Math.max(...gpuVals) } : null
      resolve({ wallMs, cpuS, cores: wallMs > 0 ? cpuS / (wallMs / 1000) : 0, code: timedOut ? 124 : code ?? 1, timedOut, top, peak, exact: t.length >= 4, gpu: g, others, twins })
    })
  })
}

function reading(r) {
  const c = r.cores, idle = NCPU - 1
  if (r.wallMs < 1000) return 'too short to read; time a longer or repeated run'
  const oc = r.others?.cores ?? 0
  if (oc >= NCPU * 0.5 && c + oc >= NCPU * 0.8) return `the machine was saturated by other processes (${oc.toFixed(1)} of ${NCPU} cores, listed under others): this command got only ${c.toFixed(1)} cores, so this time says little about the command itself. Measure again when the machine is quiet`
  if (c < 0.5) return `mostly waiting (${c.toFixed(2)} cores busy): look for sleeps, fixed waits, timeouts, serial network or disk requests, or a process that idles before exiting`
  if (c < 1.3) return NCPU > 1 ? `one core busy while ${idle} sit idle: serial CPU work. Candidates: skip unchanged work, cache, or split into parallel workers` : 'one core busy on a one-core machine: only less work will help'
  if (c >= NCPU * 0.75) return `all ${NCPU} cores busy: more workers will not help; only doing less work will (skip, cache, cheaper settings)`
  return `partly parallel (${c.toFixed(1)} of ${NCPU} cores): find the serial stretch, usually setup, a single-threaded step or a final join`
}

// What the machine was doing besides the command: the GPU, and other processes competing for the cores.
function machineLines(r, indent = '  ') {
  const L = []
  if (r.gpu && r.wallMs >= 1000) {
    if (r.gpu.peak < 10 && r.cores >= 0.5) L.push(`${indent}gpu      ${r.gpu.name} idle during the run (peak ${r.gpu.peak}%) while ${r.cores.toFixed(1)} cores worked. If this work can run on the GPU (rendering, encoding, image or ML work), check which device the tool actually used: headless and batch runs often fall back to the CPU`)
    else L.push(`${indent}gpu      ${r.gpu.name} ${Math.round(r.gpu.avg)}% busy on average, peak ${r.gpu.peak}%${r.gpu.avg >= 80 ? ': the GPU is the bottleneck; more CPU workers will not help, fewer or cheaper GPU passes will' : ''}`)
  }
  if (r.others && r.others.cores >= 0.3) {
    const list = r.others.top.filter(x => x.cores >= 0.05).map(x => `${x.name}${x.n > 1 ? ' ×' + x.n : ''} ${x.cores.toFixed(1)}`).join(', ')
    L.push(`${indent}others   other processes used ${r.others.cores.toFixed(1)} of ${NCPU} cores during the run${list ? ': ' + list : ''}. Timings are skewed while they run${r.others.cores >= NCPU * 0.25 ? ', and they take cores this work could use' : ''}`)
  }
  for (const t of r.twins || []) L.push(`${indent}twins    ${t.n} other ${t.name} process${t.n > 1 ? 'es' : ''} (${t.cores.toFixed(1)} cores) ran at the same time outside this command: a leftover run or another session doing the same work? Tell the user; do not stop processes you did not start`)
  return L
}

const logFile = tag => { fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true }); return path.join(HOME, 'logs', `${tag}-${Date.now()}.log`) }
const tail = (f, n = 15) => { try { return fs.readFileSync(f, 'utf8').trimEnd().split('\n').slice(-n).map(l => '    ' + l).join('\n') } catch { return '' } }

async function cmdTime(o) {
  if (!o.cmd) die('usage: po time [--runs N] [--cwd DIR] -- <command>')
  const runs = Math.max(1, +(o.runs || 1)), cwd = path.resolve(o.cwd || '.'), log = logFile('time'), rs = []
  for (let i = 0; i < runs; i++) { const r = await runTimed(o.cmd, { cwd, log }); rs.push(r); if (r.code !== 0) break }
  const last = rs.at(-1), walls = rs.map(r => r.wallMs), mid = rs.find(r => r.wallMs === median(walls)) || last
  if (o.json) return out(JSON.stringify({ command: o.cmd, cwd, runs: rs, ncpu: NCPU }))
  out(`time: ${o.cmd}`)
  out(`  wall     ${secs(median(walls))}${runs > 1 ? `   (median of ${rs.length}: ${walls.map(w => (w / 1000).toFixed(1)).join(' ')}; first run may include cold caches)` : ''}`)
  out(`  cpu      ${mid.cpuS.toFixed(1)} s = ${mid.cores.toFixed(2)} of ${NCPU} cores${mid.exact ? '' : ' (sampled)'}`)
  out(`  reading  ${reading(mid)}`)
  if (mid.top.length) out(`  where    ${mid.top.map(t => `${t.name} ${t.cpuS.toFixed(1)} s`).join(' · ')}${mid.peak > 1 ? `   (up to ${mid.peak} busy processes at once)` : ''}`)
  for (const l of machineLines(mid)) out(l)
  out(`  exit     ${last.code}${last.code ? '   last output:\n' + tail(log) : ''}`)
  out(`  log      ${log}`)
  process.exit(last.code ? 1 : 0)
}

// ---------- trees, snapshots, compare ----------
function walk(root) {
  const files = {}; const st = fs.statSync(root)
  if (st.isFile()) { files[path.basename(root)] = root; return files }
  const go = (dir, rel) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) go(p, r); else if (e.isFile()) files[r] = p } }
  go(root, ''); return files
}
// A tree is { label, files: { relative path: absolute path } }. Several roots are keyed by their own relative path.
function treeOf(roots, base, label) {
  const files = {}
  for (const r of roots) { const abs = path.resolve(base, r); if (!fs.existsSync(abs)) continue
    const w = walk(abs), isFile = fs.statSync(abs).isFile()
    for (const [rel, p] of Object.entries(w)) files[isFile ? r : (r === '.' ? rel : r.replace(/\/+$/, '') + '/' + rel)] = p }
  return { label, files }
}
const snapDir = name => path.join(HOME, 'snap', crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 10), name)

function copyTree(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const tryCp = args => spawnSync('cp', args, { stdio: 'ignore' }).status === 0
  if (process.platform === 'darwin' && (tryCp(['-cRp', src, dst]) || tryCp(['-Rp', src, dst]))) return
  if (process.platform === 'linux' && tryCp(['-a', '--reflink=auto', src, dst])) return
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
}

function cmdSnap(o) {
  const [name, ...roots] = o._; if (!name || !roots.length) die('usage: po snap <name> <path>...')
  const dir = snapDir(name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  let n = 0, bytes = 0; const kept = []
  for (const r of roots) { const abs = path.resolve(r); if (!fs.existsSync(abs)) die(`no such path: ${r}`)
    const rel = path.relative(process.cwd(), abs); if (rel.startsWith('..')) die(`${r} is outside the current folder`)
    copyTree(abs, path.join(dir, 'files', rel || '.')); kept.push(rel || '.') }
  const t = treeOf(kept, path.join(dir, 'files'), name)
  for (const p of Object.values(t.files)) { n++; bytes += fs.statSync(p).size }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ cwd: process.cwd(), roots: kept, at: new Date().toISOString() }))
  out(`snap ${name}: ${n} files, ${(bytes / 1e6).toFixed(1)} MB kept in ${dir}`)
}

function ff(args, opts = {}) { return spawnSync('ffmpeg', ['-v', 'error', '-nostdin', ...args], { maxBuffer: 1 << 30, ...opts }) }
function probe(f) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { encoding: 'utf8' })
  const m = (r.stdout || '').trim().match(/^(\d+),(\d+)/); return m ? { w: +m[1], h: +m[2] } : null
}
let FF; const haveFf = () => FF ??= has('ffmpeg') && has('ffprobe')
function mediaCompare(a, b, tol) {
  const pa = probe(a), pb = probe(b); if (!pa || !pb) return null
  if (pa.w !== pb.w || pa.h !== pb.h) return { same: false, note: `size ${pa.w}x${pa.h} vs ${pb.w}x${pb.h}` }
  const md5 = f => (ff(['-i', f, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout || '').split('\n').filter(l => l && l[0] !== '#').map(l => l.split(',').pop().trim())
  const ma = md5(a), mb = md5(b)
  if (!ma.length || !mb.length) return null
  if (ma.length !== mb.length) return { same: false, note: `${ma.length} frames vs ${mb.length}` }
  const diff = ma.map((m, i) => m === mb[i] ? -1 : i).filter(i => i >= 0)
  if (!diff.length) return { same: true, dist: 0, note: ma.length > 1 ? `all ${ma.length} decoded frames identical, bytes differ` : 'decoded pixels identical, bytes differ' }
  // rank differing frames by mean squared error, then measure the worst one pixel by pixel
  let worst = diff[0], top = -1
  { const r = ff(['-i', a, '-i', b, '-lavfi', '[0:v:0][1:v:0]psnr=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8' })
    for (const m of (r.stdout || '').matchAll(/n:(\d+) mse_avg:([\d.]+)/g)) if (+m[2] > top) { top = +m[2]; worst = +m[1] - 1 } }
  const psnr = top > 0 ? 10 * Math.log10(255 * 255 / top) : Infinity, dB = Number.isFinite(psnr) ? `, ${psnr.toFixed(1)} dB PSNR` : ''
  const raw = f => ff(['-i', f, '-map', '0:v:0', '-vf', `select=eq(n\\,${worst})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout
  const ra = raw(a), rb = raw(b); if (!ra || !rb || ra.length !== rb.length || !ra.length) return { same: false, dist: Math.max(top, 1e-9), media: true, note: `${diff.length} of ${ma.length} frames differ${dB}` }
  let max = 0, over = 0; const px = ra.length / 3
  for (let i = 0; i < ra.length; i += 3) { const d = Math.max(Math.abs(ra[i] - rb[i]), Math.abs(ra[i + 1] - rb[i + 1]), Math.abs(ra[i + 2] - rb[i + 2])); if (d > max) max = d; if (d > tol.px) over++ }
  const pct = over / px * 100, ok = (tol.px > 0 || tol.pct > 0) && pct <= tol.pct
  const what = ma.length > 1 ? `${diff.length} of ${ma.length} frames differ; worst frame ${worst}: ` : ''
  return { same: ok, dist: Math.max(top, 1e-9), media: true, note: `${what}largest channel difference ${max} of 255, ${pct.toFixed(pct < 0.1 ? 4 : 2)}% of pixels differ by more than ${tol.px}${dB}${ok ? ' (within tolerance)' : ''}` }
}
function textCompare(a, b, ignore) {
  const sa = fs.statSync(a).size, sb = fs.statSync(b).size; if (sa > 16e6 || sb > 16e6) return null
  const ba = fs.readFileSync(a), bb = fs.readFileSync(b); if (ba.subarray(0, 8192).includes(0) || bb.subarray(0, 8192).includes(0)) return null
  const keep = l => !ignore.some(re => re.test(l)), la = ba.toString('utf8').split('\n'), lb = bb.toString('utf8').split('\n')
  const fa = la.filter(keep), fb = lb.filter(keep); let n = 0, first = -1
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) if (fa[i] !== fb[i]) { n++; if (first < 0) first = i }
  if (!n) return { same: true, dist: 0, note: `identical after ignoring ${la.length - fa.length} matching lines` }
  const cut = s => s === undefined ? '(no line)' : s.length > 90 ? s.slice(0, 90) + '…' : s
  return { same: false, dist: n, note: `${n} lines differ, first at line ${first + 1}:\n        - ${cut(fa[first])}\n        + ${cut(fb[first])}` }
}
// Same-size binaries: how many bytes differ and in how many places. A few bytes in one or two places is usually an embedded date, id or path.
function binaryNote(a, b) { return binaryDiff(a, b).note }
function binaryDiff(a, b) {
  const sa = fs.statSync(a).size, sb = fs.statSync(b).size
  if (sa !== sb) return { dist: Infinity, note: `binary, ${sa} vs ${sb} bytes` }
  const fa = fs.openSync(a, 'r'), fb = fs.openSync(b, 'r'), ba = Buffer.allocUnsafe(1 << 20), bb = Buffer.allocUnsafe(1 << 20)
  let n, pos = 0, bytes = 0, places = 0, last = -100, first = -1
  while ((n = fs.readSync(fa, ba, 0, ba.length, null)) > 0) { fs.readSync(fb, bb, 0, n, null)
    if (ba.compare(bb, 0, n, 0, n) !== 0) for (let i = 0; i < n; i++) if (ba[i] !== bb[i]) { bytes++; if (pos + i - last > 16) places++; last = pos + i; if (first < 0) first = pos + i }
    pos += n }
  fs.closeSync(fa); fs.closeSync(fb)
  return { dist: bytes, note: `binary, ${bytes} of ${sa} bytes differ in ${places} place${places === 1 ? '' : 's'}, first at offset ${first}${bytes <= 64 ? ': looks like an embedded date, id or path' : ''}` }
}
function compareTrees(A, B, tol, ignore) {
  const rels = [...new Set([...Object.keys(A.files), ...Object.keys(B.files)])].sort()
  const res = { identical: 0, equivalent: [], different: [], onlyA: [], onlyB: [], total: rels.length }
  for (const r of rels) { const a = A.files[r], b = B.files[r]
    if (!b) { res.onlyA.push(r); continue } if (!a) { res.onlyB.push(r); continue }
    if (fs.statSync(a).size === fs.statSync(b).size && sha(a) === sha(b)) { res.identical++; continue }
    let d = MEDIA.test(r) && haveFf() ? mediaCompare(a, b, tol) : null
    d ??= textCompare(a, b, ignore)
    if (!d) { const bd = binaryDiff(a, b); d = { same: false, dist: bd.dist, note: bd.note + (MEDIA.test(r) && !haveFf() ? ' (install ffmpeg to compare pixels)' : '') } }
    ;(d.same ? res.equivalent : res.different).push({ file: r, note: d.note, dist: d.dist ?? Infinity, media: !!d.media }) }
  res.verdict = res.different.length || res.onlyA.length || res.onlyB.length ? 'DIFFERENT' : res.equivalent.length ? 'EQUIVALENT' : res.total ? 'SAME' : 'EMPTY'
  return res
}
function printCompare(res, A, B, indent = '') {
  const p = s => out(indent + s), list = (xs, f) => { xs.slice(0, 12).forEach(x => p('    ' + f(x))); if (xs.length > 12) p(`    … and ${xs.length - 12} more`) }
  p(`compare ${A.label} ↔ ${B.label}: ${res.total} files`)
  p(`  identical   ${res.identical}`)
  if (res.equivalent.length) { p(`  equivalent  ${res.equivalent.length}`); list(res.equivalent, x => `${x.file}: ${x.note}`) }
  if (res.different.length) { p(`  different   ${res.different.length}`); list(res.different, x => `${x.file}: ${x.note}`) }
  if (res.onlyA.length) { p(`  only in ${A.label}: ${res.onlyA.length}`); list(res.onlyA, x => x) }
  if (res.onlyB.length) { p(`  only in ${B.label}: ${res.onlyB.length}`); list(res.onlyB, x => x) }
  p(`  verdict     ${res.verdict}${res.verdict === 'EMPTY' ? ' (nothing to compare: check the paths)' : ''}`)
}
const tolOf = o => ({ px: +(o.px || 0), pct: +(o.pct || 0) })
const ignoreOf = o => (o['ignore-line'] || []).map(s => new RegExp(s))
function resolveTree(arg) {
  if (fs.existsSync(arg)) return treeOf(['.'], path.resolve(arg), arg) // a file or folder on disk
  const dir = snapDir(arg); if (!fs.existsSync(dir)) die(`${arg} is neither a path nor a snapshot taken from this folder`)
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); return { ...treeOf(m.roots, path.join(dir, 'files'), arg), roots: m.roots }
}
function cmdCmp(o) {
  const [a, b] = o._; if (!a) die('usage: po cmp <a> [<b>]   (a, b: snapshot name, file or folder; one argument compares a snapshot with the files now)')
  let A = resolveTree(a), B
  if (b) B = resolveTree(b)
  else { if (!A.roots) die('with one argument it must be a snapshot name'); B = treeOf(A.roots, process.cwd(), 'now') }
  if (fs.existsSync(a) && b && fs.existsSync(b) && fs.statSync(a).isFile() && fs.statSync(b).isFile()) { const k = path.basename(a); A = { label: a, files: { [k]: path.resolve(a) } }; B = { label: b, files: { [k]: path.resolve(b) } } }
  const res = compareTrees(A, B, tolOf(o), ignoreOf(o)); printCompare(res, A, B)
  process.exit(res.verdict === 'SAME' || res.verdict === 'EQUIVALENT' ? 0 : 1)
}

// ---------- null run: the same command twice with nothing changed ----------
async function cmdNull(o) {
  if (!o.cmd) die('usage: po null [--out PATH]... [--cwd DIR] -- <command>')
  const cwd = path.resolve(o.cwd || '.'), outs = o.out || [], log = logFile('null'), scratch = path.join(HOME, 'null', String(Date.now()))
  const keep = tag => { for (const r of outs) if (fs.existsSync(path.resolve(cwd, r))) copyTree(path.resolve(cwd, r), path.join(scratch, tag, r)) }
  const r1 = await runTimed(o.cmd, { cwd, log }); if (r1.code) { out(`null run: first run failed (exit ${r1.code})\n${tail(log)}`); process.exit(1) }
  keep('run1')
  const r2 = await runTimed(o.cmd, { cwd, log }); if (r2.code) { out(`null run: second run failed (exit ${r2.code})\n${tail(log)}`); process.exit(1) }
  const ratio = r2.wallMs / r1.wallMs
  out(`null run: ${o.cmd}   (same command twice, nothing changed in between)`)
  out(`  run 1    ${secs(r1.wallMs)}   ${r1.cores.toFixed(2)} of ${NCPU} cores`)
  out(`  run 2    ${secs(r2.wallMs)}   ${r2.cores.toFixed(2)} of ${NCPU} cores   (${Math.round(ratio * 100)}% of run 1)`)
  out(`  reading  ${ratio > 0.7 ? `a repeat with nothing changed still costs ${secs(r2.wallMs)}: nothing is cached or skipped. Unchanged inputs should cost close to nothing` : r2.wallMs < 1500 || ratio < 0.15 ? 'the repeat is near instant: unchanged work is already skipped' : `the repeat is faster, but ${secs(r2.wallMs)} of work still runs with nothing changed: find the step that ignores its cache`}`)
  if (outs.length) { const A = treeOf(outs, path.join(scratch, 'run1'), 'run 1'), B = treeOf(outs, cwd, 'run 2'), res = compareTrees(A, B, tolOf(o), ignoreOf(o))
    if (res.verdict === 'SAME') out(`  outputs  ${res.total} files, byte-identical between the two runs: a byte compare is a valid judge for changes`)
    else if (res.verdict === 'EMPTY') out('  outputs  none found at the --out paths')
    else { out(`  outputs  NOT identical between two identical runs. A byte compare would raise false alarms: find the cause (timestamps, random ids, unordered lists) or judge with --ignore-line / --px`); printCompare(res, A, B, '  ') } }
  fs.rmSync(scratch, { recursive: true, force: true })
}

// ---------- trial: A/B in two scratch copies ----------
// Only the files git does not ignore: what a clean checkout holds.
function copyFresh(src, dst) {
  const ls = spawnSync('git', ['-C', src, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (ls.status !== 0) die('--fresh needs the project to be a git repository')
  const files = ls.stdout.split('\0').filter(f => f && fs.existsSync(path.join(src, f)))
  fs.mkdirSync(dst, { recursive: true }); const list = dst + '.files'; fs.writeFileSync(list, files.join('\0') + '\0')
  const r = spawnSync('sh', ['-c', 'tar --null -T "$1" -cf - | tar -xf - -C "$2"', 'sh', list, dst], { cwd: src, encoding: 'utf8' })
  fs.rmSync(list, { force: true }); if (r.status !== 0) die(`could not copy the tracked files: ${r.stderr}`)
}

async function cmdTrial(o) {
  const src = path.resolve(o.src || '.'), outs = o.out || [], ways = ['patch', 'apply', 'cmd-b'].filter(k => o[k])
  if (!o.cmd || !outs.length || ways.length !== 1) die('usage: po trial --cmd "<command>" --out PATH... (--patch FILE | --apply "<shell>" | --cmd-b "<command>") [--src DIR] [--fresh] [--exclude PATH]... [--check "<command>"] [--runs N]')
  const root = path.join(HOME, 'trial', new Date().toISOString().replace(/[:.]/g, '-')), A = path.join(root, 'before'), B = path.join(root, 'after'), W = path.join(root, 'work'), log = path.join(root, 'trial.log')
  const patch = o.patch && path.resolve(o.patch); if (patch && !fs.existsSync(patch)) die(`no such patch: ${o.patch}`)
  if ((root + path.sep).startsWith(src + path.sep)) die(`the scratch folder ${HOME} is inside the project; set PO_HOME to a folder outside it`)
  out(`trial in copies of ${src}${o.fresh ? ' (clean checkout: files git ignores are left out)' : ''}\n  scratch  ${root}`)
  for (const d of [A, B]) { if (o.fresh) copyFresh(src, d); else copyTree(src, d); for (const x of o.exclude || []) fs.rmSync(path.join(d, x), { recursive: true, force: true }) }
  // One fixed build date for both runs, for the many build tools that follow the SOURCE_DATE_EPOCH convention. Only the copies see it.
  if (!process.env.SOURCE_DATE_EPOCH) process.env.SOURCE_DATE_EPOCH = String(Math.floor(Date.now() / 1000))
  const sh = (cmd, cwd) => spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' })
  // Both copies run at one and the same path, so output that embeds its build folder cannot differ for that reason.
  const at = async (dir, fn) => { fs.renameSync(dir, W); try { return await fn(W) } finally { fs.renameSync(W, dir) } }
  if (patch) { const g = spawnSync('git', ['apply', '--whitespace=nowarn', patch], { cwd: B, encoding: 'utf8' })
    if (g.status !== 0) { const p = sh(`patch -p1 < '${patch.replace(/'/g, `'\\''`)}'`, B); if (p.status !== 0) die(`the patch does not apply to the copy:\n${g.stderr || p.stdout}`, 1) } }
  if (o.apply) { const r = await at(B, w => sh(o.apply, w)); if (r.status !== 0) die(`--apply failed in the copy (exit ${r.status}):\n${(r.stdout + r.stderr).trim().split('\n').slice(-10).join('\n')}`, 1)
    const d = spawnSync('diff', ['-ruN', 'before', 'after'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    if (d.stdout) { fs.writeFileSync(path.join(root, 'change.patch'), d.stdout); out(`  change   saved as ${path.join(root, 'change.patch')} (apply to the real project with: patch -p1 < it)`) } }
  const runs = Math.max(o.noise ? 2 : 1, +(o.runs || 1)), ta = [], tb = []; let ra, rb
  const base1 = path.join(root, 'noise-run1')
  for (let i = 0; i < runs; i++) {
    ra = await at(A, w => runTimed(o.cmd, { cwd: w, log })); if (ra.code) { out(`  baseline command failed in the copy (exit ${ra.code}). If the project stores absolute paths (a build folder, a virtual environment), start the copy clean with --fresh or --exclude.\n${tail(log)}`); process.exit(1) }
    if (o.noise && i === 0) for (const r of outs) if (fs.existsSync(path.join(A, r))) copyTree(path.join(A, r), path.join(base1, r))
    // A change that hangs or runs far longer is a failure, not a long wait.
    const limit = o.timeout ? +o.timeout * 1000 : Math.max(3 * ra.wallMs, ra.wallMs + 60000)
    rb = await at(B, w => runTimed(o['cmd-b'] || o.cmd, { cwd: w, log, timeoutMs: limit }))
    if (rb.timedOut) { out(`  changed run stopped after ${secs(limit)} (the unchanged run took ${secs(ra.wallMs)})\n  verdict  REJECT: the change hangs or runs far longer`); process.exit(1) }
    if (rb.code) { out(`  changed run failed (exit ${rb.code})\n${tail(log)}\n  verdict  REJECT: the change breaks the run`); process.exit(1) }
    ta.push(ra.wallMs); tb.push(rb.wallMs) }
  const ma = median(ta), mb = median(tb), gain = 1 - mb / ma
  out(`  before   ${secs(ma)}   ${ra.cores.toFixed(2)} of ${NCPU} cores${runs > 1 ? `   (${ta.map(t => (t / 1000).toFixed(1)).join(' ')})` : ''}`)
  out(`  after    ${secs(mb)}   ${rb.cores.toFixed(2)} of ${NCPU} cores${runs > 1 ? `   (${tb.map(t => (t / 1000).toFixed(1)).join(' ')})` : ''}`)
  out(`  change   ${gain >= 0 ? `${Math.round(gain * 100)}% less time (${(ma / mb).toFixed(2)}x)` : `${Math.round(-gain * 100)}% MORE time`}`)
  for (const l of machineLines(rb).filter(l => !/^\s+gpu/.test(l) || /idle/.test(l))) out(l)
  const TA = treeOf(outs, A, 'before'), TB = treeOf(outs, B, 'after'), res = compareTrees(TA, TB, tolOf(o), ignoreOf(o)); printCompare(res, TA, TB, '  ')
  let checkOk = true
  if (o.check) { const ca = await at(A, w => sh(o.check, w)), cb = await at(B, w => sh(o.check, w)); checkOk = cb.status === 0
    out(`  check    before: exit ${ca.status} · after: exit ${cb.status}${ca.status !== 0 ? '   (the check already fails before the change: it cannot judge)' : ''}`)
    if (!checkOk) out((cb.stdout + cb.stderr).trim().split('\n').slice(-8).map(l => '    ' + l).join('\n')) }
  // --noise: the unchanged command ran twice; a difference no larger than it has from itself is not a change.
  let same = res.verdict === 'SAME' || res.verdict === 'EQUIVALENT', how = res.verdict === 'SAME' ? 'byte-identical' : 'equivalent'
  if (o.noise && !same) {
    const N1 = treeOf(outs, base1, 'before, run 1'), N2 = treeOf(outs, A, 'before, run 2'), nres = compareTrees(N1, N2, tolOf(o), ignoreOf(o))
    if (nres.verdict === 'SAME' || nres.verdict === 'EQUIVALENT') out('  noise    none: the unchanged command repeats its output exactly, so the difference above is real')
    else {
      const noiseOf = new Map(nres.different.map(x => [x.file, x]))
      out(`  noise    the unchanged command already differs from itself in ${nres.different.length} of ${nres.total} files; the change is judged against that`)
      let within = !res.onlyA.length && !res.onlyB.length
      for (const x of res.different) { const n = noiseOf.get(x.file), allowed = n ? (x.media ? n.dist * 1.5 : n.dist) : 0, ok = x.dist <= allowed
        if (!ok) within = false
        out(`    ${x.file}: ${ok ? 'within' : 'BEYOND'} its own noise${n ? ` (unchanged vs unchanged: ${n.note.split('\n')[0]})` : ' (identical between unchanged runs)'}`) }
      if (within) { same = true; how = 'within the run-to-run noise of the unchanged command' }
    }
  }
  const verdict = !same ? 'REJECT: the output changed' : !checkOk ? 'REJECT: the check fails after the change'
    : gain < 0.05 ? `NO GAIN: output unchanged but the time is within noise${runs < 3 ? ' (use --runs 3 to be sure)' : ''}` : `KEEP: output ${how}, ${Math.round(gain * 100)}% less time`
  out(`  verdict  ${verdict}`)
  out('  the real project was not touched; remove the scratch copies with: po clean')
  process.exit(verdict.startsWith('KEEP') ? 0 : 1)
}

// ---------- ledger: what the session spent its time on (written by the plugin's hook) ----------
const HEADS = /^(npm|pnpm|yarn|bun|npx|git|cargo|go|make|docker|uv|pip3?|gradle|mvn|dotnet|swift|xcodebuild|bundle|rake|mix|just|task|kubectl|terraform|gh)$/
// Split a shell command into its steps at top-level separators, leaving quoted text and heredoc bodies whole.
const shellSteps = cmd => {
  const src = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, m => m.slice(0, m.indexOf('\n')).replace(/<<-?\s*['"]?\w+['"]?/, ''))
  const out = []; let cur = '', q = '', esc = false
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
export const family = cmd => {
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
  const words = []
  for (const w of pick.split(' ')) { if (w.startsWith('-') || /^\d+$/.test(w) || /^[<>0-9]*[<>]/.test(w) || /^["'$]/.test(w)) break; words.push(w.replace(/[)}]+$/, '')); if (words.length === 3) break }
  if (words.length === 3 && !HEADS.test((words[0] || '').split('/').pop() || '')) words.length = 2
  const base = (words.join(' ') || pick.slice(0, 40)).slice(0, 60)
  return words.length === 1 && /^\S+ (-e|-c|-|--eval|-p)( |$)/.test(pick) ? `${base} (inline script)` : base
}
function cmdLedger(o) {
  const dir = path.join(os.homedir(), '.claude', 'process-optimizer', 'sessions')
  if (!fs.existsSync(dir)) die('no ledger yet: it is written by the process-optimizer plugin hook while a session runs commands', 1)
  let files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)).map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)
  const load = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
  let ls = files.map(x => load(x.f)).filter(Boolean)
  if (o.session) ls = ls.filter(l => l.session === o.session)
  else if (!o.all) { const here = ls.filter(l => l.root && (process.cwd() + '/').startsWith(l.root.replace(/\/?$/, '/'))); ls = (here.length ? here : ls).slice(0, 1) }
  if (!ls.length) die('no matching ledger', 1)
  const calls = ls.flatMap(l => l.calls || []), total = calls.reduce((a, c) => a + c.ms, 0), fam = new Map()
  for (const c of calls) { const k = family(c.cmd), e = fam.get(k) || fam.set(k, { n: 0, ms: 0, fail: 0, redo: 0, redoMs: 0, max: 0 }).get(k)
    e.n++; e.ms += c.ms; e.max = Math.max(e.max, c.ms); if (!c.ok) e.fail++; if (c.redo) { e.redo++; e.redoMs += c.ms } }
  const rows = [...fam.entries()].sort((a, b) => b[1].ms - a[1].ms)
  out(`ledger: ${calls.length} commands, ${secs(total)} in total${ls.length === 1 ? ` (session ${ls[0].session}, ${ls[0].root})` : ` across ${ls.length} sessions`}`)
  out('  time      runs  longest  command')
  for (const [k, e] of rows.slice(0, 15)) out(`  ${secs(e.ms).padEnd(9)} ${String(e.n).padEnd(5)} ${secs(e.max).padEnd(8)} ${k}${e.fail ? `   (${e.fail} failed)` : ''}${e.redo ? `   (${e.redo} reruns with nothing changed, ${secs(e.redoMs)})` : ''}`)
  const redo = calls.filter(c => c.redo), redoMs = redo.reduce((a, c) => a + c.ms, 0)
  if (redo.length) out(`  avoidable: ${redo.length} reruns of a command that had already succeeded with no file changed since, ${secs(redoMs)} (${Math.round(redoMs / total * 100)}% of the time)`)
  const rep = rows.filter(([, e]) => e.n >= 3 && e.ms >= 30000)
  if (rep.length) out(`  repeated and slow: ${rep.map(([k, e]) => `${k} (${e.n}x, ${secs(e.ms)})`).join(' · ')}: the first candidates to measure with po time and po null`)
}

// Removes scratch older than half an hour, so a trial another session is running survives; --all removes everything.
function cmdClean(o) {
  if (o.all) { fs.rmSync(HOME, { recursive: true, force: true }); return out(`removed ${HOME}`) }
  let n = 0; const old = Date.now() - 30 * 60000
  for (const kind of ['trial', 'null', 'logs', 'snap']) { const d = path.join(HOME, kind); if (!fs.existsSync(d)) continue
    for (const e of fs.readdirSync(d)) { const p = path.join(d, e); if (kind === 'snap' || fs.statSync(p).mtimeMs < old) { fs.rmSync(p, { recursive: true, force: true }); n++ } } }
  out(`removed ${n} scratch entries from ${HOME}${n ? '' : ' (newer ones are kept for 30 minutes; po clean --all removes everything)'}`)
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)
if (isMain) {
  const [sub, ...rest] = process.argv.slice(2), o = parse(rest)
  const cmds = { time: cmdTime, null: cmdNull, snap: cmdSnap, cmp: cmdCmp, trial: cmdTrial, ledger: cmdLedger, clean: cmdClean }
  if (!cmds[sub]) { out(fs.readFileSync(new URL(import.meta.url).pathname, 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(sub ? 2 : 0) }
  await cmds[sub](o)
}
