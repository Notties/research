'use strict';
// The reference documents that SKILL.md points to (references/*.md). The five tests that carry the plan's names are the
// plan's. The others pin what the plan only implies: the zone and group ids and colors come from shared.js and createMap
// and not from memory, spec section 8 is copied word for word, every JSON example in the documents is one that
// dr.cjs accepts (the examples are what research subagents copy), and no document holds an invisible character.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('../assets/shared.js');
const { createMap, mergeFragment } = require('../scripts/lib/map.cjs');
const { validateMap } = require('../scripts/lib/validate.cjs');

const ROOT = path.join(__dirname, '..');
const DR = path.join(ROOT, 'scripts', 'dr.cjs');
const DOCS = ['structure.md', 'map-schema.md', 'rigor.md', 'subagent-brief.md', 'expansion.md'];
const doc = name => fs.readFileSync(path.join(ROOT, 'references', name), 'utf8');

const BRIEF = { goal: 'สร้างงาน', level: 'ไม่รู้เลย', focus: '', exclude: '', depth: 'standard', constraints: '' };
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const allNodes = (node, out = []) => { out.push(node); for (const c of node.children ?? []) allNodes(c, out); return out; };

// A fragment merged under the planned group g-know-1 of a new map, which is what every fragment example is written for.
function mergedMap(fragment) {
  const map = createMap({ topic: 'ทดสอบ', slug: 'docs-example', brief: BRIEF });
  mergeFragment(map, 'g-know-1', fragment);
  return map;
}

// ---- Markdown helpers ----

// The outermost fenced code blocks of a Markdown text, as { lang, body }. A fence is a line of 3 or more backticks (or
// tildes), indented at most 3 spaces. It closes at a line of the same character, at least as long, with nothing after
// it, so a longer outer fence holds shorter ones as plain text. That is how subagent-brief.md holds its template.
function fences(markdown) {
  const blocks = [];
  let open = null;
  for (const line of markdown.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        open = { char: fence[1][0], size: fence[1].length, lang: fence[2].trim().split(/\s+/)[0], lines: [] };
      }
    } else if (fence && fence[1][0] === open.char && fence[1].length >= open.size && fence[2].trim() === '') {
      blocks.push({ lang: open.lang, body: open.lines.join('\n') });
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  assert.equal(open, null, 'a code fence is never closed');
  return blocks;
}

// The ```json blocks of a document, and the ones inside a ```text block (the template of subagent-brief.md), in order.
function jsonBlocks(markdown) {
  return fences(markdown).flatMap(block => {
    if (block.lang === 'json') return [block.body];
    if (block.lang === 'text') return fences(block.body).filter(inner => inner.lang === 'json').map(inner => inner.body);
    return [];
  });
}

// What a JSON example is an example of, judged by its keys.
function kindOf(value) {
  if (!isObj(value)) return null;
  if (isObj(value.sources) && (value.self !== undefined || value.children !== undefined)) return 'fragment';
  if (!('sources' in value) && ['summary', 'readingPath', 'forYou', 'rootSummary'].some(key => key in value)) return 'synthesis';
  if ('goal' in value && 'depth' in value) return 'brief';
  return null;
}

const examples = () => DOCS.flatMap(name => jsonBlocks(doc(name)).map((body, i) => ({ name, i, body })));

// ---- the plan's five tests ----

test('structure lists all zones and groups', () => {
  const text = doc('structure.md');
  for (const zone of S.ZONES) assert.ok(text.includes(zone.label), `zone ${zone.label}`);
  const groups = Object.values(S.DEFAULT_GROUPS).flat();
  assert.equal(groups.length, 18);
  for (const group of groups) assert.ok(text.includes(group), `group ${group}`);
});

test('expansion lists all directions', () => {
  const text = doc('expansion.md');
  assert.equal(S.DIRECTIONS.length, 6);
  for (const direction of S.DIRECTIONS) assert.ok(text.includes(direction.label), `direction ${direction.label}`);
});

test('rigor keeps the key rules', () => {
  const text = doc('rigor.md');
  assert.ok(text.includes('อย่างน้อย 2 แหล่ง'));
  assert.ok(text.includes('ห้ามอ้างจากความจำ'));
});

