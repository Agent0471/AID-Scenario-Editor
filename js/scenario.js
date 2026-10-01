// Scenario details: the non-card parts of an AI Dungeon scenario.
(function () {
  'use strict';
  const A = (window.AIDE = window.AIDE || {});
  const $ = s => document.querySelector(s);
  const str = v => (v == null ? '' : String(v));

  // [key, label, rows (0 = single line), hint]
  const FIELDS = [
    ['title', 'Title', 0, 'The scenario name.'],
    ['description', 'Description', 3, 'Shown to players before they start.'],
    ['tags', 'Tags', 0, 'Comma-separated.'],
    ['opening', 'Opening', 12, 'The "Prompt": the first passage of the story, which the player continues from.'],
    ['plotEssentials', 'Plot Essentials', 6, 'Facts the AI always keeps in mind.'],
    ['aiInstructions', 'AI Instructions', 12, 'How the AI should write and behave.'],
    ['authorsNote', "Author's Note", 3, 'Short style and tone steering, placed close to the end of the context.'],
  ];
  const KEYS = FIELDS.map(f => f[0]);

  let data = empty();
  let rendered = false;

  function empty() {
    return Object.fromEntries(KEYS.map(k => [k, '']));
  }
  function normalize(o) {
    const d = empty();
    if (o && typeof o === 'object') for (const k of KEYS) d[k] = str(o[k]);
    // Keep any extra fields a project file may carry.
    if (o && typeof o === 'object') for (const k of Object.keys(o)) if (!KEYS.includes(k)) d[k] = o[k];
    return d;
  }

  function countText(v) {
    const t = str(v);
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    return `${t.length} chars · ${words} words`;
  }

  function render() {
    const box = $('#scenarioFields');
    if (!rendered) {
      box.innerHTML = FIELDS.map(
        ([k, label, rows, hint]) => `
        <div class="field sc-field">
          <span>${label} <small>${hint}</small><span class="count" data-count="${k}"></span>
            <button type="button" class="small accent" data-gen="${k}" title="Write or improve this field with Claude">✦</button>
            <button type="button" class="small" data-copy="${k}" title="Copy to clipboard">Copy</button></span>
          ${rows ? `<textarea data-sc="${k}" rows="${rows}"${k === 'aiInstructions' || k === 'plotEssentials' ? ' class="mono-ish"' : ''}></textarea>` : `<input data-sc="${k}" autocomplete="off">`}
        </div>`,
      ).join('');
      rendered = true;
    }
    for (const k of KEYS) {
      const el = box.querySelector(`[data-sc="${k}"]`);
      if (el.value !== data[k]) el.value = data[k];
      box.querySelector(`[data-count="${k}"]`).textContent = countText(data[k]);
    }
  }

  function init() {
    const box = $('#scenarioFields');
    box.addEventListener('input', e => {
      const k = e.target.dataset.sc;
      if (!k) return;
      A.cards.beginEdit('sc:' + k);
      data[k] = e.target.value;
      box.querySelector(`[data-count="${k}"]`).textContent = countText(data[k]);
      A.app.updateDirtySoon();
    });
    box.addEventListener('focusout', () => A.cards.endEdit());
    box.addEventListener('click', async e => {
      if (e.target.dataset.gen) return A.generate.open('fields', { fields: [e.target.dataset.gen] });
      const k = e.target.dataset.copy;
      if (!k) return;
      try {
        await navigator.clipboard.writeText(data[k]);
        A.app.toast(`Copied ${FIELDS.find(f => f[0] === k)[1]}.`);
      } catch {
        const el = box.querySelector(`[data-sc="${k}"]`);
        el.focus();
        el.select();
        A.app.toast('Copy failed; the text is selected, press Ctrl+C.');
      }
    });
    $('#tab-scenario').addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'export-cards') A.app.exportStoryCards();
      else if (act.dataset.act === 'gen-scenario') A.generate.open('scenario');
      else if (act.dataset.act === 'gen-fields') A.generate.open('fields');
    });
    render();
  }

  A.scenario = {
    init,
    fields: FIELDS.map(([key, label]) => ({ key, label })),
    get: () => ({ ...data }),
    set(o) {
      data = normalize(o);
      if (rendered) render();
    },
    isEmpty: () => KEYS.every(k => !str(data[k]).trim()),
  };
})();
