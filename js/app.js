// App shell: file state, header buttons, tabs, shortcuts, drag-and-drop, toasts, theme.
//
// Two file kinds:
//   'cards'    — an AI Dungeon story card export: a JSON array of cards.
//   'scenario' — this editor's project file: { format, version, scenario, storyCards }.
(function () {
  'use strict';
  const A = (window.AIDE = window.AIDE || {});
  const $ = s => document.querySelector(s);
  const PROJECT_FORMAT = 'aid-scenario-editor';

  const file = { name: 'Untitled.scenario.json', handle: null, savedText: null, kind: 'scenario', cardsOnlyOk: false };

  function docText(kind = file.kind) {
    if (kind === 'cards') return A.cards.serialize();
    return JSON.stringify({ format: PROJECT_FORMAT, version: 1, scenario: A.scenario.get(), storyCards: A.cards.data() }, null, 2);
  }

  // A story card file can't hold scenario details, so unsaved details there count as changes.
  const scenarioAtRisk = () => file.kind === 'cards' && !A.scenario.isEmpty() && !file.cardsOnlyOk;
  const isDirty = () => docText() !== file.savedText || scenarioAtRisk();

  function confirmDiscard() {
    return !isDirty() || confirm('You have unsaved changes. Discard them?');
  }

  const baseName = name => name.replace(/(\.scenario)?\.json$/i, '').replace(/\.story-cards$/i, '');

  function setFile(name, handle, kind) {
    file.name = name;
    file.handle = handle;
    file.kind = kind;
    file.cardsOnlyOk = false;
    file.savedText = docText();
    $('#fileName').textContent = name;
    $('#fileName').title = (kind === 'cards' ? 'AI Dungeon story card file' : 'Scenario project file') + (handle ? '' : ' (Save will ask where to save)');
    updateDirty();
  }

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(msg, action, { error = false } = {}) {
    const el = $('#toast');
    el.className = 'toast' + (error ? ' error' : '');
    el.innerHTML = '';
    el.append(Object.assign(document.createElement('span'), { textContent: msg }));
    if (action) {
      const b = Object.assign(document.createElement('button'), { textContent: action.label });
      b.onclick = () => { el.hidden = true; action.run(); };
      el.append(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), error ? 7000 : action ? 6000 : 2200);
  }
  const fail = e => { console.error(e); toast(e.message || String(e), null, { error: true }); };

  // ---------- parsing ----------
  function parseDoc(text) {
    let data;
    try {
      data = JSON.parse(text.replace(/^﻿/, ''));
    } catch (e) {
      throw new Error('This file is not valid JSON (' + e.message + ').');
    }
    if (Array.isArray(data)) return { kind: 'cards', cards: A.cards.validate(data), scenario: null };
    if (data && typeof data === 'object' && Array.isArray(data.storyCards))
      return { kind: 'scenario', cards: A.cards.validate(data.storyCards), scenario: data.scenario || {} };
    throw new Error('Expected a story card file (a JSON array) or a scenario project file.');
  }

  // ---------- file actions ----------
  function loadResult(res) {
    const doc = parseDoc(res.text);
    A.scenario.set(doc.scenario || {});
    A.cards.load(doc.cards);
    setFile(res.name, res.handle, doc.kind);
    const same = res.text.replace(/^﻿/, '') === file.savedText;
    toast(`Opened ${res.name}: ${doc.cards.length} cards.` + (same ? '' : ' (Formatting will be normalised on save.)'));
  }

  async function open() {
    if (!confirmDiscard()) return;
    try {
      const res = await A.files.open();
      if (res) loadResult(res);
    } catch (e) { fail(e); }
  }

  async function importCards() {
    try {
      const res = await A.files.open();
      if (!res) return;
      const { cards } = parseDoc(res.text);
      A.cards.append(cards);
      toast(`Imported ${cards.length} cards from ${res.name}.`, { label: 'Undo', run: A.cards.undo });
    } catch (e) { fail(e); }
  }

  function newFile() {
    if (!confirmDiscard()) return;
    A.scenario.set({});
    A.cards.load([]);
    setFile('Untitled.scenario.json', null, 'scenario');
  }

  async function save() {
    if (scenarioAtRisk()) {
      const toProject = confirm(
        `${file.name} is an AI Dungeon story card file, which can only hold story cards.\n\n` +
          'OK: save everything (scenario details and cards) as a new scenario project file.\n' +
          'Cancel: save only the story cards to this file.',
      );
      if (toProject) {
        file.kind = 'scenario';
        file.handle = null;
        file.name = baseName(file.name) + '.scenario.json';
        return saveAs();
      }
      file.cardsOnlyOk = true;
    }
    if (!file.handle) return saveAs();
    const text = docText();
    try {
      await A.files.write(file.handle, text);
      file.savedText = text;
      updateDirty();
      toast(`Saved ${file.name}.`);
    } catch (e) { fail(e); }
  }

  async function saveAs() {
    const text = docText();
    try {
      const res = await A.files.saveAs(file.name, text);
      if (!res) return;
      const ok = file.cardsOnlyOk;
      if (res === 'download') {
        setFile(file.name, null, file.kind);
        toast(`Downloaded ${file.name}.`);
      } else {
        setFile(res.name, res, file.kind);
        toast(`Saved ${res.name}.`);
      }
      file.cardsOnlyOk = ok;
      updateDirty();
    } catch (e) { fail(e); }
  }

  async function exportCards(text, n) {
    try {
      const res = await A.files.saveAs(`${baseName(file.name)}-${n}-cards.json`, text);
      if (res) toast(`Exported ${n} cards.`);
    } catch (e) { fail(e); }
  }

  async function exportStoryCards() {
    try {
      const res = await A.files.saveAs(`${baseName(file.name)}.story-cards.json`, A.cards.serialize());
      if (res) toast(`Exported ${A.cards.count()} story cards for AI Dungeon.`);
    } catch (e) { fail(e); }
  }

  function updateDirty() {
    const dirty = isDirty();
    $('#dirtyDot').hidden = !dirty;
    document.title = (dirty ? '● ' : '') + file.name + ' — AID Scenario Editor';
  }
  let dirtyTimer = 0;
  function updateDirtySoon() {
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(updateDirty, 200);
  }

  function updateUndoButtons() {
    if (!A.cards) return;
    $('#btnUndo').disabled = !A.cards.canUndo;
    $('#btnRedo').disabled = !A.cards.canRedo;
  }

  // ---------- tabs ----------
  function showTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    $('#tab-cards').hidden = name !== 'cards';
    $('#tab-scenario').hidden = name !== 'scenario';
    try { localStorage.setItem('aide.tab', name); } catch {}
  }

  // ---------- theme ----------
  const THEMES = ['auto', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    $('#btnTheme').title = 'Theme: ' + t;
    try { localStorage.setItem('aide.theme', t); } catch {}
  }
  let theme = 'auto';
  try { theme = localStorage.getItem('aide.theme') || 'auto'; } catch {}

  // ---------- shortcuts ----------
  function inTextField(el) {
    return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(el.type)));
  }
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 's') { e.preventDefault(); e.shiftKey ? saveAs() : save(); }
    else if (ctrl && k === 'o') { e.preventDefault(); open(); }
    else if (ctrl && k === 'g') { e.preventDefault(); A.generate.open(); }
    else if (ctrl && k === 'f') { e.preventDefault(); showTab('cards'); A.cards.focusSearch(); }
    else if (ctrl && k === 'd') { e.preventDefault(); A.cards.duplicate(); }
    else if (e.altKey && k === 'n') { e.preventDefault(); showTab('cards'); A.cards.add(); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); A.cards.move(e.key === 'ArrowUp' ? -1 : 1); }
    else if (ctrl && !inTextField(document.activeElement) && (k === 'z' || k === 'y')) {
      e.preventDefault();
      (k === 'y' || (k === 'z' && e.shiftKey)) ? A.cards.redo() : A.cards.undo();
    }
  });

  // ---------- drag and drop ----------
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('#dropOverlay').hidden = false; } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
    const pending = A.files.fromDrop(e.dataTransfer);
    if (!pending) return;
    pending.then(res => { if (confirmDiscard()) loadResult(res); }).catch(fail);
  });

  window.addEventListener('beforeunload', e => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- boot ----------
  A.app = { open, toast, updateDirty, updateDirtySoon, updateUndoButtons, exportCards, exportStoryCards, showTab };

  $('#btnNew').addEventListener('click', newFile);
  $('#btnOpen').addEventListener('click', open);
  $('#btnImport').addEventListener('click', importCards);
  $('#btnSave').addEventListener('click', save);
  $('#btnSaveAs').addEventListener('click', saveAs);
  $('#btnUndo').addEventListener('click', () => A.cards.undo());
  $('#btnRedo').addEventListener('click', () => A.cards.redo());
  $('#btnTheme').addEventListener('click', () => applyTheme((theme = THEMES[(THEMES.indexOf(theme) + 1) % 3])));
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  applyTheme(theme);

  A.scenario.init();
  A.cards.init();
  A.generate.init();
  setFile(file.name, null, file.kind);
  let tab = 'cards';
  try { tab = localStorage.getItem('aide.tab') || 'cards'; } catch {}
  showTab(tab === 'scenario' ? 'scenario' : 'cards');
  updateUndoButtons();
  if (!A.files.fsOK)
    toast('This browser can’t save over files directly — Save will download a copy. Use Chrome or Edge for in-place saving.');
})();