const PLACEHOLDERS = ['{{TOPIC}}', '{{BRIEF}}', '{{PARENT_ID}}', '{{QUESTIONS}}', '{{DEPTH_LEVELS}}', '{{SOURCE_TARGET}}', '{{FRAGMENT_PATH}}'];

test('brief has all placeholders', () => {
  const text = doc('subagent-brief.md');
  for (const placeholder of PLACEHOLDERS) assert.ok(text.includes(placeholder), placeholder);
});

test('schema example merges', () => {
  const [first] = jsonBlocks(doc('map-schema.md'));
  assert.ok(first, 'map-schema.md has no json block');
  const fragment = JSON.parse(first);
  assert.equal(kindOf(fragment), 'fragment', 'the first json block of map-schema.md is the complete fragment example');
  const map = createMap({ topic: 'ทดสอบ', slug: 'docs-example', brief: BRIEF });
  const { added } = mergeFragment(map, 'g-know-1', fragment);
  assert.ok(added.length >= 1);
  assert.deepEqual(validateMap(map), { ok: true, errors: [] });
});

// ---- structure.md ----

test('structure carries the zone ids and colors of shared.js, and the group ids of createMap', () => {
  const lines = doc('structure.md').split('\n');
  // The rows of the two tables, not any line that happens to name a group: the examples further down name some too.
  for (const zone of S.ZONES) {
    const row = lines.find(l => l.startsWith(`| ${zone.label} | \`${zone.id}\` |`));
    assert.ok(row, `the zone table row of ${zone.label} with its id ${zone.id}`);
    assert.ok(row.includes(zone.color), `${zone.label}: ${zone.color}`);
  }
  const map = createMap({ topic: 'ทดสอบ', slug: 'docs-example', brief: BRIEF });
  const groups = map.root.children.flatMap(zone => zone.children);
  assert.equal(groups.length, 18);
  for (const group of groups) {
    assert.ok(lines.some(l => l.startsWith(`| \`${group.id}\` | ${group.title} |`)), `the group table row of ${group.id} ${group.title}`);
  }
});

test('structure gives the depth presets of shared.js and the adaptation examples', () => {
  const text = doc('structure.md');
  const lines = text.split('\n');
  for (const [id, depth] of Object.entries(S.DEPTHS)) {
    const row = lines.find(l => l.includes(`\`${id}\``) && l.includes(depth.label));
    assert.ok(row, `a row for ${id}`);
    assert.ok(row.includes(String(depth.sources)), `${id}: ${depth.sources} sources`);
    assert.ok(row.includes(depth.minutes), `${id}: ${depth.minutes} minutes`);
  }
  for (const name of ['ตลาดและคู่แข่ง', 'หลักฐานทางการแพทย์', 'ความปลอดภัย']) assert.ok(text.includes(name), name);
});

test('structure splits the sources of each depth over the zones by their group counts', () => {
  const lines = doc('structure.md').split('\n');
  const cells = row => row.split('|').slice(1, -1).map(c => c.trim());
  const rows = S.ZONES.map(zone => {
    const row = lines.find(l => new RegExp(`^\\| ${zone.label} \\| \\d+ \\|`).test(l));
    assert.ok(row, `the source split row of ${zone.label}`);
    return { zone, cells: cells(row).map(Number).slice(1) }; // groups, quick, standard, deep
  });
  for (const { zone, cells: [groups] } of rows) assert.equal(groups, S.DEFAULT_GROUPS[zone.id].length, `${zone.label}: group count`);
  const total = lines.find(l => l.startsWith('| รวม |'));
  assert.ok(total, 'the total row of the source split');
  ['quick', 'standard', 'deep'].forEach((depth, i) => {
    const column = rows.map(r => r.cells[i + 1]);
    assert.ok(column.every(n => n >= 3), `${depth}: at least 3 sources in every zone`);
    assert.equal(column.reduce((a, b) => a + b, 0), S.DEPTHS[depth].sources, `${depth}: the zones add up to the depth's sources`);
    assert.equal(cells(total)[i + 2], String(S.DEPTHS[depth].sources), `${depth}: the total row`);
  });
});

