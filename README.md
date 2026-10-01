# AID Scenario Editor

A local GUI for editing AI Dungeon scenarios: story cards plus scenario details (title, description,
opening, plot essentials, AI Instructions, Author's Note), with generation by Claude.

## Run

The AI Instructions and Author's Note generators read `data/ain-repository.txt`, a community
collection of AI Dungeon instructions. It is not included in this repository; place your own copy
there. Without it, generation still works, just without the repository as a reference.

First time only, install dependencies:

```
npm install
```

Then double-click `start.cmd`, or run:

```
node serve.js
```

This opens http://localhost:5178. Use Chrome or Edge so **Save** writes straight back to the opened file.
In other browsers, Save downloads a copy.

## Generate with Claude

Click **⚙** to choose how the editor reaches Claude:

- **Claude subscription (Pro / Max)**: the default. Requests run through the Claude Code CLI
  (`claude -p`), so they use your plan's usage limits with no per-request charge. The CLI must be
  installed and signed in: run `claude auth login` once in a terminal. Each request runs in an
  empty temporary folder with all tools disabled and safe mode on, so Claude Code only writes text.
- **Anthropic API key**: billed per request. Paste a key from console.anthropic.com, or set
  `ANTHROPIC_API_KEY` before starting. The key is stored in `config.local.json` and used only by
  the local server; it is never sent to the page.

Model (default Claude Opus 5.5) and effort (default medium) are set in the same dialog and apply to both.

**✦ Generate** (Ctrl+G) opens the generator:

- **Story cards**: describe what you want, and set how many (1 for a single card, blank for Claude to decide).
  You can fix the type and show Claude the existing card list (to avoid duplicates and stay consistent),
  the selected cards (as style examples) and the scenario details.
- **Scenario fields**: write or improve any of Title, Description, Tags, Opening, Plot Essentials,
  AI Instructions and Author's Note (default: the last three). Claude reads your story cards (full
  entries, up to ~150k characters, then names only), the current scenario text and the AIN repository.
  Options:
  - **AI Dungeon model**: picks the repository set written for that model.
  - **Player character**: the player picks a name (`${character.name}`), the player creates their
    character (Key Details placeholders), or the scenario defines them.
  - **Point of view**: second or third person.
  - **Improve existing text**: revise what's there instead of starting over.

  The request box is optional. Results come back as editable text with Claude's notes: which
  repository set it used, the repository's suggested settings for your model, and problems it spotted
  in your cards. Each field in the Scenario tab also has its own **✦** button.
- **Full scenario**: describe the premise. Claude writes every scenario field and the story cards. The AI
  Instructions and Author's Note are built from `data/ain-repository.txt`. Choose whether the cards
  replace or add to the current ones.

Results are shown for review first; untick cards you don't want. Applying is one undo step.
Requests use structured JSON output and stream progress. With an API key, refused requests are
retried on Anthropic's recommended fallback model.

To test the UI without API calls, start with `AIDE_MOCK=1` (e.g. `set AIDE_MOCK=1 && node serve.js`).

## Files

- **Story card file**: an AI Dungeon export, which is a JSON array of cards. Opening and saving
  keeps it in that format. Scenario details can't be stored in it; Save offers to switch to a project file.
- **Scenario project** (`*.scenario.json`): this editor's format,
  `{ format, version, scenario, storyCards }`. Use **Export story cards…** (Scenario tab) to write
  the card file that AI Dungeon imports, and the **Copy** buttons to paste the other fields into AI Dungeon.

## Story cards

- Open a story card export (`.json` array), or drag one onto the window.
- Search, filter by type, sort, and show only cards with warnings.
- Edit Name, Type, Triggers, Entry, Notes and the four option flags.
- Leading and trailing spaces in triggers are kept and shown as `␣`.
- Warnings cover a missing name, triggers or entry, and entries over the "Warn over" length (default 1000).
- Info notes list triggers and names that other cards also use. Click a name to jump to that card.
- Multi-select with Shift/Ctrl+click or Shift+↑↓. You can then set the type or flags on every selected card, or duplicate, export or delete them.
- Import… appends cards from another file.
- Undo/redo covers every change.
- Unknown fields and key order are preserved. Saving an unedited file reproduces it byte for byte.

| Shortcut | Action |
|---|---|
| Ctrl+S / Ctrl+Shift+S | Save / Save As |
| Ctrl+O | Open |
| Ctrl+G | Generate with Claude (Ctrl+Enter in the prompt starts it) |
| Alt+N | New card |
| Ctrl+D | Duplicate |
| Ctrl+F | Search |
| Ctrl+Z / Ctrl+Y | Undo / Redo (outside text fields) |
| Alt+↑ / Alt+↓ | Move card (File order view) |
| Del (in list) | Delete selected |

## Layout

```
index.html          app shell (tabs for future editors)
css/app.css         styles (light/dark)
js/files.js         open/save (File System Access API with fallbacks)
js/history.js       undo/redo
js/storycards.js    story card model, list and editor
js/scenario.js      scenario details tab
js/generate.js      generator + settings dialogs, streaming client
js/app.js           file state, tabs, shortcuts, drag & drop
serve.js            localhost server: static files + /api/* (key stays server-side)
server/claude.js    settings, provider dispatch, API calls, error messages, mock mode
server/claude-code.js  generation via the Claude Code CLI (subscription)
server/prompts.js   system prompts and JSON output schemas
data/               AIN repository used for AI Instructions / Author's Note
samples/            example story card file
```
