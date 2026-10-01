// Prompt and output-schema construction for generation requests.
// System blocks are byte-stable so they can be prompt-cached; everything that
// varies per request (limits, options, existing content) goes in the user turn.
const fs = require('fs');
const path = require('path');

const AIN_FILE = path.join(__dirname, '..', 'data', 'ain-repository.txt');
const CARD_CONTEXT_BUDGET = 150000; // characters of full card entries sent as context

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Card name' },
    type: { type: 'string', description: 'Category, e.g. character, location, faction' },
    keys: { type: 'string', description: 'Comma-separated triggers' },
    value: { type: 'string', description: 'The entry the AI reads' },
    description: { type: 'string', description: 'Short note for the author; may be empty' },
  },
  required: ['title', 'type', 'keys', 'value', 'description'],
  additionalProperties: false,
};

const CARDS_SCHEMA = {
  type: 'object',
  properties: { cards: { type: 'array', items: CARD_SCHEMA } },
  required: ['cards'],
  additionalProperties: false,
};

// Scenario fields in generation order: world facts before the opening, the opening
// before the instructions that steer how it continues.
const SCENARIO_FIELDS = ['title', 'description', 'tags', 'plotEssentials', 'opening', 'aiInstructions', 'authorsNote'];

const NOTES_PROP = {
  type: 'string',
  description:
    'Short note to the author: which repository set or lines you based the AI Instructions and Author\'s Note on and why, the repository\'s suggested AI Dungeon settings for the target model if it lists them, and anything the author should check. Empty if nothing to say.',
};