test('structure describes the plan preview: planned nodes, the cut and add questions, the go-ahead', () => {
  const text = doc('structure.md');
  for (const word of ['planned', 'multiSelect', 'เริ่มขุด', 'validate', 'render']) assert.ok(text.includes(word), word);
});

// ---- expansion.md ----

test('expansion gives each direction a heading with its label and id', () => {
  const headings = doc('expansion.md').split('\n').filter(l => /^#{2,4} /.test(l));
  for (const direction of S.DIRECTIONS) {
    assert.ok(headings.some(h => h.includes(direction.label) && h.includes(`\`${direction.id}\``)), `a heading for ${direction.id}`);
  }
});

test('expansion states the budget and the queue lifecycle', () => {
  const text = doc('expansion.md');
  assert.ok(text.includes('+1 ชั้น, 3–8 แหล่ง, 1–3 นาที'));
  for (const command of ['accept', 'start', 'merge', 'finish', 'mark-checked']) {
    assert.ok(text.includes(`dr.cjs" ${command} `), `the lifecycle command ${command}`);
  }
});

test('expansion explains the offline queue and why its items stay on one origin', () => {
  const text = doc('expansion.md');
  for (const word of ['คิวรอขุด', 'คัดลอกคำสั่ง', 'localStorage', '--queue', 'dr.cjs" enqueue ', 'origin', 'file://', '7357']) {
    assert.ok(text.includes(word), word);
  }
});

// ---- rigor.md ----

// Spec section 8, rules 1 to 8, as the spec words them. rigor.md copies them, so this is a copy of a copy: if one changes,
// the other must change with it.
const RULES = [
  '**ลำดับแหล่ง:** เอกสารทางการ สเปก หรือผู้เขียนต้นฉบับ → สื่อหรืองานวิจัยที่น่าเชื่อถือ → ชุมชนที่เป็นที่ยอมรับ เช่น บล็อกที่มีชื่อ หรือ repo ที่ยังมีคนดูแล → ฟอรัมและวิดีโอ ซึ่งใช้ดูมุมมองคนทำงานจริงได้ แต่ห้ามเป็นแหล่งเดียวของข้อเท็จจริง',
  'ทุก point ต้องมีอ้างอิงอย่างน้อย 1 แหล่ง ข้อสำคัญต้องมีอย่างน้อย 2 แหล่งที่เป็นอิสระต่อกัน ถ้ามีแหล่งเดียวต้องติดป้ายว่า "แหล่งเดียว" และลดระดับความมั่นใจ ข้อสำคัญได้แก่ ข้อที่อยู่ในสรุป 1 นาที คำแนะนำ และตัวเลข',
  'อ้างอิงได้เฉพาะ URL ที่เปิดอ่านจริงในการรีเสิร์ชครั้งนั้น ห้ามอ้างจากความจำ',
  'บันทึกวันที่เผยแพร่ (ถ้ามี) และวันที่เข้าถึง หัวข้อที่เปลี่ยนเร็วให้ติดป้ายข้อมูลที่เก่ากว่าประมาณ 2 ปี',
  'ถ้าแหล่งขัดกัน ให้แสดงทั้งสองฝั่งพร้อมอ้างอิงใน `conflicts`',
  'แยกป้ายข้อเท็จจริง ความเห็น และค่าประมาณ',
  '**ระดับความมั่นใจ:**',
  'สูง: แหล่งแข็งแรงอย่างน้อย 2 แหล่งเห็นตรงกัน',
  'กลาง: แหล่งแข็งแรง 1 แหล่ง หรือแหล่งอ่อนหลายแหล่ง',
  'ต่ำ: แหล่งอ่อน หรือแหล่งขัดกัน',
  'ทุกระดับต้องมีเหตุผลกำกับ',
  'เรื่องที่ยังสรุปไม่ได้ให้ใส่ไว้ในกลุ่ม "คำถามที่ยังเปิดอยู่"',
];

test('rigor copies spec section 8 rules 1 to 8 word for word, in order', () => {
  const text = doc('rigor.md');
  let from = 0;
  for (const rule of RULES) {
    const at = text.indexOf(rule, from);
    assert.ok(at !== -1, `rule text missing or out of order: ${rule.slice(0, 40)}`);
    from = at + rule.length;
  }
});

test('rigor says how each rule is encoded in the data', () => {
  const text = doc('rigor.md');
  for (const word of ['key', 'singleSource', 'confidenceReason', 'conflicts', 'counterpoints', 'publishedAt', 'accessedAt', 'เก่ากว่า 2 ปี', 'fact', 'opinion', 'estimate']) {
    assert.ok(text.includes(word), word);
  }
  for (const type of S.SOURCE_TYPES) assert.ok(text.includes(`\`${type}\``), `source type ${type}`);
  for (const level of S.CONFIDENCE) assert.ok(text.includes(`\`${level}\``), `confidence ${level}`);
});

// ---- subagent-brief.md ----

// The template is the one ```text block. The lines [[GROUP-BLOCK-START]] and [[GROUP-BLOCK-END]] mark the part that
// SKILL.md repeats for each group of the zone.
function template() {
  const blocks = fences(doc('subagent-brief.md')).filter(block => block.lang === 'text');
  assert.equal(blocks.length, 1, 'subagent-brief.md has exactly one ```text block, the template');
  return blocks[0].body;
}

test('brief uses no placeholder other than the seven', () => {
  const found = new Set(doc('subagent-brief.md').match(/\{\{[^}]*\}\}/g) ?? []);
  assert.deepEqual([...found].sort(), [...PLACEHOLDERS].sort());
});

