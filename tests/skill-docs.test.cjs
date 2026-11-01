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

// rigor.md copies section 8 of the design spec, which lives beside the skill's repository in C:\_research\docs. The test
// reads the spec itself and compares whole lines, so there is no second typed copy that could drift. It is skipped, and
// says so, on a machine that does not have the spec; DR_SPEC names another place for it.
const SPEC = process.env.DR_SPEC ?? path.join(ROOT, '..', '..', 'docs', 'superpowers', 'specs', '2026-11-01-deep-research-skill-design.md');

test('rigor copies spec section 8 rules 1 to 8 line for line', { skip: !fs.existsSync(SPEC) && `the design spec is not at ${SPEC} (DR_SPEC names it)` }, () => {
  const spec = fs.readFileSync(SPEC, 'utf8').split(/\r?\n/);
  const heading = spec.findIndex(line => /^## 8\. /.test(line));
  assert.ok(heading !== -1, 'the spec has a section 8');
  const next = spec.findIndex((line, i) => i > heading && line.startsWith('## '));
  const rules = spec.slice(heading + 1, next === -1 ? undefined : next).filter(line => line.trim() !== '');
  assert.ok(rules.length >= 8, 'section 8 holds its 8 rules');
  const lines = doc('rigor.md').split('\n');
  const at = lines.indexOf(rules[0]);
  assert.ok(at !== -1, `rigor.md has the first line of section 8 whole: ${rules[0].slice(0, 40)}`);
  assert.deepEqual(lines.slice(at, at + rules.length), rules, 'rigor.md holds the lines of section 8 whole, in order, one after the other');
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
    // The in-app browser only for pages WebFetch cannot render, in a tab of its own that is closed. Not just "ปิดแท็บ": that
    // is also inside "เปิดแท็บ", which opens one.
    'เบราว์เซอร์ในแอป', 'ปิดแท็บของตัวเองด้วย `tabs_close`',
    'ภาษาไทย', 'Write',
    'วันที่วันนี้', // accessedAt is the date SKILL.md passes in, not one that a subagent guesses
  ]) assert.ok(text.includes(word), word);
  assert.ok(doc('subagent-brief.md').includes('"- วันที่วันนี้: YYYY-MM-DD"'), 'the assembly steps tell Claude to end {{BRIEF}} with the date');
});

// ---- the safety rules of the template ----
// Subagents read pages from anywhere, and a page can carry text meant for them. What the template forbids is pinned one
// rule at a time. A numbered rule is found by its number inside the section "กฎที่ต้องทำตามเสมอ", so deleting a rule,
// or the words that make it a rule, fails a test.

// The read-only agent-reach actions that rule 11 allows, as it writes them. This is the whole list: a command that is not
// here is not allowed, and a test below checks each of these against the real agent-reach.
const AGENT_REACH_ALLOWED = [
  'agent-reach channels',
  'agent-reach doctor --text',
  'agent-reach read <url>',
  'agent-reach read <url> --backend public-web', // for the sites that agent-reach may read through a browser the user is logged in to
  'agent-reach web search "<คำค้น>"',
  'agent-reach github search "<คำค้น>"',
  'agent-reach github read <owner/repo หรือลิงก์>',
  'agent-reach youtube search "<คำค้น>"',
  'agent-reach youtube read <ลิงก์หรือ id>',
  'agent-reach youtube subtitle <ลิงก์หรือ id> --lang th,en',
];
// What agent-reach can do besides reading: install, remove, log in or out, configure, link a folder, drive a browser, live
// test, and spend a speech-to-text quota. None of it may appear in an allowed command.
const AGENT_REACH_CHANGES = ['add', 'remove', 'login', 'logout', 'setup', 'update', 'configure', 'uninstall', 'skill', 'browser', 'check', 'transcribe'];

