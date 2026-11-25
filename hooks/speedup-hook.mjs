#!/usr/bin/env node
// speedup: an advisory timer for Bash commands. No packages.
//
//   PreToolUse (Bash)          remembers when the command started, by tool_use_id
//   PostToolUse (Bash)         works out how long it took; if it was slow, or the same slow command ran again,
//   PostToolUseFailure (Bash)  adds ONE line of context that points the agent at the speedup skill
//
// It only ever adds a line. It never blocks, never changes the tool's input, and exits 0 whatever happens.
// Its files live in os.tmpdir()/speedup-hook/ and are removed after a day.
//
// Tune with env: SPEEDUP_SLOW_S (default 60) and SPEEDUP_REPEAT_S (default 20), in seconds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.tmpdir(), 'speedup-hook');
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COMMANDS = 100; // slow commands remembered per session
const KEY_LEN = 120; // a command is compared by its first characters

const seconds = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const safe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);

// "npm test -- --shard=3/8" and "npm test -- --shard=4/8" are the same step: digits collapsed, spaces squeezed.
const normalize = (command) => String(command).replace(/\s+/g, ' ').trim().slice(0, KEY_LEN).replace(/\d+/g, '0');

const took = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = String(s % 60).padStart(2, '0');
  return m < 60 ? `${m}m${rest}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m${rest}s`;
};
const nth = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const writeJson = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
};

// Only this hook's own files, only in its own folder, only when older than a day.
const prune = (now) => {
  for (const name of fs.readdirSync(DIR)) {
    if (!/^(start|session)-[A-Za-z0-9_-]+\.json(\.\d+\.tmp)?$/.test(name)) continue;
    const file = path.join(DIR, name);
    try { if (now - fs.statSync(file).mtimeMs > DAY_MS) fs.unlinkSync(file); } catch {}
  }
};

const main = () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!input || typeof input !== 'object') return;
  if (input.tool_name && input.tool_name !== 'Bash') return;
  const event = input.hook_event_name;
  const id = input.tool_use_id;
  const now = Date.now();
  const startFile = id ? path.join(DIR, `start-${safe(id)}.json`) : null;

  if (event === 'PreToolUse') {
    if (!startFile) return;
    fs.mkdirSync(DIR, { recursive: true });
    writeJson(startFile, { t: now });
    try { prune(now); } catch {}
    return;
  }
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return;

  // Claude Code's own duration_ms leaves out the wait for a permission prompt, so it wins when it is there.
  let elapsed = Number.isFinite(input.duration_ms) && input.duration_ms >= 0 ? input.duration_ms : null;
  if (startFile) {
    const start = readJson(startFile);
    try { fs.unlinkSync(startFile); } catch {}
    if (elapsed === null && start && Number.isFinite(start.t)) elapsed = now - start.t;
  }
  if (elapsed === null || elapsed < 0) return;

  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string' || !command.trim()) return;
  const slowMs = seconds('SPEEDUP_SLOW_S', 60) * 1000;
  const repeatMs = seconds('SPEEDUP_REPEAT_S', 20) * 1000;
  if (elapsed <= repeatMs && elapsed <= slowMs) return; // a fast command: nothing kept, nothing said

  // How many times this command has been slow (over the repeat threshold) in this session.
  let runs = 0;
  if (elapsed > repeatMs) {
    runs = 1;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const file = path.join(DIR, `session-${safe(input.session_id || 'unknown')}.json`);
      const history = readJson(file) || {};
      const commands = history.commands && typeof history.commands === 'object' ? history.commands : {};
      const key = normalize(command);
      const seen = commands[key] && Number.isFinite(commands[key].runs) ? commands[key].runs : 0;
      runs = seen + 1;
      commands[key] = { runs, last: now };
      const keys = Object.keys(commands);
      if (keys.length > MAX_COMMANDS) {
        keys.sort((a, b) => (commands[a].last || 0) - (commands[b].last || 0));
        for (const old of keys.slice(0, keys.length - MAX_COMMANDS)) delete commands[old];
      }
      writeJson(file, { commands });
    } catch {}
  }
  if (!(elapsed > slowMs || runs >= 2)) return;

  const again = runs >= 2 ? ` (${nth(runs)} time this session)` : '';
  const line = `speedup: this command took ${took(elapsed)}${again}. Consider the speedup skill: measure, find the bottleneck, one safe change, prove same output.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line } }) + '\n');
};

try { main(); } catch {}
process.exitCode = 0;