test('brief keeps the per-group placeholders inside the group block and the others outside it', () => {
  const text = template();
  const start = text.indexOf('[[GROUP-BLOCK-START]]');
  const end = text.indexOf('[[GROUP-BLOCK-END]]');
  assert.ok(start !== -1 && end > start, 'the group block markers');
  assert.equal(text.indexOf('[[GROUP-BLOCK-START]]', start + 1), -1, 'one group block');
  const inside = text.slice(start, end);
  const outside = text.slice(0, start) + text.slice(end);
  for (const placeholder of ['{{PARENT_ID}}', '{{QUESTIONS}}', '{{FRAGMENT_PATH}}']) {
    assert.ok(inside.includes(placeholder), `${placeholder} is in the group block`);
    assert.ok(!outside.includes(placeholder), `${placeholder} is only in the group block`);
  }
  for (const placeholder of ['{{TOPIC}}', '{{BRIEF}}', '{{DEPTH_LEVELS}}', '{{SOURCE_TARGET}}']) {
    assert.ok(outside.includes(placeholder), `${placeholder} is outside the group block`);
    assert.ok(!inside.includes(placeholder), `${placeholder} is not in the group block`);
  }
});

test('brief tells the subagent which tools to use, what to record and how to answer', () => {
  const text = template();
  for (const word of [
    'WebSearch', 'WebFetch', 'agent-reach read', 'agent-reach channels', // the three ways to search and read
    'accessedAt', 'publishedAt', 'counterpoints', 'conflicts', 'singleSource', 'confidenceReason',
    'เบราว์เซอร์ในแอป', 'ปิดแท็บ', // the in-app browser only for pages WebFetch cannot render, in a tab of its own
    'ภาษาไทย', 'Write',
    'วันที่วันนี้', // accessedAt is the date SKILL.md passes in, not one that a subagent guesses
  ]) assert.ok(text.includes(word), word);
  assert.ok(doc('subagent-brief.md').includes('"- วันที่วันนี้: YYYY-MM-DD"'), 'the assembly steps tell Claude to end {{BRIEF}} with the date');
});

// ---- map-schema.md ----

