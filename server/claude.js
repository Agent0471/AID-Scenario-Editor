// Claude access: settings storage and the generate call.
// Two providers:
//   'claude-code' — the Claude Code CLI, using the user's Claude subscription (Pro/Max) login.
//   'api'         — the Anthropic API with an API key (billed per use).
const fs = require('fs');
const path = require('path');
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const prompts = require('./prompts');
const claudeCode = require('./claude-code');

const CONFIG_FILE = path.join(__dirname, '..', 'config.local.json');
const PROVIDERS = ['claude-code', 'api'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULTS = { model: 'claude-opus-5-5', effort: 'medium', fallbacks: true };

class UserError extends Error {}

function readConfig() {
  let cfg;
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    cfg = { ...DEFAULTS };
  }
  // Without an explicit choice, use an API key if one exists, else the subscription.
  if (!PROVIDERS.includes(cfg.provider)) cfg.provider = keySource(cfg) ? 'api' : 'claude-code';
  return cfg;
}

function keySource(cfg) {
  if (cfg.apiKey) return 'saved';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'environment';
  return null;
}

// Never returns the key itself.
async function status({ fresh = false } = {}) {
  const cfg = readConfig();
  const cli = cfg.provider === 'claude-code' || fresh ? await claudeCode.authStatus(cfg, { fresh }) : null;
  const ready = !!process.env.AIDE_MOCK || (cfg.provider === 'api' ? !!keySource(cfg) : !!(cli && cli.loggedIn));
  return {
    provider: cfg.provider,
    ready,
    keySource: keySource(cfg),
    cli,
    model: cfg.model,
    effort: cfg.effort,
    providers: PROVIDERS,
    models: MODELS,
    efforts: EFFORTS,
    mock: !!process.env.AIDE_MOCK,
  };
}

function saveSettings(body) {
  const cfg = readConfig();
  if (typeof body.apiKey === 'string') {
    const k = body.apiKey.trim();
    if (k) cfg.apiKey = k;
  }
  if (body.clearKey) delete cfg.apiKey;
  if (PROVIDERS.includes(body.provider)) cfg.provider = body.provider;
  if (MODELS.includes(body.model)) cfg.model = body.model;
  if (EFFORTS.includes(body.effort)) cfg.effort = body.effort;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return status({ fresh: true });
}

function describeError(e) {
  if (e instanceof UserError || e instanceof claudeCode.CliError) return e.message;
  if (e instanceof Anthropic.AuthenticationError)
    return 'Claude rejected the API key. Open Settings and check it.';
  if (e instanceof Anthropic.PermissionDeniedError)
    return 'This API key is not allowed to use the selected model. Try another model in Settings.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API. Wait a moment and try again.';
  if (e instanceof Anthropic.BadRequestError) return 'Claude API rejected the request: ' + e.message;
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your internet connection.';
  if (e instanceof Anthropic.APIError) return `Claude API error${e.status ? ' ' + e.status : ''}: ${e.message}`;
  if (e instanceof SyntaxError) return 'Claude returned output that could not be read. Try again.';
  if (e && /api key|apiKey|authentication/i.test(String(e.message)) && !keySource(readConfig()))
    return 'No Claude API key is set. Open Settings to add one, or switch to your Claude subscription.';
  return (e && e.message) || String(e);
}

// Streams progress via send({event:'progress'}), then send({event:'done'}).
// `onAbort` registers a callback that cancels the request.
async function generate(req, send, onAbort) {
  const mode = ['scenario', 'fields'].includes(req.mode) ? req.mode : 'cards';
  // Field generation can work from the cards and current scenario alone.
  if (mode !== 'fields' && !String(req.prompt || '').trim()) throw new UserError('Describe what you want Claude to write.');
  if (process.env.AIDE_MOCK) return mockGenerate(mode, req, send, onAbort);

  const cfg = readConfig();
  const built = prompts.build(mode, req);
  const out = cfg.provider === 'claude-code'
    ? await claudeCode.generate(cfg, built, send, onAbort)
    : await apiGenerate(cfg, built, send, onAbort);
  send({ event: 'done', mode, result: out.result, model: out.model, usage: out.usage });
}

async function apiGenerate(cfg, { system, user, schema }, send, onAbort) {
  const client = new Anthropic(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
  const params = {
    model: cfg.model,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  };

  const run = async withFallbacks => {
    // Server-side refusal fallback: a declined request is retried on Anthropic's recommended fallback model.
    const stream = withFallbacks
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : client.messages.stream(params);
    onAbort(() => stream.abort());
    let buf = '';
    let last = 0;
    stream.on('text', t => {
      buf += t;
      const now = Date.now();
      if (now - last > 250) {
        last = now;
        send({ event: 'progress', chars: buf.length, cards: (buf.match(/"value"\s*:/g) || []).length });
      }
    });
    return stream.finalMessage();
  };

  let msg;
  try {
    msg = await run(cfg.fallbacks);
  } catch (e) {
    // A 400 is returned before any output (nothing billed); retry once without the fallback option.
    if (!(cfg.fallbacks && e instanceof Anthropic.BadRequestError)) throw e;
    console.warn('[generate] retrying without fallbacks:', e.message);
    msg = await run(false);
  }
  if (msg.stop_reason === 'refusal') {
    const why = msg.stop_details && msg.stop_details.explanation;
    throw new UserError('Claude declined this request' + (why ? ': ' + why : '.'));
  }
  if (msg.stop_reason === 'max_tokens')
    throw new UserError('The output hit the length limit before finishing. Ask for fewer cards at once.');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { result: JSON.parse(text), model: msg.model, usage: msg.usage };
}

// Canned output for testing the UI without spending tokens (AIDE_MOCK=1).
async function mockGenerate(mode, req, send, onAbort) {
  let aborted = false;
  onAbort(() => (aborted = true));
  const n = Math.max(1, parseInt(req.count, 10) || 3);
  const cards = Array.from({ length: n }, (_, i) => ({
    title: `Mock Card ${i + 1}`,
    type: req.type || 'character',
    keys: `mock ${i + 1}, mockery`,
    value: `Mock Card ${i + 1} is a placeholder generated for: ${String(req.prompt).slice(0, 120)}`,
    description: 'Generated in mock mode',
  }));
  for (let i = 1; i <= 6; i++) {
    if (aborted) return;
    await new Promise(r => setTimeout(r, 300));
    send({ event: 'progress', chars: i * 400, cards: Math.round((n * i) / 6) });
  }
  if (mode === 'fields') {
    const fields = prompts.build('fields', req) && req.fields;
    const result = { notes: `Mock notes. Model: ${req.aidModel || 'any'}, player: ${req.player}, cards seen: ${(req.cards || []).length}.` };
    for (const f of fields) result[f] = `Mock ${f} (${req.revise ? 'revised' : 'fresh'})` + (req.prompt ? ` for: ${req.prompt}` : '');
    return send({ event: 'done', mode, result, model: 'mock', usage: null });
  }
  const result =
    mode === 'scenario'
      ? {
          title: 'Mock Scenario',
          description: 'A mock scenario for testing.',
          tags: 'mock, test',
          plotEssentials: 'You are testing the editor.',
          cards,
          opening: 'You stand in a mock world, waiting for something to happen.',
          aiInstructions: 'The user would like you to tell a story.\n- Write in second person, present tense',
          authorsNote: 'Tone: light, playful.',
        }
      : { cards };
  send({ event: 'done', mode, result, model: 'mock', usage: null });
}

module.exports = { status, saveSettings, generate, describeError };
