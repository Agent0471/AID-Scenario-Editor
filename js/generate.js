// Generate with Claude: the generator dialog, settings dialog, and the streaming
// request to the local server (which holds the API key and calls Claude).
(function () {
  'use strict';
  const A = (window.AIDE = window.AIDE || {});
  const $ = s => document.querySelector(s);
  const str = v => (v == null ? '' : String(v));
  const esc = s => str(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const MODEL_NAMES = {
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'claude-fable-5-1': 'Claude Fable 5.1',
  };
  const MODEL_HINTS = {
    'claude-opus-5-5': 'recommended',
    'claude-sonnet-5-5': 'faster, cheaper',
    'claude-fable-5-1': 'most capable, most expensive',
  };
  const SCENARIO_FIELDS = [
    ['title', 'Title'],
    ['description', 'Description'],
    ['tags', 'Tags'],
    ['opening', 'Opening'],
    ['plotEssentials', 'Plot Essentials'],
    ['aiInstructions', 'AI Instructions'],
    ['authorsNote', "Author's Note"],
  ];
  // AI Dungeon models named in the AIN repository's prebuilt sets and suggested settings.
  const AID_MODELS = [
    'DeepSeek 4 Pro', 'DeepSeek 4 Flash', 'GLM 5.2', 'GLM 5.1', 'Gemma 4', 'DeepSeek 3.2', 'DeepSeek 3.1',
    'DeepSeek 3.0', 'Dynamic Deep', 'Atlas (DS 3.2 Cached)', 'Raven (GLM 4.6 Cached)', 'Wayfarer Large',
    'Harbinger', 'Hearthfire', 'Muse', 'Madness',
  ];
  const DEFAULT_FIELDS = ['plotEssentials', 'aiInstructions', 'authorsNote'];
  const PLACEHOLDERS = {
    cards:
      'e.g. "The five members of the Ashfall thieves\' guild, each with a distinct specialty and a grudge against another member"\n' +
      'or "A haunted lighthouse location card"',
    fields:
      'Optional. Steer the result, e.g. "Make combat lethal and the world indifferent", "Slow-burn romance with Helena", ' +
      '"Keep the AI from writing my character\'s dialogue", "Plot essentials should start on day one of the expedition".',
    scenario:
      'Describe the scenario: setting, premise, who the player is, tone, anything that must be included.\n\n' +
      'e.g. "Low-fantasy survival on a frozen archipelago. You are a disgraced ship\'s navigator stranded after a mutiny. Grim but with warm moments; political intrigue between three island clans."',
  };

  const st = {
    mode: 'cards',
    status: null, // server status, or null when the server is unreachable
    controller: null,
    result: null,
    resultMode: null,
    timer: 0,
  };

  // ---------- server ----------
  async function api(path, body) {
    const res = await fetch(path, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AIDE': '1' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  }

  async function refreshStatus() {
    try {
      st.status = location.protocol.startsWith('http') ? await api('/api/status') : null;
    } catch {
      st.status = null;
    }
    updateModelLabel();
    return st.status;
  }

  function updateModelLabel() {
    const s = st.status;
    $('#genModelLabel').textContent = !s
      ? 'Local server not running'
      : s.mock
        ? 'Mock mode (no API calls)'
        : `${MODEL_NAMES[s.model] || s.model} · ${s.effort} effort · ` +
          (s.provider === 'api' ? (s.keySource ? 'API key' : 'no API key set') : s.ready ? 'your Claude plan' : 'Claude Code not signed in');
  }

  function notReadyMessage(s) {
    if (s.provider === 'api') return 'No Claude API key is set yet. Click Settings to add one, or switch to your Claude subscription.';
    if (s.cli && !s.cli.installed) return 'Claude Code is not installed, so your Claude subscription can\'t be used. Click Settings to use an API key instead.';
    return 'Claude Code is not signed in yet. Open a terminal, run "claude auth login" and sign in with your Claude account. Settings has the details.';
  }

  // ---------- dialog state ----------
  function setView(view) {
    $('#genForm').hidden = view !== 'form';
    $('#genProgress').hidden = view !== 'running';
    $('#genReview').hidden = view !== 'review';
    const b = $('#genButtons');
    if (view === 'form') {
      b.innerHTML = '<button type="button" data-close>Cancel</button><button type="button" id="genGo" class="primary">✦ Generate</button>';
    } else if (view === 'running') {
      b.innerHTML = '<button type="button" id="genStop">Stop</button>';
    } else {
      b.innerHTML = '<button type="button" id="genBack">← Edit request</button><button type="button" id="genAgain">Regenerate</button><button type="button" id="genApply" class="primary"></button>';
      updateApplyButton();
    }
  }

  function setMode(mode) {
    st.mode = mode;
    for (const b of document.querySelectorAll('#genDialog .seg [data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
    for (const el of document.querySelectorAll('#genDialog [data-for]')) el.hidden = !el.dataset.for.split(' ').includes(mode);
    $('#genPromptLabel').textContent =
      mode === 'scenario' ? 'Describe the scenario' : mode === 'fields' ? 'Anything specific?' : 'What cards should Claude write?';
    $('#genPrompt').placeholder = PLACEHOLDERS[mode];
    try { localStorage.setItem('aide.genMode', mode); } catch {}
  }

  function showError(msg) {
    const el = $('#genError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function setFieldChecks(fields) {
    for (const cb of document.querySelectorAll('#genFieldChecks input')) cb.checked = fields.includes(cb.value);
  }
  const checkedFields = () => [...document.querySelectorAll('#genFieldChecks input:checked')].map(cb => cb.value);

  // opts.fields preselects scenario fields (e.g. from a field's ✦ button) and starts a fresh request.
  async function open(mode, opts = {}) {
    const dlg = $('#genDialog');
    if (mode) setMode(mode);
    if (opts.fields && !st.controller) {
      setFieldChecks(opts.fields);
      st.result = null;
      $('#genPrompt').value = '';
    } else if (mode === 'fields' && !st.controller && !st.result) {
      loadPrefs(); // back to the saved field selection after a single-field run
    }
    if (!dlg.open) {
      showError('');
      $('#genCardCount').textContent = A.cards.count();
      const sel = A.cards.selectionCount();
      $('#genSelCount').textContent = sel;
      $('#genUseExamples').disabled = sel === 0;
      if (sel === 0) $('#genUseExamples').checked = false;
      $('#genUseScenario').disabled = A.scenario.isEmpty();
      setView(st.controller ? 'running' : st.result ? 'review' : 'form');
      dlg.showModal();
      if (!st.controller && !st.result) $('#genPrompt').focus();
    }
    const s = await refreshStatus();
    if (!s) showError('Generation needs the local server. Close this page and start the editor with start.cmd (or "node serve.js").');
    else if (!s.ready) showError(notReadyMessage(s));
  }

  // ---------- generation ----------
  function storyOptions() {
    return { aidModel: $('#genAidModel').value, player: $('#genPlayer').value, pov: $('#genPov').value };
  }

  function buildRequest() {
    const prompt = $('#genPrompt').value.trim();
    const limit = A.cards.limit();
    if (st.mode === 'fields') {
      return {
        mode: 'fields',
        prompt,
        limit,
        fields: checkedFields(),
        ...storyOptions(),
        revise: $('#genRevise').checked,
        scenario: A.scenario.get(),
        cards: $('#genUseCards').checked
          ? A.cards.data().map(c => ({ title: c.title, type: c.type, keys: c.keys, value: c.value }))
          : [],
      };
    }
    if (st.mode === 'scenario') {
      const add = document.querySelector('input[name="genScMode"]:checked').value === 'add';
      return {
        mode: 'scenario',
        prompt,
        limit,
        count: $('#genScCount').value,
        ...storyOptions(),
        existingCards: add ? A.cards.index() : [],
        replace: !add,
      };
    }
    return {
      mode: 'cards',
      prompt,
      limit,
      count: $('#genCount').value,
      type: $('#genType').value,
      scenario: $('#genUseScenario').checked && !$('#genUseScenario').disabled ? A.scenario.get() : null,
      existingCards: $('#genUseIndex').checked ? A.cards.index() : [],
      examples: $('#genUseExamples').checked ? A.cards.selectedData() : [],
    };
  }

  async function run() {
    const req = buildRequest();
    if (req.mode === 'fields' && !req.fields.length) {
      showError('Pick at least one field to write.');
      return;
    }
    if (req.mode !== 'fields' && !req.prompt) {
      showError('Describe what you want Claude to write.');
      $('#genPrompt').focus();
      return;
    }
    showError('');
    st.result = null;
    st.request = req;
    st.controller = new AbortController();
    setView('running');
    const started = Date.now();
    let chars = 0;
    let cards = 0;
    const paint = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      $('#genProgressText').textContent = chars
        ? `Writing… ${cards && req.mode !== 'fields' ? cards + (cards === 1 ? ' card' : ' cards') + ' · ' : ''}${chars.toLocaleString()} characters`
        : 'Claude is thinking…';
      $('#genProgressSub').textContent = `${secs}s elapsed` + (req.mode === 'scenario' ? ' · a full scenario can take a few minutes' : '');
    };
    paint();
    st.timer = setInterval(paint, 1000);

    let done = null;
    let error = null;
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AIDE': '1' },
        body: JSON.stringify(req),
        signal: st.controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server error ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.event === 'progress') {
            chars = ev.chars;
            cards = ev.cards;
            paint();
          } else if (ev.event === 'done') done = ev;
          else if (ev.event === 'error') error = ev.message;
        }
      }
      if (!done && !error) error = 'The connection to the local server closed before Claude finished.';
    } catch (e) {
      error = e.name === 'AbortError' ? null : e.message === 'Failed to fetch' ? 'Could not reach the local server. Is it still running?' : e.message;
    } finally {
      clearInterval(st.timer);
      st.controller = null;
    }

    if (done) {
      st.result = normalizeResult(done.mode, done.result);
      st.resultMode = done.mode;
      renderReview();
      setView('review');
      if (!$('#genDialog').open) A.app.toast('Claude finished; open Generate to review the results.', { label: 'Review', run: () => open() });
    } else {
      setView('form');
      showError(error);
    }
  }

  function normalizeResult(mode, r) {
    const cards = (Array.isArray(r && r.cards) ? r.cards : []).map(c => ({
      title: str(c.title), type: str(c.type), keys: str(c.keys), value: str(c.value), description: str(c.description), keep: true,
    }));
    const notes = str(r && r.notes).trim();
    if (mode === 'fields') {
      // Only the fields that were asked for and came back.
      const fields = SCENARIO_FIELDS.filter(([k]) => r && typeof r[k] === 'string').map(([k, label]) => ({ key: k, label, value: r[k], keep: true }));
      return { fields, notes, cards: [] };
    }
    if (mode !== 'scenario') return { cards };
    const scenario = {};
    for (const [k] of SCENARIO_FIELDS) scenario[k] = str(r[k]);
    return { cards, scenario, notes };
  }

  function notesHTML(notes) {
    return notes ? `<div class="issue info rev-notes"><b>Claude's notes</b><div class="rev-text">${esc(notes)}</div></div>` : '';
  }

  function renderFieldsReview(r) {
    const current = A.scenario.get();
    let html = notesHTML(r.notes);
    if (!r.fields.length) html += '<p class="muted">Claude returned no fields.</p>';
    html += r.fields.map((f, i) => {
      const cur = str(current[f.key]);
      return `<div class="rev-field${f.keep ? '' : ' off'}">
        <label class="check"><input type="checkbox" data-keep-field="${i}"${f.keep ? ' checked' : ''}>
          <b>${esc(f.label)}</b> <span class="muted small">${cur.trim() ? 'replaces the current text' : 'currently empty'} · <span data-len="${i}">${f.value.length}</span> chars</span></label>
        <textarea data-edit-field="${i}" rows="${Math.min(16, Math.max(3, f.value.split('\n').length + 1))}"></textarea>
        ${cur.trim() ? `<details><summary class="muted small">Show current text</summary><div class="rev-text muted">${esc(cur)}</div></details>` : ''}
      </div>`;
    }).join('');
    html += '<p class="hint">You can edit the text above before applying. Applying is one step you can undo with Ctrl+Z.</p>';
    $('#genReview').innerHTML = html;
    // Set textarea values directly so nothing needs escaping.
    r.fields.forEach((f, i) => ($(`[data-edit-field="${i}"]`).value = f.value));
  }

  // ---------- review ----------
  function badge(type) {
    let h = 0;
    for (const ch of str(type)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return type ? `<span class="badge" style="--h:${h}">${esc(type)}</span>` : '<span class="badge none">no type</span>';
  }

  function renderReview() {
    const r = st.result;
    if (r.fields) return renderFieldsReview(r);
    const limit = A.cards.limit();
    let html = '';
    if (r.scenario) {
      html += notesHTML(r.notes);
      const overwrite = !A.scenario.isEmpty();
      html += `<h3>Scenario details${overwrite ? ' <small class="warn-text">will replace the current details</small>' : ''}</h3>
        <div class="rev-fields">${SCENARIO_FIELDS.map(([k, label]) => `
          <details${k === 'opening' ? ' open' : ''}><summary><b>${label}</b> <span class="muted">${esc(r.scenario[k].slice(0, 90))}${r.scenario[k].length > 90 ? '…' : ''}</span></summary>
          <div class="rev-text">${esc(r.scenario[k]) || '<em class="muted">(empty)</em>'}</div></details>`).join('')}
        </div>`;
    }
    html += `<div class="rev-cards-head"><h3>${r.cards.length} story card${r.cards.length === 1 ? '' : 's'}</h3>
      ${r.cards.length > 1 ? '<button type="button" class="small" id="genToggleAll">Select none</button>' : ''}</div>`;
    if (!r.cards.length) html += '<p class="muted">Claude returned no cards.</p>';
    html += `<ul class="rev-cards">${r.cards.map((c, i) => `
      <li class="${c.keep ? '' : 'off'}">
        <label class="check rev-card-head"><input type="checkbox" data-keep="${i}"${c.keep ? ' checked' : ''}>
          <b>${esc(c.title) || '<em>(unnamed)</em>'}</b> ${badge(c.type)}
          <span class="ci-keys">${esc(c.keys)}</span>
          <span class="ci-len${c.value.length > limit ? ' over' : ''}">${c.value.length}</span></label>
        <div class="rev-text">${esc(c.value)}</div>
        ${c.description ? `<div class="muted small">Notes: ${esc(c.description)}</div>` : ''}
      </li>`).join('')}</ul>`;
    if (r.scenario)
      html += `<p class="hint">${st.request && !st.request.replace
        ? 'Cards will be added to the current ones.'
        : `Cards will <b>replace</b> the current ${A.cards.count()} cards.`} You can undo this with Ctrl+Z.</p>`;
    $('#genReview').innerHTML = html;
  }

  function updateApplyButton() {
    const btn = $('#genApply');
    if (!btn || !st.result) return;
    if (st.result.fields) {
      const k = st.result.fields.filter(f => f.keep).length;
      btn.textContent = `Apply ${k} field${k === 1 ? '' : 's'}`;
      btn.disabled = k === 0;
      return;
    }
    const n = st.result.cards.filter(c => c.keep).length;
    btn.textContent = st.result.scenario ? `Apply scenario + ${n} card${n === 1 ? '' : 's'}` : `Add ${n} card${n === 1 ? '' : 's'}`;
    btn.disabled = !st.result.scenario && n === 0;
    const t = $('#genToggleAll');
    if (t) t.textContent = n === st.result.cards.length ? 'Select none' : 'Select all';
  }

  function apply() {
    const r = st.result;
    if (!r) return;
    const cards = r.cards.filter(c => c.keep);
    let n;
    if (r.fields) {
      const chosen = r.fields.filter(f => f.keep);
      A.cards.applyScenarioFields(Object.fromEntries(chosen.map(f => [f.key, f.value])));
      A.app.showTab('scenario');
      A.app.toast(`Updated ${chosen.map(f => f.label).join(', ')}.`, { label: 'Undo', run: A.cards.undo });
    } else if (r.scenario) {
      const replace = st.request && st.request.replace;
      n = A.cards.applyGenerated({ cards, replace, scenario: r.scenario });
      A.app.showTab('scenario');
      A.app.toast(`Applied scenario “${r.scenario.title || 'Untitled'}” with ${n} card${n === 1 ? '' : 's'}.`, { label: 'Undo', run: A.cards.undo });
    } else {
      n = A.cards.applyGenerated({ cards });
      A.app.showTab('cards');
      A.app.toast(`Added ${n} card${n === 1 ? '' : 's'}.`, { label: 'Undo', run: A.cards.undo });
    }
    st.result = null;
    $('#genDialog').close();
  }

  // ---------- settings ----------
  function showProvider(p) {
    for (const el of document.querySelectorAll('#settingsDialog [data-provider]')) el.hidden = el.dataset.provider !== p;
    $('#setClearKey').hidden = p !== 'api' || !st.status || st.status.keySource !== 'saved';
  }

  function paintCliStatus(s) {
    const cli = s.cli;
    const el = $('#cliStatus');
    el.className = 'issue ' + (cli && cli.loggedIn ? 'info' : 'warn');
    el.textContent = !cli
      ? 'Checking Claude Code…'
      : !cli.installed
        ? 'Claude Code (the "claude" command) was not found on this computer.'
        : cli.loggedIn
          ? `Claude Code is signed in${cli.authMethod && cli.authMethod !== 'none' ? ' (' + cli.authMethod + ')' : ''}. Generation will use your plan.`
          : 'Claude Code is installed but not signed in.';
    $('#cliHelp').hidden = !!(cli && cli.loggedIn) || !(cli && cli.installed);
  }

  async function recheckCli() {
    try {
      st.status = await api('/api/status?fresh=1');
      paintCliStatus(st.status);
      updateModelLabel();
      if ($('#genDialog').open && st.status.ready) showError('');
    } catch (e) {
      A.app.toast(e.message, null, { error: true });
    }
  }

  async function openSettings() {
    let s;
    try {
      s = st.status = await api('/api/status?fresh=1');
    } catch {
      s = null;
    }
    if (!s) {
      A.app.toast('Settings need the local server. Start the editor with start.cmd.', null, { error: true });
      return;
    }
    updateModelLabel();
    for (const r of document.querySelectorAll('input[name="setProvider"]')) r.checked = r.value === s.provider;
    paintCliStatus(s);
    $('#keyStatus').textContent = s.mock
      ? 'Mock mode is on (AIDE_MOCK), so no API calls are made.'
      : s.keySource === 'saved'
        ? 'An API key is saved on this computer.'
        : s.keySource === 'environment'
          ? 'Using the API key from the ANTHROPIC_API_KEY environment variable.'
          : 'No API key is set yet.';
    $('#setKey').value = '';
    showProvider(s.provider);
    $('#setModel').innerHTML = s.models
      .map(m => `<option value="${m}">${MODEL_NAMES[m] || m}${MODEL_HINTS[m] ? ' (' + MODEL_HINTS[m] + ')' : ''}</option>`)
      .join('');
    $('#setModel').value = s.model;
    $('#setEffort').innerHTML = s.efforts.map(e => `<option value="${e}">${e}</option>`).join('');
    $('#setEffort').value = s.effort;
    $('#settingsDialog').showModal();
  }

  async function saveSettings(extra = {}) {
    try {
      const provider = document.querySelector('input[name="setProvider"]:checked');
      st.status = await api('/api/settings', {
        provider: provider ? provider.value : undefined,
        apiKey: $('#setKey').value,
        model: $('#setModel').value,
        effort: $('#setEffort').value,
        ...extra,
      });
      $('#setKey').value = '';
      $('#settingsDialog').close();
      updateModelLabel();
      if ($('#genDialog').open) showError(st.status.ready ? '' : notReadyMessage(st.status));
      A.app.toast(extra.clearKey ? 'Saved API key removed.' : 'Settings saved.');
    } catch (e) {
      A.app.toast(e.message, null, { error: true });
    }
  }

  // ---------- wiring ----------
  // Generator choices that carry over between sessions.
  function savePrefs() {
    try {
      localStorage.setItem('aide.genPrefs', JSON.stringify({ ...storyOptions(), fields: checkedFields(), revise: $('#genRevise').checked }));
    } catch {}
  }
  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem('aide.genPrefs')) || {}; } catch {}
    if (AID_MODELS.includes(p.aidModel)) $('#genAidModel').value = p.aidModel;
    if (p.player) $('#genPlayer').value = p.player;
    if (p.pov) $('#genPov').value = p.pov;
    if (typeof p.revise === 'boolean') $('#genRevise').checked = p.revise;
    setFieldChecks(Array.isArray(p.fields) && p.fields.length ? p.fields : DEFAULT_FIELDS);
  }

  function init() {
    $('#genAidModel').innerHTML =
      '<option value="">Not sure / any</option>' + AID_MODELS.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    $('#genFieldChecks').innerHTML = SCENARIO_FIELDS
      .map(([k, label]) => `<label class="check"><input type="checkbox" value="${k}"> ${esc(label)}</label>`)
      .join('');
    loadPrefs();
    let mode = 'cards';
    try { mode = localStorage.getItem('aide.genMode') || 'cards'; } catch {}
    setMode(['scenario', 'fields'].includes(mode) ? mode : 'cards');
    setView('form');

    const dlg = $('#genDialog');
    dlg.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) return dlg.close();
      if (e.target.closest('[data-open-settings]')) return openSettings();
      const m = e.target.closest('.seg [data-mode]');
      if (m) return setMode(m.dataset.mode);
      const id = e.target.id;
      if (id === 'genGo' || id === 'genAgain') run();
      else if (id === 'genStop') st.controller && st.controller.abort();
      else if (id === 'genBack') { st.result = null; setView('form'); $('#genPrompt').focus(); }
      else if (id === 'genApply') apply();
      else if (id === 'genToggleAll') {
        const all = st.result.cards.every(c => c.keep);
        st.result.cards.forEach(c => (c.keep = !all));
        renderReview();
        updateApplyButton();
      }
    });
    dlg.addEventListener('input', e => {
      const i = e.target.dataset.editField;
      if (i === undefined || !st.result || !st.result.fields) return;
      st.result.fields[+i].value = e.target.value;
      $(`[data-len="${i}"]`).textContent = e.target.value.length;
    });
    dlg.addEventListener('change', e => {
      const fi = e.target.dataset.keepField;
      if (fi !== undefined && st.result && st.result.fields) {
        st.result.fields[+fi].keep = e.target.checked;
        e.target.closest('.rev-field').classList.toggle('off', !e.target.checked);
        return updateApplyButton();
      }
      if (e.target.closest('#genForm')) savePrefs();
      const i = e.target.dataset.keep;
      if (i === undefined || !st.result) return;
      st.result.cards[+i].keep = e.target.checked;
      e.target.closest('li').classList.toggle('off', !e.target.checked);
      updateApplyButton();
    });
    $('#genPrompt').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    });

    const sdlg = $('#settingsDialog');
    sdlg.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) sdlg.close();
      else if (e.target.id === 'setSave') saveSettings();
      else if (e.target.id === 'setClearKey') saveSettings({ clearKey: true });
      else if (e.target.id === 'setRecheck') recheckCli();
    });
    sdlg.addEventListener('change', e => {
      if (e.target.name === 'setProvider') showProvider(e.target.value);
    });
    $('#setKey').addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings(); });

    $('#btnGenerate').addEventListener('click', () => open());
    $('#btnGenCards').addEventListener('click', () => open('cards'));
    $('#btnSettings').addEventListener('click', openSettings);
    refreshStatus();
  }

  A.generate = { init, open, openSettings };
})();