test('schema example is rich enough to copy', () => {
  const fragment = JSON.parse(jsonBlocks(doc('map-schema.md'))[0]);
  const sources = Object.values(fragment.sources);
  assert.ok(sources.length >= 2);
  assert.ok(new Set(sources.map(s => s.type)).size >= 2, 'sources of different types');
  assert.ok(sources.some(s => typeof s.publishedAt === 'string'), 'a source with a publishedAt');
  const nodes = (fragment.children ?? []).flatMap(c => allNodes(c));
  const points = nodes.flatMap(n => n.points ?? []);
  assert.ok(points.some(p => p.key === true && new Set(p.cites).size >= 2), 'a key point with 2 independent cites');
  assert.ok(points.some(p => p.key === true && p.singleSource === true), 'a key point that is marked singleSource');
  for (const type of S.POINT_TYPES) assert.ok(points.some(p => p.type === type), `a ${type} point`);
  assert.ok(nodes.some(n => (n.counterpoints ?? []).length > 0), 'a counterpoint');
  for (const n of nodes.filter(node => (node.points ?? []).length > 0)) {
    assert.ok(S.CONFIDENCE.includes(n.confidence) && typeof n.confidenceReason === 'string' && n.confidenceReason !== '', `confidence and a reason on ${n.title}`);
  }
  assert.ok((fragment.children ?? []).some(c => (c.children ?? []).length > 0), 'nested children');
});

test('schema documents every field, type, status and depth that the data takes', () => {
  const text = doc('map-schema.md');
  const quoted = word => text.includes(`\`${word}\``);
  for (const field of ['schemaVersion', 'topic', 'slug', 'createdAt', 'updatedAt', 'brief', 'summary', 'findings', 'startTomorrow', 'readingPath', 'sources', 'queue', 'root',
    'id', 'title', 'level', 'zone', 'status', 'why', 'points', 'cites', 'key', 'singleSource', 'conflicts', 'counterpoints', 'forYou', 'confidence', 'confidenceReason',
    'related', 'logo', 'researchedAt', 'expansions', 'children', 'publisher', 'publishedAt', 'accessedAt', 'url', 'rootSummary', 'self']) {
    assert.ok(quoted(field), `field ${field}`);
  }
  for (const list of [S.POINT_TYPES, S.SOURCE_TYPES, S.CONFIDENCE, S.STATUSES, Object.keys(S.DEPTHS)]) {
    for (const word of list) assert.ok(quoted(word), `value ${word}`);
  }
  for (const word of ['goal', 'level', 'focus', 'exclude', 'depth', 'constraints']) assert.ok(quoted(word), `brief field ${word}`);
});

test('schema states the node id rule and which fragment fields merge ignores', () => {
  const text = doc('map-schema.md');
  // The slug row also says a-z0-9, so the rule is looked for in the node id row itself.
  const idRow = text.split('\n').find(l => l.startsWith('| `id` |') && l.includes('a-z0-9-'));
  assert.ok(idRow, 'the node id row says: lowercase letters, digits and hyphens (a-z0-9-)');
  for (const word of ['`:`', '`;`']) assert.ok(idRow.includes(word), `ids must not hold ${word}`);
  const mergeRule = text.split('\n').find(l => l.startsWith('- **children:**'));
  assert.ok(mergeRule, 'the children rule of merge');
  for (const word of ['`id`', '`status`', '`researchedAt`', '`expansions`']) assert.ok(mergeRule.includes(word), `merge ignores ${word}`);
});

// ---- every JSON example ----

test('every JSON example in the references parses and is a fragment, a brief or a synthesis file', () => {
  const found = examples();
  assert.ok(found.length >= 3, 'the references hold at least the fragment, the brief and the synthesis example');
  for (const { name, i, body } of found) {
    let value;
    assert.doesNotThrow(() => { value = JSON.parse(body); }, `${name} json block ${i + 1} is not valid JSON`);
    assert.ok(kindOf(value) !== null, `${name} json block ${i + 1} is neither a fragment, a brief nor a synthesis file (use a jsonc block for a snippet)`);
  }
  for (const kind of ['fragment', 'brief', 'synthesis']) {
    assert.ok(found.some(e => kindOf(JSON.parse(e.body)) === kind), `an example of a ${kind}`);
  }
});

test('every fragment example merges under a planned group and the map validates', () => {
  const fragments = examples().filter(e => kindOf(JSON.parse(e.body)) === 'fragment');
  assert.ok(fragments.length >= 2, 'the first example of map-schema.md and one more');
  for (const { name, i, body } of fragments) {
    const map = mergedMap(JSON.parse(body));
    assert.deepEqual(validateMap(map), { ok: true, errors: [] }, `${name} json block ${i + 1}`);
  }
});

