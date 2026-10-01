// Story card model, list and editor.
// Cards are kept as the original parsed objects so unknown fields and key order
// survive a load/save round trip untouched.
(function () {
  'use strict';
  const A = (window.AIDE = window.AIDE || {});
  const $ = (s, r = document) => r.querySelector(s);
  const str = v => (v == null ? '' : String(v));
  const esc = s => str(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const template = () => ({
    isSpoiler: false,
    isPinned: false,
    showInStoryCards: true,
    keys: '',
    value: '',
    type: '',
    title: '',
    description: '',
    useForCharacterCreation: false,
  });
  const KNOWN = new Set(Object.keys(template()));
  const FLAGS = [
    ['showInStoryCards', 'Show in Story Cards'],
    ['useForCharacterCreation', 'Use for character creation'],
    ['isPinned', 'Pinned'],
    ['isSpoiler', 'Spoiler'],
  ];
  const ALL = null; // type filter value meaning "all types"

  const S = {
    cards: [], // { uid, d }
    sel: new Set(),
    anchor: null,
    query: '',
    type: ALL,
    sort: 'order',
    issuesOnly: false,
    limit: loadLimit(),
    issues: new Map(), // uid -> [{ level, msg, refs }]
    view: [], // uids currently shown, in display order
  };
  let uidSeq = 1;
  let lastEdit = null; // "uid:field" of the edit session being coalesced into one undo step
  let typeSig = '';

  const wrap = d => ({ uid: uidSeq++, d });
  const byUid = uid => S.cards.find(c => c.uid === uid);
  const indexOf = uid => S.cards.findIndex(c => c.uid === uid);
  const selectedCards = () => S.cards.filter(c => S.sel.has(c.uid));
  const current = () => (S.sel.size === 1 ? byUid([...S.sel][0]) : null);
  const splitKeys = keys => str(keys).split(',');

  function loadLimit() {
    try { return Math.max(50, parseInt(localStorage.getItem('aide.limit'), 10) || 1000); } catch { return 1000; }
  }

  // ---------- history ----------
  // Snapshots also carry the scenario fields so one undo stack covers the whole document.
  const history = new A.History({
    take: () => JSON.stringify({ cards: S.cards, sel: [...S.sel], scenario: A.scenario ? A.scenario.get() : null }),
    restore: snap => {
      const o = JSON.parse(snap);
      S.cards = o.cards;
      S.sel = new Set(o.sel);
      lastEdit = null;
      if (o.scenario && A.scenario) A.scenario.set(o.scenario);
      refresh({ editor: true });
    },
    onChange: () => A.app && A.app.updateUndoButtons(),
  });

  function beginEdit(uid, field) {
    const key = uid + ':' + field;
    if (lastEdit !== key) {
      history.push();
      lastEdit = key;
    }
  }
  function structural() {
    lastEdit = null;
    history.push();
  }

  // ---------- parsing / serialising ----------
  function validate(data) {
    if (!Array.isArray(data)) throw new Error('Expected a JSON array of story cards.');
    if (data.some(x => !x || typeof x !== 'object' || Array.isArray(x)))
      throw new Error('Every item in the array must be a story card object.');
    return data;
  }
  const serialize = (cards = S.cards) => JSON.stringify(cards.map(c => c.d), null, 2);

  // Generated cards only carry the five text fields; everything else comes from the template.
  function fromGenerated(g) {
    const d = template();
    for (const f of ['title', 'type', 'keys', 'value', 'description']) d[f] = str(g && g[f]);
    return d;
  }

  function clearFilters() {
    S.query = '';
    S.issuesOnly = false;
    S.type = ALL;
    $('#search').value = '';
    $('#issuesOnly').checked = false;
    $('#typeFilter').value = '__all';
  }

  // ---------- issues ----------
  function computeIssues() {
    const keyOwners = new Map();
    const titleOwners = new Map();
    for (const c of S.cards) {
      for (const k of splitKeys(c.d.keys)) {
        const n = k.trim().toLowerCase();
        if (!n) continue;
        if (!keyOwners.has(n)) keyOwners.set(n, new Set());
        keyOwners.get(n).add(c.uid);
      }
      const t = str(c.d.title).trim().toLowerCase();
      if (t) (titleOwners.get(t) || titleOwners.set(t, []).get(t)).push(c.uid);
    }
    S.issues = new Map();
    for (const c of S.cards) {
      const d = c.d;
      const list = [];
      const keys = splitKeys(d.keys);
      const value = str(d.value);
      if (!str(d.title).trim()) list.push({ level: 'warn', msg: 'No name.' });
      if (!keys.some(k => k.trim())) list.push({ level: 'warn', msg: 'No triggers — this card will never activate.' });
      else if (keys.length > 1 && keys.some(k => !k.trim())) list.push({ level: 'info', msg: 'Triggers contain an empty entry (stray comma).' });
      if (!value.trim()) list.push({ level: 'warn', msg: 'Entry is empty.' });
      if (value.length > S.limit) list.push({ level: 'warn', msg: `Entry is ${value.length} characters (over ${S.limit}).` });
      const t = str(d.title).trim().toLowerCase();
      if (t && titleOwners.get(t).length > 1)
        list.push({ level: 'info', msg: 'Another card has the same name:', refs: titleOwners.get(t).filter(u => u !== c.uid) });
      const seen = new Set();
      for (const k of keys) {
        const n = k.trim().toLowerCase();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        const others = [...keyOwners.get(n)].filter(u => u !== c.uid);
        if (others.length) list.push({ level: 'info', msg: `Trigger “${k.trim()}” is also used by:`, refs: others });
      }
      if (list.length) S.issues.set(c.uid, list);
    }
  }
  const warnings = uid => (S.issues.get(uid) || []).filter(i => i.level === 'warn');

  // ---------- list ----------
  function hue(s) {
    let h = 0;
    for (const ch of str(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }
  function badge(type) {
    return type ? `<span class="badge" style="--h:${hue(type)}" title="${esc(type)}">${esc(type)}</span>` : '<span class="badge none">no type</span>';
  }

  function matches(c) {
    const d = c.d;
    if (S.type !== ALL && str(d.type) !== S.type) return false;
    if (S.issuesOnly && !warnings(c.uid).length) return false;
    if (S.query) {
      const hay = [d.title, d.keys, d.value, d.description, d.type].map(str).join('\n').toLowerCase();
      return S.query.split(/\s+/).every(t => hay.includes(t));
    }
    return true;
  }
  const SORTS = {
    title: (a, b) => str(a.d.title).localeCompare(str(b.d.title), undefined, { sensitivity: 'base', numeric: true }),
    type: (a, b) => str(a.d.type).localeCompare(str(b.d.type)) || SORTS.title(a, b),
    length: (a, b) => str(b.d.value).length - str(a.d.value).length,
  };

  function itemHTML(c) {
    const d = c.d;
    const warn = warnings(c.uid);
    const len = str(d.value).length;
    const flags = [d.isPinned && 'pinned', d.isSpoiler && 'spoiler', d.showInStoryCards === false && 'hidden'].filter(Boolean);
    return `<li class="card-item${S.sel.has(c.uid) ? ' selected' : ''}" data-uid="${c.uid}">
      <div class="ci-top">
        <span class="ci-title">${esc(d.title) || '<em>(unnamed)</em>'}</span>
        ${flags.length ? `<span class="ci-flags">${flags.join(' · ')}</span>` : ''}
        ${warn.length ? `<span class="ci-warn" title="${esc(warn.map(w => w.msg).join('\n'))}">⚠</span>` : ''}
      </div>
      <div class="ci-meta">${badge(str(d.type))}<span class="ci-keys">${esc(d.keys)}</span><span class="ci-len${len > S.limit ? ' over' : ''}">${len}</span></div>
    </li>`;
  }

  function renderList() {
    let v = S.cards.filter(matches);
    if (S.sort !== 'order') v = v.slice().sort(SORTS[S.sort]);
    S.view = v.map(c => c.uid);
    $('#cardList').innerHTML = v.length
      ? v.map(itemHTML).join('')
      : `<li class="empty">${S.cards.length ? 'No cards match.' : 'No cards yet.'}</li>`;
    const warnCount = S.cards.filter(c => warnings(c.uid).length).length;
    $('#issueCount').textContent = warnCount || '';
    $('#countLabel').textContent =
      (v.length === S.cards.length ? `${S.cards.length} cards` : `${v.length} of ${S.cards.length} cards`) +
      (S.sel.size > 1 ? ` · ${S.sel.size} selected` : '');
  }

  function renderTypeOptions() {
    const counts = new Map();
    for (const c of S.cards) {
      const t = str(c.d.type);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    const types = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const sig = types.map(t => t + '\u0000' + counts.get(t)).join('\u0001') + '|' + S.cards.length;
    if (sig === typeSig) return;
    typeSig = sig;
    if (S.type !== ALL && !counts.has(S.type)) S.type = ALL;
    const sel = $('#typeFilter');
    sel.innerHTML =
      `<option value="__all">All types (${S.cards.length})</option>` +
      types.map(t => `<option value="t:${esc(t)}">${t ? esc(t) : '(no type)'} (${counts.get(t)})</option>`).join('');
    sel.value = S.type === ALL ? '__all' : 't:' + S.type;
    $('#typeOptions').innerHTML = types.filter(Boolean).map(t => `<option value="${esc(t)}">`).join('');
  }

  // ---------- editor ----------
  function renderEditor() {
    const ed = $('#editor');
    if (!S.cards.length) {
      ed.innerHTML = `<div class="placeholder"><div>
        <h2>No story cards</h2>
        <div>Open an AI Dungeon story card export (.json), drop one onto this window, or start writing cards.</div>
        <div class="actions"><button data-act="open" class="primary">Open file…</button><button data-act="add">+ New card</button><button data-act="generate" class="accent">✦ Generate with Claude</button></div>
        <div class="kbd-list">
          <kbd>Ctrl+S</kbd><span>Save</span><kbd>Ctrl+O</kbd><span>Open</span>
          <kbd>Ctrl+G</kbd><span>Generate with Claude</span><kbd>Esc</kbd><span>Close dialogs</span>
          <kbd>Alt+N</kbd><span>New card</span><kbd>Ctrl+D</kbd><span>Duplicate</span>
          <kbd>Ctrl+F</kbd><span>Search</span><kbd>Ctrl+Z / Ctrl+Y</kbd><span>Undo / redo</span>
          <kbd>Alt+↑ / Alt+↓</kbd><span>Move card</span><kbd>Shift / Ctrl+click</kbd><span>Multi-select</span>
        </div></div></div>`;
      return;
    }
    if (S.sel.size === 0) {
      ed.innerHTML = `<div class="placeholder"><div><h2>No card selected</h2><div>Pick a card from the list, or create a new one.</div>
        <div class="actions"><button data-act="add" class="primary">+ New card</button></div></div></div>`;
      return;
    }
    if (S.sel.size > 1) return renderBulk(ed);
    renderSingle(ed, current());
  }

  function renderSingle(ed, c) {
    const d = c.d;
    const i = indexOf(c.uid);
    const reorderable = S.sort === 'order';
    const extra = Object.keys(d).filter(k => !KNOWN.has(k));
    ed.innerHTML = `
      <div class="ed-toolbar">
        <span class="muted">Card ${i + 1} of ${S.cards.length}</span>
        <div class="spacer"></div>
        <button data-act="up" title="${reorderable ? 'Move up (Alt+↑)' : 'Switch to File order to reorder'}" ${!reorderable || i === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" title="${reorderable ? 'Move down (Alt+↓)' : 'Switch to File order to reorder'}" ${!reorderable || i === S.cards.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="duplicate" title="Duplicate (Ctrl+D)">Duplicate</button>
        <button data-act="delete" class="danger" title="Delete (Del in list)">Delete</button>
      </div>
      <div class="ed-form">
        <div class="grid2">
          <label class="field"><span>Name</span><input data-f="title" autocomplete="off"></label>
          <label class="field"><span>Type <small>pick or type a new one</small></span><input data-f="type" list="typeOptions" autocomplete="off"></label>
        </div>
        <div class="field">
          <label class="field"><span>Triggers <small>comma-separated</small></span>
            <input data-f="keys" class="mono" spellcheck="false" autocomplete="off"></label>
          <div id="keyChips" class="chips"></div>
          <div class="hint">Spaces are kept exactly as typed (shown as ␣). A leading space stops a trigger matching inside longer words.</div>
        </div>
        <label class="field"><span>Entry <small>what the AI is given when a trigger appears</small><span id="valueCount" class="count"></span></span>
          <textarea data-f="value" class="entry" rows="12"></textarea></label>
        <label class="field"><span>Notes <small>description — for you, not the AI</small></span>
          <textarea data-f="description" rows="3"></textarea></label>
        <fieldset class="flags"><legend>Options</legend>
          ${FLAGS.map(([f, label]) => `<label class="check"><input type="checkbox" data-f="${f}"> ${label}</label>`).join('')}
        </fieldset>
        <div id="cardIssues" class="issues"></div>
        ${extra.length ? `<div class="extra">Other fields kept as-is: ${extra.map(esc).join(', ')}</div>` : ''}
      </div>`;
    for (const el of ed.querySelectorAll('[data-f]')) {
      const f = el.dataset.f;
      if (el.type === 'checkbox') el.checked = !!d[f];
      else el.value = str(d[f]);
    }
    renderChips(c);
    renderCount(c);
    renderCardIssues(c);
  }

  function renderChips(c) {
    const box = $('#keyChips');
    if (!box) return;
    const keys = splitKeys(c.d.keys);
    if (keys.length === 1 && !keys[0]) return (box.innerHTML = '');
    box.innerHTML = keys
      .map(k => {
        if (!k.trim()) return '<span class="chip empty">empty</span>';
        const m = k.match(/^(\s*)(.*?)(\s*)$/s);
        const sp = s => (s ? `<span class="sp">${'␣'.repeat(s.length)}</span>` : '');
        return `<span class="chip">${sp(m[1])}${esc(m[2])}${sp(m[3])}</span>`;
      })
      .join('');
  }

  function renderCount(c) {
    const el = $('#valueCount');
    if (!el) return;
    const len = str(c.d.value).length;
    const words = str(c.d.value).trim() ? str(c.d.value).trim().split(/\s+/).length : 0;
    el.textContent = `${len} / ${S.limit} chars · ${words} words`;
    el.classList.toggle('over', len > S.limit);
  }

  function renderCardIssues(c) {
    const box = $('#cardIssues');
    if (!box) return;
    const list = S.issues.get(c.uid) || [];
    box.innerHTML = list
      .map(i => {
        const refs = (i.refs || [])
          .map(u => `<a data-goto="${u}">${esc(str(byUid(u).d.title) || '(unnamed)')}</a>`)
          .join(', ');
        return `<div class="issue ${i.level}">${i.level === 'warn' ? '⚠ ' : ''}${esc(i.msg)} ${refs}</div>`;
      })
      .join('');
  }

  function renderBulk(ed) {
    const n = S.sel.size;
    ed.innerHTML = `<div class="bulk">
      <h2>${n} cards selected</h2>
      <div class="group"><b>Type</b>
        <div class="line"><input id="bulkType" list="typeOptions" placeholder="Type for all selected" autocomplete="off"><button data-act="bulk-type">Apply</button></div>
      </div>
      <div class="group"><b>Options</b>
        ${FLAGS.map(([f, label]) => {
          const on = selectedCards().filter(c => c.d[f]).length;
          return `<div class="line"><span>${label} <small class="muted">(${on}/${n} on)</small></span>
            <button data-act="bulk-flag" data-flag="${f}" data-on="1">Turn on</button>
            <button data-act="bulk-flag" data-flag="${f}" data-on="0">Turn off</button></div>`;
        }).join('')}
      </div>
      <div class="group"><b>Cards</b>
        <div class="line">
          <button data-act="duplicate">Duplicate</button>
          <button data-act="export-selected">Export selected…</button>
          <button data-act="delete" class="danger">Delete ${n} cards</button>
        </div>
      </div>
    </div>`;
  }

  // ---------- refresh ----------
  let refreshTimer = 0;
  function refresh({ editor = false } = {}) {
    clearTimeout(refreshTimer);
    computeIssues();
    renderTypeOptions();
    renderList();
    if (editor) renderEditor();
    else {
      const c = current();
      if (c) renderCardIssues(c);
    }
    A.app && A.app.updateDirty();
  }
  // Light refresh while typing.
  function changed() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(), 120);
  }

  // ---------- selection ----------
  function select(uids, { anchor, scroll = true, focus } = {}) {
    S.sel = new Set(uids);
    if (anchor !== undefined) S.anchor = anchor;
    lastEdit = null;
    renderList();
    renderEditor();
    if (scroll && uids.length) {
      const el = $(`#cardList [data-uid="${uids[uids.length - 1]}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    if (focus) {
      const el = $(`#editor [data-f="${focus}"]`);
      if (el) el.focus();
    }
  }

  function clickItem(uid, e) {
    if (e.shiftKey && S.anchor != null && S.view.includes(S.anchor)) {
      const a = S.view.indexOf(S.anchor);
      const b = S.view.indexOf(uid);
      const range = S.view.slice(Math.min(a, b), Math.max(a, b) + 1);
      select(e.ctrlKey || e.metaKey ? [...S.sel, ...range] : range, { scroll: false });
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(S.sel);
      s.has(uid) ? s.delete(uid) : s.add(uid);
      select([...s], { anchor: uid, scroll: false });
    } else {
      select([uid], { anchor: uid, scroll: false });
    }
  }

  function step(dir, extend) {
    if (!S.view.length) return;
    const ref = S.anchor != null && S.sel.has(S.anchor) ? S.anchor : [...S.sel].pop();
    let i = S.view.indexOf(ref);
    i = i < 0 ? 0 : Math.max(0, Math.min(S.view.length - 1, i + dir));
    const uid = S.view[i];
    if (extend) select([...S.sel, uid], { anchor: uid });
    else select([uid], { anchor: uid });
  }

  // ---------- actions ----------
  function add() {
    structural();
    const cur = current();
    const d = template();
    d.type = S.type !== ALL ? S.type : cur ? str(cur.d.type) : '';
    const c = wrap(d);
    const at = cur ? indexOf(cur.uid) + 1 : S.cards.length;
    S.cards.splice(at, 0, c);
    if (S.query || S.issuesOnly) {
      S.query = '';
      S.issuesOnly = false;
      $('#search').value = '';
      $('#issuesOnly').checked = false;
    }
    refresh();
    select([c.uid], { anchor: c.uid, focus: 'title' });
  }

  function duplicate() {
    const src = selectedCards();
    if (!src.length) return;
    structural();
    const copies = src.map(c => {
      const d = JSON.parse(JSON.stringify(c.d));
      d.title = str(d.title) + ' (copy)';
      return wrap(d);
    });
    const at = Math.max(...src.map(c => indexOf(c.uid))) + 1;
    S.cards.splice(at, 0, ...copies);
    refresh();
    select(copies.map(c => c.uid), { anchor: copies[0].uid, focus: copies.length === 1 ? 'title' : undefined });
  }

  function remove() {
    const doomed = new Set(S.sel);
    if (!doomed.size) return;
    structural();
    const viewIdx = S.view.findIndex(u => doomed.has(u));
    S.cards = S.cards.filter(c => !doomed.has(c.uid));
    refresh();
    const next = S.view[Math.min(Math.max(viewIdx, 0), S.view.length - 1)];
    select(next != null ? [next] : [], { anchor: next });
    A.app.toast(`Deleted ${doomed.size} card${doomed.size > 1 ? 's' : ''}.`, { label: 'Undo', run: undo });
  }

  function move(dir) {
    const c = current();
    if (!c || S.sort !== 'order') return;
    const i = indexOf(c.uid);
    const j = i + dir;
    if (j < 0 || j >= S.cards.length) return;
    structural();
    [S.cards[i], S.cards[j]] = [S.cards[j], S.cards[i]];
    refresh();
    select([c.uid], { anchor: c.uid });
  }

  function bulkType() {
    const v = $('#bulkType').value;
    structural();
    for (const c of selectedCards()) c.d.type = v;
    refresh({ editor: true });
    A.app.toast(`Set type of ${S.sel.size} cards to “${v || '(none)'}”.`);
  }

  function bulkFlag(flag, on) {
    structural();
    for (const c of selectedCards()) c.d[flag] = on;
    refresh({ editor: true });
  }

  function undo() {
    if (history.undo()) A.app.toast('Undone.');
  }
  function redo() {
    if (history.redo()) A.app.toast('Redone.');
  }

  // ---------- wiring ----------
  function init() {
    const list = $('#cardList');
    const ed = $('#editor');

    list.addEventListener('click', e => {
      const li = e.target.closest('.card-item');
      if (li) clickItem(+li.dataset.uid, e);
    });
    list.addEventListener('mousedown', e => {
      if (e.shiftKey) e.preventDefault(); // avoid text selection on shift-click
    });
    list.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (e.altKey) return;
        e.preventDefault();
        step(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        remove();
      } else if (e.key === 'Enter') {
        const el = $('#editor [data-f="title"]');
        if (el) { e.preventDefault(); el.focus(); }
      } else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        select(S.view, { scroll: false });
      }
    });

    ed.addEventListener('input', e => {
      const f = e.target.dataset.f;
      const c = current();
      if (!f || !c || e.target.type === 'checkbox') return;
      beginEdit(c.uid, f);
      c.d[f] = e.target.value;
      if (f === 'keys') renderChips(c);
      if (f === 'value') renderCount(c);
      changed();
    });
    ed.addEventListener('change', e => {
      const f = e.target.dataset.f;
      const c = current();
      if (!f || !c || e.target.type !== 'checkbox') return;
      structural();
      c.d[f] = e.target.checked;
      refresh();
    });
    ed.addEventListener('focusout', () => { lastEdit = null; });
    ed.addEventListener('click', e => {
      const go = e.target.closest('[data-goto]');
      if (go) return select([+go.dataset.goto], { anchor: +go.dataset.goto });
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'add') add();
      else if (act === 'open') A.app.open();
      else if (act === 'generate') A.generate.open('cards');
      else if (act === 'duplicate') duplicate();
      else if (act === 'delete') remove();
      else if (act === 'up') move(-1);
      else if (act === 'down') move(1);
      else if (act === 'bulk-type') bulkType();
      else if (act === 'bulk-flag') bulkFlag(btn.dataset.flag, btn.dataset.on === '1');
      else if (act === 'export-selected') A.app.exportCards(serialize(selectedCards()), selectedCards().length);
    });
    ed.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'bulkType') bulkType();
    });

    $('#btnAdd').addEventListener('click', add);
    let searchTimer = 0;
    $('#search').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.query = e.target.value.trim().toLowerCase();
        renderList();
      }, 80);
    });
    $('#search').addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        if (S.view.length && !S.view.some(u => S.sel.has(u))) select([S.view[0]], { anchor: S.view[0] });
        $('#cardList').focus();
      } else if (e.key === 'Escape') {
        e.target.value = '';
        S.query = '';
        renderList();
      }
    });
    $('#typeFilter').addEventListener('change', e => {
      S.type = e.target.value === '__all' ? ALL : e.target.value.slice(2);
      renderList();
    });
    $('#sortMode').addEventListener('change', e => {
      S.sort = e.target.value;
      renderList();
      renderEditor();
    });
    $('#issuesOnly').addEventListener('change', e => {
      S.issuesOnly = e.target.checked;
      renderList();
    });
    const limitInput = $('#limitInput');
    limitInput.value = S.limit;
    limitInput.addEventListener('change', () => {
      S.limit = Math.max(50, parseInt(limitInput.value, 10) || 1000);
      limitInput.value = S.limit;
      try { localStorage.setItem('aide.limit', S.limit); } catch {}
      refresh({ editor: true });
    });

    refresh({ editor: true });
  }

  // ---------- public API ----------
  A.cards = {
    init,
    validate,
    serialize: () => serialize(),
    data: () => S.cards.map(c => c.d),
    count: () => S.cards.length,
    limit: () => S.limit,
    selectedData: () => selectedCards().map(c => c.d),
    selectionCount: () => S.sel.size,
    // Compact list for giving Claude context about what already exists.
    index: () => S.cards.map(c => ({ title: str(c.d.title), type: str(c.d.type), keys: str(c.d.keys) })),
    // Coalesces typing in another panel (e.g. scenario fields) into undo steps.
    beginEdit: field => beginEdit('ext', field),
    endEdit: () => { lastEdit = null; },
    // Merges generated scenario fields as a single undo step.
    applyScenarioFields(fields) {
      structural();
      A.scenario.set({ ...A.scenario.get(), ...fields });
      refresh();
    },
    // Adds generated cards (and optionally scenario details) as a single undo step.
    applyGenerated({ cards = [], replace = false, scenario = null }) {
      structural();
      if (scenario && A.scenario) A.scenario.set(scenario);
      const added = cards.map(g => wrap(fromGenerated(g)));
      S.cards = replace ? added : S.cards.concat(added);
      clearFilters();
      refresh();
      select(added.map(c => c.uid), { anchor: added.length ? added[0].uid : null });
      return added.length;
    },
    load(data) {
      S.cards = data.map(wrap);
      S.anchor = S.cards.length ? S.cards[0].uid : null;
      S.sel = new Set(S.cards.length ? [S.cards[0].uid] : []);
      lastEdit = null;
      history.clear();
      typeSig = '';
      refresh({ editor: true });
      $('#cardList').scrollTop = 0;
    },
    append(data) {
      structural();
      const added = data.map(wrap);
      S.cards.push(...added);
      refresh();
      select(added.map(c => c.uid), { anchor: added[0] && added[0].uid });
    },
    add,
    duplicate,
    move,
    undo,
    redo,
    get canUndo() { return history.canUndo; },
    get canRedo() { return history.canRedo; },
    focusSearch() {
      const s = $('#search');
      s.focus();
      s.select();
    },
  };
})();