function fieldsSchema(fields) {
  const props = {};
  for (const f of SCENARIO_FIELDS) if (fields.includes(f)) props[f] = { type: 'string' };
  props.notes = NOTES_PROP;
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

function scenarioSchema() {
  const props = {};
  for (const f of SCENARIO_FIELDS) {
    props[f] = { type: 'string' };
    if (f === 'plotEssentials') props.cards = { type: 'array', items: CARD_SCHEMA };
  }
  props.notes = NOTES_PROP;
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

const BASE_SYSTEM = `You write content for AI Dungeon scenarios: interactive stories where a player types actions and an AI narrates. Your output is loaded straight into a scenario editor, so every field must be ready to use as-is.

## Story cards

A story card is a piece of world information. AI Dungeon inserts a card's entry into the AI's context whenever one of its triggers appears in the recent story text, so cards are how the AI remembers characters, places and rules that are not on screen.

Fields:
- title: the card's name (the character's full name, the place name, etc.).
- type: a short category. Reuse the types the scenario already uses whenever one fits; otherwise use a short lowercase word such as character, location, faction, item, race, class, creature or lore.
- keys: the triggers, comma-separated. Matching is case-insensitive and by substring. Include the forms that would naturally appear in the story: full name, first name, surname, titles, nicknames, short forms, plurals. Avoid generic words that would fire constantly ("man", "city", "sword"). A leading space (" Rex") stops a short trigger matching inside longer words; use it where that is a risk. Separate triggers with ", ".
- value: the entry the AI reads. Name the subject in the first sentence and make the entry self-contained, because the AI sees it without the card's title. Be concrete and dense: for characters cover appearance, personality, speech, motives, relationships and anything the story will need; for places, what is there, who is there, how it feels to be there and what can happen; for factions, goals, structure, allies and enemies; for items and rules, what they do and their limits. Write facts in present tense, as plain prose or a compact "Field: value" list. No markdown, no meta commentary, no instructions addressed to the AI.
- description: a one-line note for the scenario author (the AI never sees it). It may be empty.

Cards must agree with each other and with any scenario details and existing cards you are given. Never duplicate an existing card; new cards may mention existing ones by name. Prefer distinctive, specific details over generic fantasy or sci-fi filler, and give characters names that fit the setting.`;

function scenarioSystem() {
  let repo = '';
  try {
    repo = fs.readFileSync(AIN_FILE, 'utf8');
  } catch {
    repo = '(repository file not found)';
  }
  return `## Scenario fields

Besides story cards, an AI Dungeon scenario has these fields:
- title: the scenario's name. Short and evocative.
- description: one to three sentences shown to players before they start. Pitch the premise and the player's role.
- tags: a few comma-separated genre and theme tags.
- plotEssentials: text the AI always sees. Following the repository's advice, it holds raw information only: the player character's key details, the premise and current situation, scheduled events, and important past events written in past tense so the AI doesn't treat them as ongoing. Use the repository's "Key Details" format where it fits, wrapping related information in { } or [ ]. Keep it short: anything that only matters when a character, place or thing is mentioned belongs in a story card, not here.
- opening: the first passage of the story, which the player continues from. Present tense, two to five paragraphs, in the requested point of view (second person unless told otherwise). Establish who the player character is, where they are and an immediate situation, using the scenario's story cards for names, places and details. Stop at a moment that invites the player's first action.
- aiInstructions: the AI Instructions, built from the repository below. Start from the prebuilt set that suits the target AI Dungeon model (each set's heading lists the models it was written for; if no model is named, use the set for the newest models, DeepSeek 4 / GLM 5.x / Gemma 4) and the scenario's genre: for example the Adventure set for danger-driven adventure, the Long Form set for character-driven stories. Adapt it, then add only the few lines from other sections that solve problems this particular scenario is likely to have (difficulty and combat, romance pacing, knowledge isolation, name generation, setting-specific lines and so on). Do not copy the whole repository: it warns that too many instructions use up context and give worse results. Keep \${character.name} where the repository uses it for the player character, because AI Dungeon fills it in; replace every other placeholder (such as NAME or [SPECIES NAME]). Write the set's introductory sentence, then one instruction per line, each starting with "- ".
- authorsNote: the Author's Note, which AI Dungeon places close to the end of the context, so it steers strongly. The repository's author puts all "Push Lines" here. Write two to six lines, each starting with "- ", chosen from or modelled on the repository's Push Lines and the genre-specific lines (such as the Fantasy or Scifi style lines) that fit this scenario. Under 600 characters.

Everything must agree with the story cards and existing scenario text you are given: use their names, places, factions and facts, and don't contradict them.

<ai_instructions_repository>
${repo}
</ai_instructions_repository>`;
}

function systemBlocks() {
  return [
    { type: 'text', text: BASE_SYSTEM },
    { type: 'text', text: scenarioSystem(), cache_control: { type: 'ephemeral' } },
  ];
}

// ---------- context helpers ----------
const s = v => (v == null ? '' : String(v));

function cardIndex(cards) {
  return cards
    .slice(0, 1500)
    .map(c => `- ${c.title || '(unnamed)'} [${c.type || 'no type'}] triggers: ${s(c.keys).trim()}`)
    .join('\n');
}

// Full entries up to a character budget; anything past it is listed by name only.
function cardContext(cards) {
  if (!cards.length) return '';
  let used = 0;
  const full = [];
  const rest = [];
  for (const c of cards) {
    const block = `### ${s(c.title) || '(unnamed)'} [${s(c.type) || 'no type'}]\nTriggers: ${s(c.keys).trim()}\n${s(c.value).trim()}`;
    if (used + block.length <= CARD_CONTEXT_BUDGET) {
      full.push(block);
      used += block.length + 2;
    } else rest.push(c);
  }
  let out = `<story_cards count="${cards.length}">\n${full.join('\n\n')}`;
  if (rest.length) out += `\n\n(${rest.length} more cards, names only:)\n${cardIndex(rest)}`;
  return out + '\n</story_cards>\n\n';
}

const SCENARIO_LABELS = {
  title: 'Title',
  description: 'Description',
  tags: 'Tags',
  plotEssentials: 'Plot Essentials',
  opening: 'Opening',
  aiInstructions: 'AI Instructions',
  authorsNote: "Author's Note",
};

function scenarioContext(sc, tag = 'scenario') {
  if (!sc) return '';
  const parts = SCENARIO_FIELDS.filter(f => s(sc[f]).trim()).map(f => `[${SCENARIO_LABELS[f]}]\n${s(sc[f]).trim()}`);
  return parts.length ? `<${tag}>\n${parts.join('\n\n')}\n</${tag}>\n\n` : '';
}

const PLAYER_RULES = {
  'ask-name':
    'The player names their own character when the story starts. Use ${character.name} wherever the player character\'s name is needed and don\'t invent one; you may define the rest of who they are.',
  'ask-details':
    'The player creates their own character when the story starts. In Plot Essentials use the repository\'s Key Details block with its placeholders (${character.name}, ${Age:}, ${Gender:}, ${Appearance:}, ${Info:}); elsewhere call the player character ${character.name} and don\'t assume details the player will choose.',
  defined:
    'The scenario defines the player character. Give them a name and the details the story needs, and don\'t use ${} placeholders for them.',
};

function optionsText(req) {
  const lines = [];
  const model = s(req.aidModel).trim();
  lines.push(model
    ? `Target AI Dungeon model: ${model}. Use the repository content written for this model.`
    : 'Target AI Dungeon model: not specified (assume one of the newest: DeepSeek 4, GLM 5.x or Gemma 4).');
  lines.push(`Point of view: ${req.pov === 'third' ? 'third person, present tense' : 'second person, present tense'}.`);
  lines.push(PLAYER_RULES[req.player] || PLAYER_RULES['ask-name']);
  return lines.join('\n') + '\n';
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// ---------- builders ----------
function build(mode, req) {
  const limit = clampInt(req.limit, 100, 5000, 1000);
  const prompt = s(req.prompt).trim();
  const existing = Array.isArray(req.existingCards) ? req.existingCards : [];
  const cards = Array.isArray(req.cards) ? req.cards : [];
  const examples = Array.isArray(req.examples) ? req.examples.slice(0, 20) : [];
  const aim = Math.round(limit * 0.85);
  let user = '';

  if (mode === 'fields') {
    const fields = SCENARIO_FIELDS.filter(f => Array.isArray(req.fields) && req.fields.includes(f));
    if (!fields.length) throw new Error('Pick at least one field to generate.');
    user += cardContext(cards);
    user += scenarioContext(req.scenario, 'current_scenario');
    user += `Write these scenario fields: ${fields.map(f => SCENARIO_LABELS[f]).join(', ')}.\n`;
    user += optionsText(req);
    const hasCurrent = fields.some(f => req.scenario && s(req.scenario[f]).trim());
    if (hasCurrent)
      user += req.revise
        ? 'Where a requested field already has text, treat it as the author\'s draft: keep what is deliberate, fix problems, fill gaps and make it fit the story cards.\n'
        : 'Write the requested fields from scratch; their current text is shown only for context.\n';
    if (!cards.length) user += 'There are no story cards yet, so build from the scenario text and the request.\n';
    user += prompt ? `\n<request>\n${prompt}\n</request>` : '\nNo extra request: base everything on the story cards and current scenario.';
    return { system: systemBlocks(), user, schema: fieldsSchema(fields) };
  }

  if (mode === 'scenario') {
    const count = clampInt(req.count, 0, 60, 0);
    if (existing.length) user += `<existing_cards count="${existing.length}">\n${cardIndex(existing)}\n</existing_cards>\n\n`;
    user += 'Create a complete AI Dungeon scenario from the request below: every scenario field plus its story cards (the important characters, locations, factions, items and lore the premise and opening rely on).\n';
    user += count
      ? `Include about ${count} story cards.\n`
      : 'Include as many story cards as the scenario needs (usually 8 to 20).\n';
    if (existing.length) user += 'The scenario already has the cards listed above; build on them and do not repeat them.\n';
    user += optionsText(req);
    user += `Each card entry must stay under ${limit} characters; aim for about ${aim}.\n\n<request>\n${prompt}\n</request>`;
    return { system: systemBlocks(), user, schema: scenarioSchema() };
  }

  const count = clampInt(req.count, 0, 50, 0);
  user += scenarioContext(req.scenario);
  if (existing.length) user += `<existing_cards count="${existing.length}">\n${cardIndex(existing)}\n</existing_cards>\n\n`;
  if (examples.length)
    user += `<example_cards>\nMatch the style, structure and level of detail of these cards:\n${JSON.stringify(
      examples.map(c => ({ title: c.title, type: c.type, keys: c.keys, value: c.value })),
      null,
      1,
    )}\n</example_cards>\n\n`;
  user += count === 1
    ? 'Write exactly 1 new story card.\n'
    : count
      ? `Write exactly ${count} new story cards.\n`
      : 'Write as many new story cards as the request calls for.\n';
  if (req.type && s(req.type).trim()) user += `Give every card the type "${s(req.type).trim()}".\n`;
  user += `Each entry must stay under ${limit} characters; aim for about ${aim}.\n\n<request>\n${prompt}\n</request>`;
  return {
    system: [{ type: 'text', text: BASE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    user,
    schema: CARDS_SCHEMA,
  };
}

module.exports = { build, SCENARIO_FIELDS };