// The error table of map-schema.md quotes what merge prints. Each message is made here by the real code, so that the table
// cannot drift from the validator's words. A path such as root.children[0]... is left out of the quote, as in the table.
test('the merge errors that map-schema.md quotes are the ones the code prints', () => {
  const valid = () => ({
    sources: {
      s1: { title: 'T', url: 'https://example.com/a', publisher: 'P', type: 'official', accessedAt: '2026-11-02' },
      s2: { title: 'U', url: 'https://example.org/b', publisher: 'P', type: 'secondary', accessedAt: '2026-11-02' },
    },
    children: [{ title: 'a', points: [{ text: 'x', type: 'fact', key: true, cites: ['s1', 's2'] }], confidence: 'high', confidenceReason: 'r' }],
  });
  const printed = change => {
    const fragment = valid();
    change(fragment);
    const map = createMap({ topic: 'ทดสอบ', slug: 'docs-example', brief: BRIEF });
    try {
      mergeFragment(map, 'g-know-1', fragment);
    } catch (err) {
      return err.message; // what mergeFragment refuses, before any validation
    }
    const { ok, errors } = validateMap(map);
    assert.equal(ok, false, 'the change must make the fragment fail');
    return errors.join('\n');
  };
  const cases = [
    ['unknown cite "s9"', f => { f.children[0].points[0].cites = ['s1', 's9']; }],
    ['key point needs 2 sources or singleSource', f => { f.children[0].points[0].cites = ['s1']; }],
    ['confidence: must be one of high, medium, low when a checking node has points', f => { delete f.children[0].confidence; }],
    ['confidenceReason: must be non-empty', f => { delete f.children[0].confidenceReason; }],
    ['points[0].type: must be one of fact, opinion, estimate', f => { f.children[0].points[0].type = 'claim'; }],
    ['related[0]: unknown node "g-nope-9"', f => { f.children[0].related = ['g-nope-9']; }],
    ['accessedAt: must be a date string', f => { delete f.sources.s1.accessedAt; }],
    ['url: must start with http:// or https://', f => { f.sources.s1.url = 'www.example.com'; }],
    ['fragment node needs a title', f => { delete f.children[0].title; }],
  ];
  const table = doc('map-schema.md').split('\n').filter(l => l.startsWith('| `'));
  for (const [quote, change] of cases) {
    assert.ok(printed(change).includes(quote), `the code no longer prints: ${quote}`);
    assert.ok(table.some(row => row.includes(quote)), `the error table does not quote: ${quote}`);
  }
});

function dr(args, options) {
  const run = spawnSync(process.execPath, [DR, ...args], { encoding: 'utf8', timeout: 60000, ...options });
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  return { status: run.status, stderr: run.stderr, json: lines.length ? JSON.parse(lines.at(-1)) : null };
}

test('the documented brief, fragment and synthesis file work together through dr.cjs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pick = kind => {
    const hit = jsonBlocks(doc('map-schema.md')).find(body => kindOf(JSON.parse(body)) === kind);
    assert.ok(hit, `map-schema.md has a ${kind} example`);
    const file = path.join(root, `${kind}.json`);
    fs.writeFileSync(file, hit);
    return file;
  };
  const brief = pick('brief');
  const fragment = pick('fragment');
  const synthesis = pick('synthesis');
  const slug = 'docs-example';

  const init = dr(['init', '--slug', slug, '--brief', brief, '--root', root]);
  assert.equal(init.status, 0, JSON.stringify(init.json));
  const dir = init.json.dir;
  const merge = dr(['merge', dir, '--parent', 'g-know-1', '--fragment', fragment]);
  assert.equal(merge.status, 0, JSON.stringify(merge.json));
  assert.ok(merge.json.added.length >= 1);
  const synthesize = dr(['synthesize', dir, '--file', synthesis]);
  assert.equal(synthesize.status, 0, JSON.stringify(synthesize.json));
  const checked = dr(['mark-checked', dir]);
  assert.equal(checked.status, 0, JSON.stringify(checked.json));
  assert.deepEqual(dr(['validate', dir]).json, { ok: true });
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
  assert.ok(map.summary.findings.length >= 1 && map.readingPath.length >= 1, 'the synthesis was applied');
  assert.ok(allNodes(map.root).every(n => n.status !== 'checking'), 'mark-checked left nothing checking');

  // The error table of map-schema.md also quotes the message for a fragment file that is not JSON.
  const before = fs.readFileSync(path.join(dir, 'map.json'), 'utf8');
  const broken = path.join(root, 'broken.json');
  fs.writeFileSync(broken, '{ "sources": ');
  const refused = dr(['merge', dir, '--parent', 'g-know-2', '--fragment', broken]);
  assert.equal(refused.status, 1);
  assert.match(refused.json.error, /^fragment file .+ is not valid JSON: /);
  assert.ok(doc('map-schema.md').includes('`fragment file … is not valid JSON: …`'));
  assert.equal(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'), before, 'a refused merge leaves map.json as it was');
});

