// Generation through the Claude Code CLI (`claude -p`), which runs on the user's
// Claude subscription (Pro/Max) login instead of an API key.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each run gets an empty scratch directory so no project files or CLAUDE.md are picked up.
const WORK_ROOT = path.join(os.tmpdir(), 'aid-scenario-editor');

class CliError extends Error {}

function exe(cfg) {
  return cfg.claudePath || 'claude';
}

let statusCache = null;
// { installed, loggedIn, authMethod } — cached briefly since it spawns a process.
function authStatus(cfg, { fresh = false } = {}) {
  if (!fresh && statusCache && Date.now() - statusCache.at < 30000) return Promise.resolve(statusCache.value);
  return new Promise(resolve => {
    execFile(exe(cfg), ['auth', 'status'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      let value;
      if (err && err.code === 'ENOENT') value = { installed: false, loggedIn: false };
      else {
        try {
          const j = JSON.parse(stdout);
          value = { installed: true, loggedIn: !!j.loggedIn, authMethod: j.authMethod };
        } catch {
          value = { installed: true, loggedIn: false };
        }
      }
      statusCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

function friendly(msg) {
  if (/not logged in|\/login/i.test(msg))
    return 'Claude Code is not signed in. Open a terminal, run "claude auth login", sign in with your Claude account, then try again.';
  return 'Claude Code: ' + msg;
}

// Runs one generation. `send` receives progress events; `onAbort` registers a cancel callback.
// Resolves to { result, model, usage }.
function generate(cfg, { system, user, schema }, send, onAbort) {
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(WORK_ROOT, 'run-'));
  // The system prompt can exceed Windows' command-line limit, so pass it as a file.
  const sysFile = path.join(dir, 'system.txt');
  fs.writeFileSync(sysFile, system.map(b => b.text).join('\n\n'));

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt-file', sysFile,
    '--tools', '',
    '--no-session-persistence',
    '--safe-mode',
    '--model', cfg.model,
    '--effort', cfg.effort,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(exe(cfg), args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let aborted = false;
    onAbort(() => {
      aborted = true;
      child.kill();
    });

    let out = '';
    let errText = '';
    let streamed = 0;
    let cards = 0;
    let last = 0;
    let final = null;
    let model = cfg.model;

    const onLine = line => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) model = ev.model;
      else if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta') {
        // Structured output may arrive as text or as tool input JSON, depending on the CLI version.
        const d = ev.event.delta || {};
        const chunk = d.text || d.partial_json || '';
        if (chunk) {
          streamed += chunk.length;
          cards += (chunk.match(/"value"\s*:/g) || []).length;
          const now = Date.now();
          if (now - last > 250) {
            last = now;
            send({ event: 'progress', chars: streamed, cards });
          }
        }
      } else if (ev.type === 'result') final = ev;
    };

    child.stdout.on('data', buf => {
      out += buf.toString('utf8');
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        onLine(out.slice(0, nl));
        out = out.slice(nl + 1);
      }
    });
    child.stderr.on('data', buf => (errText += buf.toString('utf8')));

    child.on('error', e => {
      cleanup();
      reject(new CliError(e.code === 'ENOENT'
        ? 'The Claude Code CLI ("claude") was not found. Install Claude Code, or switch to an API key in Settings.'
        : 'Could not start Claude Code: ' + e.message));
    });

    child.on('close', code => {
      if (out) onLine(out);
      cleanup();
      if (aborted) return reject(new CliError('Stopped.'));
      if (!final) {
        const msg = errText.trim().split('\n').slice(-3).join(' ') || `exited with code ${code}`;
        return reject(new CliError(friendly(msg)));
      }
      if (final.is_error) return reject(new CliError(friendly(String(final.result || final.subtype || 'unknown error'))));
      let result = final.structured_output;
      if (!result) {
        try {
          result = JSON.parse(String(final.result || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
        } catch {
          return reject(new CliError('Claude Code returned output that could not be read. Try again.'));
        }
      }
      resolve({ result, model, usage: final.usage || null });
    });

    child.stdin.end(user);

    function cleanup() {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  });
}

module.exports = { generate, authStatus, CliError };
