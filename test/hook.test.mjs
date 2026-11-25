// Runs the real hook script the way Claude Code does: a JSON payload on stdin, the answer on stdout.
// Each test gets its own temp folder (the hook keeps its files in os.tmpdir()/speedup-hook/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'speedup-hook.mjs');

const world = (t, env = {}) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'speedup-test-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'speedup-hook');
  const run = (stdin) => {
    const clean = { ...process.env };
    delete clean.SPEEDUP_SLOW_S;
    delete clean.SPEEDUP_REPEAT_S;
    const r = spawnSync(process.execPath, [HOOK], {
      input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
      encoding: 'utf8',
      env: { ...clean, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...env },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const payload = (event, id, command, more = {}) => ({
    session_id: 'S1', hook_event_name: event, tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...more,
  });
  const pre = (id, command, more) => run(payload('PreToolUse', id, command, more));
  const post = (id, command, more) => run(payload('PostToolUse', id, command, more));
  return { tmp, dir, run, payload, pre, post };
};
const silent = (r) => {
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
};
// The one line of advice, checked for the documented PostToolUse shape.
const advice = (r, event = 'PostToolUse') => {
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(out.hookSpecificOutput.hookEventName, event);
  const line = out.hookSpecificOutput.additionalContext;
  assert.match(line, /^speedup: this command took /);
  assert.ok(!line.includes('\n'), 'one line');
  return line;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a fast command says nothing and leaves no history', (t) => {
  const w = world(t);
  silent(w.pre('t1', 'ls -la'));
  assert.deepEqual(fs.readdirSync(w.dir), ['start-t1.json']);
  silent(w.post('t1', 'ls -la'));
  assert.deepEqual(fs.readdirSync(w.dir), [], 'start file removed, no session file for a fast command');
  silent(w.post('t2', 'ls -la', { duration_ms: 1500 }));
});

test('a slow command gets one line (Claude Code\'s duration_ms)', (t) => {
  const w = world(t);
  silent(w.pre('t1', 'npm run build'));
  const line = advice(w.post('t1', 'npm run build', { duration_ms: 192000 }));
  assert.equal(line, 'speedup: this command took 3m12s. Consider the speedup skill: measure, find the bottleneck, one safe change, prove same output.');
});

test('a slow command gets one line (timed from Pre to Post)', async (t) => {
  const w = world(t, { SPEEDUP_SLOW_S: '0.2' });
  silent(w.pre('t1', 'make all'));
  await sleep(350);
  advice(w.post('t1', 'make all'));
  // No Pre seen and no duration_ms: nothing to measure, nothing said.
  silent(w.post('t-unknown', 'make all'));
});

test('the same slow command a 2nd time is called out, digits aside', (t) => {
  const w = world(t);
  silent(w.post('t1', 'npx playwright test --shard=1/8', { duration_ms: 25000 }));
  const line = advice(w.post('t2', '  npx  playwright test --shard=2/8', { duration_ms: 31000 }));
  assert.equal(line, 'speedup: this command took 31s (2nd time this session). Consider the speedup skill: measure, find the bottleneck, one safe change, prove same output.');
  assert.match(advice(w.post('t3', 'npx playwright test --shard=3/8', { duration_ms: 70000 })), /took 1m10s \(3rd time this session\)/);
  // Another command, another session, or a fast run of the same command: nothing.
  silent(w.post('t4', 'npm run build', { duration_ms: 25000 }));
  silent(w.post('t5', 'npx playwright test --shard=4/8', { duration_ms: 25000, session_id: 'S2' }));
  silent(w.post('t6', 'npx playwright test --shard=4/8', { duration_ms: 5000 }));
});

test('a failed command is timed too', (t) => {
  const w = world(t);
  const r = w.run(w.payload('PostToolUseFailure', 't1', 'npm test', { duration_ms: 95000, error: 'Exit code 1' }));
  assert.match(advice(r, 'PostToolUseFailure'), /took 1m35s\./);
});

test('thresholds come from the environment', (t) => {
  const slow = world(t, { SPEEDUP_SLOW_S: '10' });
  advice(slow.post('t1', 'cargo build', { duration_ms: 12000 }));
  const repeat = world(t, { SPEEDUP_REPEAT_S: '5', SPEEDUP_SLOW_S: 'nonsense' });
  silent(repeat.post('t1', 'cargo build', { duration_ms: 8000 }));
  assert.match(advice(repeat.post('t2', 'cargo build', { duration_ms: 8000 })), /took 8s \(2nd time/);
});

test('malformed input exits 0 silently', (t) => {
  const w = world(t);
  for (const bad of ['', 'not json', '{', 'null', '[]', '42', '"text"', '{}']) silent(w.run(bad));
  silent(w.run({ hook_event_name: 'PostToolUse' }));
  silent(w.run({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }));
  silent(w.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', duration_ms: 99999 }));
  silent(w.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 7 }, duration_ms: 99999 }));
  silent(w.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: null, duration_ms: 'long' }));
  silent(w.run({ hook_event_name: 'Stop', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'x' }, duration_ms: 99999 }));
  // Another tool is not this hook's business.
  silent(w.run({ ...w.payload('PostToolUse', 't1', 'x', { duration_ms: 99999 }), tool_name: 'Read' }));
  // An id made of path characters stays inside the hook's folder.
  silent(w.pre('../../escape', 'ls'));
  assert.deepEqual(fs.readdirSync(w.tmp), ['speedup-hook']);
  // A broken history file is not fatal either.
  fs.writeFileSync(path.join(w.dir, 'session-S1.json'), '{broken');
  advice(w.post('t9', 'npm run build', { duration_ms: 61000 }));
});

test('files older than a day are pruned, and only its own', (t) => {
  const w = world(t);
  fs.mkdirSync(w.dir, { recursive: true });
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  for (const name of ['start-old.json', 'session-old.json', 'notes.txt']) {
    fs.writeFileSync(path.join(w.dir, name), '{}');
    fs.utimesSync(path.join(w.dir, name), old, old);
  }
  fs.writeFileSync(path.join(w.dir, 'session-new.json'), '{}');
  silent(w.pre('t1', 'ls'));
  assert.deepEqual(fs.readdirSync(w.dir).sort(), ['notes.txt', 'session-new.json', 'start-t1.json']);
});