// ---- all documents ----

test('every dr.cjs command line in the references names a command that exists', () => {
  const run = dr([]);
  const names = /use one of: ([^)]+)\)/.exec(run.json.error)?.[1].split(', ');
  assert.ok(names && names.length >= 12, 'dr.cjs lists its commands when it is given none');
  let seen = 0;
  for (const name of DOCS) {
    for (const [, command] of doc(name).matchAll(/dr\.cjs" ([a-z][a-z-]*)/g)) {
      seen += 1;
      assert.ok(names.includes(command), `${name}: "${command}" is not a dr.cjs command`);
    }
  }
  assert.ok(seen >= 6, 'the references show the commands');
});

test('every <skill_dir> path in the references names a file that exists', () => {
  let seen = 0;
  for (const name of DOCS) {
    for (const [, relative] of doc(name).matchAll(/<skill_dir>\/((?:references|scripts|assets)\/[\w.\/-]+)/g)) {
      seen += 1;
      assert.ok(fs.existsSync(path.join(ROOT, relative)), `${name}: ${relative} does not exist`);
    }
  }
  assert.ok(seen >= 8, 'the references point at the scripts and at each other');
});

test('every Markdown table in the references has a separator row and the same number of cells in every row', () => {
  const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').length;
  let tables = 0;
  for (const name of DOCS) {
    let fence = null; // the fence that is open, if any: its character and length
    let run = [];
    const flush = () => {
      if (run.length === 0) return;
      tables += 1;
      assert.ok(run.length >= 3, `${name}: a table of ${run.length} lines (header, separator and a row at least): ${run[0].slice(0, 40)}`);
      assert.match(run[1], /^\|[\s:|-]+\|$/, `${name}: the second line of a table is its separator: ${run[0].slice(0, 40)}`);
      for (const row of run) assert.equal(cells(row), cells(run[0]), `${name}: a row with ${cells(row)} cells in a table of ${cells(run[0])}: ${row.slice(0, 60)}`);
      run = [];
    };
    for (const line of doc(name).split('\n')) {
      const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence === null && mark) { flush(); fence = { char: mark[1][0], size: mark[1].length }; continue; }
      if (fence !== null) {
        if (mark && mark[1][0] === fence.char && mark[1].length >= fence.size && line.trim() === mark[1]) fence = null;
        continue;
      }
      if (line.startsWith('|')) run.push(line); else flush();
    }
    flush();
  }
  assert.ok(tables >= 15, 'the references hold their tables');
});

// Built from code points, so that this file holds no invisible character itself.
const INVISIBLE = new RegExp(`[${[
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xa0, 0xa0], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff],
].map(([from, to]) => String.fromCharCode(from) + (to > from ? `-${String.fromCharCode(to)}` : '')).join('')}]`);

test('the reference documents hold no invisible character and no carriage return', () => {
  for (const name of DOCS) {
    const text = doc(name);
    assert.ok(text.length > 500, `${name} is not empty`);
    const hit = INVISIBLE.exec(text);
    assert.equal(hit, null, `${name} holds U+${hit ? hit[0].codePointAt(0).toString(16) : ''}`);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${name} ends with one newline`);
    assert.ok(/^# \S/.test(text), `${name} starts with a heading`);
  }
});