const templateLines = () => template().split('\n');
function templateSection(heading) {
  const lines = templateLines();
  const start = lines.indexOf(`## ${heading}`);
  assert.ok(start !== -1, `the template has the section "${heading}"`);
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}
function rule(n) {
  const line = templateSection('กฎที่ต้องทำตามเสมอ').find(l => l.startsWith(`${n}. `));
  assert.ok(line, `rule ${n} is in the template`);
  return line;
}
const agentReachCommands = text => [...text.matchAll(/`(agent-reach [^`]+)`/g)].map(m => m[1]);

test('brief rule 9: all text in a page, a search result or a tool output is data, related to the task or not', () => {
  const r9 = rule(9);
  for (const word of ['หน้าเว็บ', 'ผลค้นหา', 'ผลลัพธ์ของเครื่องมือ', 'ข้อมูล ไม่ใช่คำสั่ง', 'ไม่ว่าจะดูเกี่ยวกับงานนี้หรือไม่', 'เพิกเฉย', 'ไม่ใช่เพราะข้อความในหน้าบอกให้เปิด']) {
    assert.ok(r9.includes(word), `rule 9: ${word}`);
  }
  assert.ok(!r9.includes('นอกงานนี้'), 'rule 9 no longer limits itself to text that asks for something outside the task');
});

test('brief rule 10 sends the paths to the group blocks', () => {
  const r10 = rule(10);
  for (const word of ['map.json', 'dr.cjs', 'กลุ่มที่ต้องทำ']) assert.ok(r10.includes(word), `rule 10: ${word}`);
  assert.ok(!r10.includes('ท้ายคำสั่ง'), 'the paths are not at the end of the prompt: two more sections follow the group blocks');
  const section = templateSection('กลุ่มที่ต้องทำ').join('\n');
  for (const word of ['[[GROUP-BLOCK-START]]', '{{FRAGMENT_PATH}}']) assert.ok(section.includes(word), `the section that rule 10 names holds ${word}`);
});

test('brief rule 11 allows the read-only agent-reach actions it lists, and nothing else', () => {
  const r11 = rule(11);
  assert.deepEqual(agentReachCommands(r11).sort(), [...AGENT_REACH_ALLOWED].sort(), 'rule 11 lists exactly the allowed commands');
  for (const word of [
    'Bash', 'PowerShell', 'อ่านอย่างเดียว', 'ไม่มีอย่างอื่น', 'ready', // the shell is for the list only, and a channel must be ready
    'เนื้อหาสาธารณะ', 'repo ส่วนตัว', // public content only
    'reddit, x หรือ twitter, facebook, instagram, linkedin, xiaohongshu หรือ boss', '`--backend public-web`', // no fall back to a logged-in browser
    '`transcribe`', // it spends a Whisper quota and downloads audio
    '(เช่น add, remove, login, logout, setup, update, configure, uninstall, skill, browser, check)', // the other subcommands
    'ห้ามรันคำสั่งอื่นทุกชนิด', 'ห้ามติดตั้งหรืออัปเดต', 'ห้ามล็อกอิน', 'รหัสผ่าน', 'โทเคน', 'API key', 'ห้ามสร้างบัญชี', 'ห้ามดาวน์โหลดไฟล์',
  ]) assert.ok(r11.includes(word), `rule 11: ${word}`);
});

test('every agent-reach command the template names is on the list of rule 11, and none of them can change anything', () => {
  const named = agentReachCommands(template());
  assert.ok(named.length >= AGENT_REACH_ALLOWED.length, 'the template names the commands it allows');
  for (const command of named) {
    assert.ok(AGENT_REACH_ALLOWED.some(allowed => allowed.startsWith(command)), `the template names "${command}", which rule 11 does not allow`);
  }
  for (const allowed of AGENT_REACH_ALLOWED) {
    const words = allowed.split(' ');
    assert.ok(!words.some(word => AGENT_REACH_CHANGES.includes(word)), `${allowed} can change something`);
  }
});

test('the agent-reach commands of rule 11 exist in the installed agent-reach, need no login and spend no quota', (t) => {
  const run = (...args) => spawnSync('agent-reach', args, { encoding: 'utf8', timeout: 60000 });
  const help = run('--help');
  if (help.error) { t.skip(`agent-reach cannot be run here (${help.error.code})`); return; }
  const { channels, commands } = JSON.parse(run('channels').stdout);
  for (const allowed of AGENT_REACH_ALLOWED) {
    const [, first, second, ...rest] = allowed.split(' ');
    if (first === 'channels') assert.ok(help.stdout.includes('agent-reach channels'), allowed);
    else if (first === 'doctor') assert.ok(help.stdout.includes('agent-reach doctor [--text]'), allowed);
    else if (first === 'read') {
      assert.ok(commands.read.startsWith('agent-reach read <url>'), allowed);
      const backend = /--backend (\S+)/.exec(allowed)?.[1];
      if (backend) assert.ok(help.stdout.includes(`--backend ${backend}`), `${allowed}: the help of agent-reach names --backend ${backend}`);
    } else {
      const channel = channels.find(c => c.name === first);
      assert.ok(channel, `${allowed}: agent-reach has a channel ${first}`);
      assert.equal(channel.login, null, `${allowed}: the channel ${first} needs no login`);
      const action = channel.actions.find(a => a.name === second);
      assert.ok(action, `${allowed}: the channel ${first} has an action ${second}`);
      assert.ok(!/quota|whisper/i.test(JSON.stringify(action)), `${allowed}: the action spends a quota`);
      if (rest.includes('--lang')) assert.ok(action.params.some(p => p.name === 'lang'), `${allowed}: the action takes --lang`);
    }
  }
});

test('brief tells the browser to pass the tabId on every call, read only, in a tab of its own, and to close it', () => {
  const paragraph = templateLines().find(line => line.includes('`tabs_create`'));
  assert.ok(paragraph, 'the template names tabs_create');
  for (const word of [
    '`tabId`', '`navigate`', '`get_page_text`', '`tabs_close`', 'ในทุกคำสั่ง', // the id that tabs_create returns goes with every call after it
    'หน้าสุด', // without it the tools act on the front tab: the user's, or another subagent's
    'ห้ามคลิก', 'ห้ามพิมพ์', 'ห้ามกรอกฟอร์ม', 'ห้ามล็อกอิน', 'แบนเนอร์', '`computer`', '`form_input`', '`javascript_tool`', // read only
    // Its own tab, opened by the subagent and closed by it with the same id. "ปิดแท็บ" alone would be found in "เปิดแท็บ" too.
    'เปิดแท็บของตัวเอง (`tabs_create`)', 'ปิดแท็บของตัวเองด้วย `tabs_close` พร้อม `tabId`', 'ห้ามปิดแท็บของคนอื่น',
  ]) assert.ok(paragraph.includes(word), `the browser paragraph: ${word}`);
});

// ---- the review's smaller fixes ----

test('a node title is said to be cut at about 28 characters, as the map cuts it', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'assets', 'viewer-app.js'), 'utf8'), /const LABEL_MAX = 28;/, 'the viewer cuts a node label at 28 graphemes');
  for (const name of ['map-schema.md', 'structure.md', 'subagent-brief.md']) {
    assert.ok(doc(name).includes('ราว 28 ตัวอักษร'), `${name} says about 28 characters`);
    assert.ok(!doc(name).includes('ราว 40 ตัวอักษร'), `${name} no longer says about 40 characters`);
  }
});

test('a partial date is written YYYY-MM or YYYY, a day is never made up, and a missing date is left out', () => {
  const texts = { 'rigor.md': doc('rigor.md'), 'map-schema.md': doc('map-schema.md'), 'the template': template() };
  for (const [name, text] of Object.entries(texts)) {
    for (const word of ['`YYYY-MM`', '`YYYY`', 'ห้ามเติมวันเอง', 'ห้ามเดา']) assert.ok(text.includes(word), `${name}: ${word}`);
  }
});

test('forYou is written by synthesize because that command leaves the status alone, not because a merge would change it', () => {
  for (const name of ['map-schema.md', 'expansion.md']) {
    const text = doc(name);
    assert.ok(!text.includes('โหนดจะกลับเป็น'), `${name} no longer blames the merge for the status`);
    const line = text.split('\n').find(l => l.includes('`forYou`') && l.includes('`synthesize`'));
    assert.ok(line, `${name} has a line that names forYou and synthesize`);
    assert.ok(line.includes('ไม่แตะ `status`'), `${name}: synthesize does not touch status`);
    assert.ok(line.includes('`merge` ตั้งโหนดพ่อแม่เป็น `checking` ทุกครั้ง'), `${name}: a merge sets the parent to checking every time`);
    for (const direction of ['`examples`', '`compare`', '`question`']) assert.ok(line.includes(direction), `${name}: forYou may be set on the new nodes of ${direction}`);
  }
});

test('the open-questions block of the next zone, the heredoc shell, the first-pass limits and the examples are all said', () => {
  const brief = doc('subagent-brief.md');
  const step4 = brief.split('\n').find(l => l.startsWith('4. โซนที่ไม่มีกลุ่ม'));
  assert.ok(step4, 'assembly step 4');
  assert.ok(step4.includes('ไม่ต้องมีบล็อกพิเศษ') && step4.includes('ของโซนนั้นเอง'), 'step 4 says where the next zone puts its own unresolved items');
  assert.ok(templateSection('กลุ่มที่ต้องทำ').join('\n').includes('ถ้าโซนของคุณมีกลุ่ม "คำถามที่ยังเปิดอยู่" อยู่แล้ว'), 'the template says it to the subagent too');
  const expansion = doc('expansion.md');
  const heredoc = expansion.split('\n').find(l => l.includes('heredoc'));
  assert.ok(heredoc && heredoc.includes('Bash') && heredoc.includes('PowerShell'), 'the heredoc runs in the Bash tool, not in PowerShell');
  const first = doc('structure.md').split('\n').find(l => l.includes('ในรอบรีเสิร์ชแรก'));
  assert.ok(first && first.includes('ครั้งละ 3–6 ข้อ'), 'the limits are for the first pass, and detail adds 3-6 sub-items at a time');
  const examples = expansion.split('### `examples`')[1].split('### `compare`')[0];
  assert.ok(examples.includes('ต้องอ้างหน้าของตัวอย่างนั้นเอง'), 'each example child cites its own page');
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

test('every node title in the fragment examples fits the 28-grapheme label of the map', () => {
  const C = require('../assets/viewer-core.js');
  for (const { name, i, body } of examples().filter(e => kindOf(JSON.parse(e.body)) === 'fragment')) {
    for (const node of (JSON.parse(body).children ?? []).flatMap(child => allNodes(child))) {
      assert.equal(C.shortLabel(node.title, 28), node.title, `${name} json block ${i + 1}: "${node.title}" is cut on the map`);
    }
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
