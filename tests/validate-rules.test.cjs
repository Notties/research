const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../assets/shared.js');
const { validateMap } = require('../scripts/lib/validate.cjs');

// validate.test.cjs holds the plan's 19-test table. This file pins the rest of scripts/lib/validate.cjs:
// each test mutates a clone of the valid fixture and checks the exact errors (or that the map is accepted).

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-map.json'), 'utf8'));
const g = m => m.root.children[0].children[0]; // g-know-1: done, 2 points (a key fact and an opinion)
const item = m => g(m).children[0]; // g-know-1-1: frontier, 1 point
const G = 'root.children[0].children[0]';
const I = `${G}.children[0]`;
const qi = props => ({ id: 'q1', nodeId: 'g-know-1', direction: 'detail', status: 'pending', at: '2026-11-01T00:00:00Z', ...props });
const ZONES_MSG = 'zones: root.children must be exactly z-know, z-do, z-see, z-warn, z-next in that order';

const run = mutate => { const m = structuredClone(fixture); mutate(m); return validateMap(m); };

// The mutation yields exactly these errors: one per entry, each matched as a substring.
function rejects(mutate, ...expected) {
  const r = run(mutate);
  assert.equal(r.ok, false, 'the mutated map was accepted');
  const missing = [...expected];
  const unexpected = [];
  for (const e of r.errors) {
    const i = missing.findIndex(sub => e.includes(sub));
    if (i === -1) unexpected.push(e); else missing.splice(i, 1);
  }
  assert.deepEqual({ missing, unexpected }, { missing: [], unexpected: [] }, `errors were:\n${r.errors.join('\n')}`);
}
// The damage cascades into other errors, so these only have to be among them.
function rejectsAmong(mutate, ...expected) {
  const r = run(mutate);
  assert.equal(r.ok, false, 'the mutated map was accepted');
  for (const sub of expected) {
    assert.ok(r.errors.some(e => e.includes(sub)), `no error contains ${JSON.stringify(sub)}; errors were:\n${r.errors.join('\n')}`);
  }
}
function accepts(mutate) {
  const r = run(mutate);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
}

// Rows are [name, mutate, ...expected error substrings].
const reject = [
  // Rules 1-2: schemaVersion, topic, slug
  ['schemaVersion given as the string "1"', m => { m.schemaVersion = '1'; }, 'schemaVersion: must be 1'],
  ['a missing schemaVersion', m => { delete m.schemaVersion; }, 'schemaVersion: must be 1'],
  ['an empty topic', m => { m.topic = ''; }, 'topic: must be a non-empty string'],
  ['a blank topic', m => { m.topic = ' \t '; }, 'topic: must be a non-empty string'],
  ['a numeric topic', m => { m.topic = 5; }, 'topic: must be a non-empty string'],
  ['a missing topic', m => { delete m.topic; }, 'topic: must be a non-empty string'],
  ['a numeric slug', m => { m.slug = 5; }, 'slug: must match'],
  ['an array slug', m => { m.slug = ['test-topic']; }, 'slug: must match'],
  ['an empty slug', m => { m.slug = ''; }, 'slug: must match'],
  ['a missing slug', m => { delete m.slug; }, 'slug: must match'],

  // Rule 3: createdAt and updatedAt
  ...['createdAt', 'updatedAt'].flatMap(f => [
    [`${f} that is not a date`, m => { m[f] = 'not a date'; }],
    [`an empty ${f}`, m => { m[f] = ''; }],
    [`a numeric ${f}`, m => { m[f] = 5; }],
    [`an array ${f}`, m => { m[f] = ['2026-11-01']; }],
    [`a null ${f}`, m => { m[f] = null; }],
    [`a missing ${f}`, m => { delete m[f]; }],
  ].map(([name, mutate]) => [name, mutate, `${f}: must be a date string`])),

  // Rule 4: brief.depth
  ['a missing brief', m => { delete m.brief; }, 'brief: must be an object'],
  ['a null brief', m => { m.brief = null; }, 'brief: must be an object'],
  ['an array brief', m => { m.brief = []; }, 'brief: must be an object'],
  ['a missing depth', m => { delete m.brief.depth; }, 'brief.depth: must be one of quick, standard, deep'],
  ['an array depth', m => { m.brief.depth = ['quick']; }, 'brief.depth:'],
  ...['constructor', 'toString', '__proto__'].map(name => [`the inherited name "${name}" as depth`, m => { m.brief.depth = name; }, 'brief.depth:']),

  // Rule 5: sources
  ['a null source', m => { m.sources.s1 = null; }, 'sources.s1: must be an object'],
  ['a string source', m => { m.sources.s1 = 'x'; }, 'sources.s1: must be an object'],
  ['an array source', m => { m.sources.s1 = []; }, 'sources.s1: must be an object'],
  ['a source id that differs from its key', m => { m.sources.s1.id = 's2'; }, 'sources.s1.id: must equal its key "s1"'],
  ['a source without an id', m => { delete m.sources.s1.id; }, 'sources.s1.id: must equal its key "s1"'],
  ['a numeric source url', m => { m.sources.s1.url = 5; }, 'sources.s1.url: must start with http:// or https://'],
  ['an array source url', m => { m.sources.s1.url = ['https://example.com/']; }, 'sources.s1.url:'],
  ['a source url without a scheme', m => { m.sources.s1.url = 'example.com/a'; }, 'sources.s1.url:'],
  ['a javascript: source url', m => { m.sources.s1.url = 'javascript:alert(1)'; }, 'sources.s1.url:'],
  ['a source without a url', m => { delete m.sources.s1.url; }, 'sources.s1.url:'],
  ['an empty source title', m => { m.sources.s1.title = ''; }, 'sources.s1.title: must be a non-empty string'],
  ['a blank source title', m => { m.sources.s1.title = '  '; }, 'sources.s1.title:'],
  ['a numeric source title', m => { m.sources.s1.title = 5; }, 'sources.s1.title:'],
  ['a source without a title', m => { delete m.sources.s1.title; }, 'sources.s1.title:'],
  ['a source without a type', m => { delete m.sources.s2.type; }, 'sources.s2.type: must be one of official, primary, secondary, community, video'],
  ['an unparseable accessedAt', m => { m.sources.s1.accessedAt = 'yesterday'; }, 'sources.s1.accessedAt: must be a date string'],
  ['a numeric accessedAt', m => { m.sources.s1.accessedAt = 5; }, 'sources.s1.accessedAt:'],
  ['an array accessedAt', m => { m.sources.s1.accessedAt = ['2026-11-01']; }, 'sources.s1.accessedAt:'],
  ['a source without accessedAt', m => { delete m.sources.s1.accessedAt; }, 'sources.s1.accessedAt:'],

  // Rule 6: node ids, root and zones
  ['reversed zones', m => { m.root.children.reverse(); }, `${ZONES_MSG} (got z-next, z-warn, z-see, z-do, z-know)`],
  ['a duplicate zone id, which also breaks the zone order', m => { m.root.children[1].id = 'z-know'; },
    'root.children[1].id: duplicate id "z-know" (first used at root.children[0])', `${ZONES_MSG} (got z-know, z-know, z-see, z-warn, z-next)`],
  ['only four zones', m => { m.root.children.pop(); }, `${ZONES_MSG} (got z-know, z-do, z-see, z-warn)`],
  ['a sixth zone', m => { m.root.children.push({ id: 'z-extra', level: 'zone', children: [] }); }, `${ZONES_MSG} (got z-know, z-do, z-see, z-warn, z-next, z-extra)`],
  ['a zone with an unknown id', m => { m.root.children[0].id = 'z-learn'; }, `${ZONES_MSG} (got z-learn, z-do, z-see, z-warn, z-next)`],
  ['a zone id without the z- prefix', m => { m.root.children[1].id = 'do'; }, `${ZONES_MSG} (got z-know, do, z-see, z-warn, z-next)`],
  ['a root without children', m => { delete m.root.children; m.readingPath = []; }, `${ZONES_MSG} (got none)`],
  ['root children that are not an array', m => { m.root.children = {}; m.readingPath = []; }, 'root.children: must be an array', `${ZONES_MSG} (got none)`],
  ['a root that is not at level "root"', m => { m.root.level = 'zone'; }, 'root.level: must be "root"'],
  ['a root without a level', m => { delete m.root.level; }, 'root.level: must be "root"'],
  ['a root without an id', m => { delete m.root.id; m.readingPath = []; }, 'root.id: must be a non-empty string'],
  ['a zone at the wrong level', m => { m.root.children[2].level = 'group'; }, 'root.children[2].level: must be "zone"'],
  ['a zone without a level', m => { delete m.root.children[4].level; }, 'root.children[4].level: must be "zone"'],
  ['a null root', m => { m.root = null; m.readingPath = []; }, 'root: must be an object'],
  ['an array root', m => { m.root = []; m.readingPath = []; }, 'root: must be an object'],
  ['a string root', m => { m.root = 'x'; m.readingPath = []; }, 'root: must be an object'],
  ['a duplicate id deep in the tree', m => { item(m).id = 'g-know-1'; }, `${I}.id: duplicate id "g-know-1" (first used at ${G})`],
  ['a node that reuses the root id', m => { g(m).id = 'root'; m.readingPath = []; }, `${G}.id: duplicate id "root" (first used at root)`],
  ['an empty node id', m => { g(m).id = ''; m.readingPath = []; }, `${G}.id: must be a non-empty string`],
  ['a blank node id', m => { g(m).id = '  '; m.readingPath = []; }, `${G}.id: must be a non-empty string`],
  ['a numeric node id', m => { g(m).id = 7; m.readingPath = []; }, `${G}.id: must be a non-empty string`],
  ['a missing node id', m => { delete g(m).id; m.readingPath = []; }, `${G}.id: must be a non-empty string`],
  ['a null child node', m => { g(m).children = [null]; }, `${G}.children[0]: must be an object`],
  ['children given as a string', m => { g(m).children = 'abc'; }, `${G}.children: must be an array`],
  ['null children', m => { g(m).children = null; }, `${G}.children: must be an array`],
  ['a node object placed under two parents', m => { m.root.children[1].children.push(g(m)); },
    'root.children[1].children[1]: node object appears more than once in the tree'],
  ['a node that contains itself', m => { g(m).children.push(g(m)); }, `${G}.children[1]: node object appears more than once in the tree`],

  // Rule 7: status
  ['a null status', m => { g(m).status = null; }, `${G}.status: must be one of planned, researching, checking, done, frontier`],
  ['an array status', m => { g(m).status = ['done']; }, `${G}.status:`],
  ['an empty status', m => { g(m).status = ''; }, `${G}.status:`],
  ['an invalid status on a zone', m => { m.root.children[1].status = 'nope'; }, 'root.children[1].status:'],
  ['an invalid status on the root', m => { m.root.status = 'nope'; }, 'root.status:'],

  // Rule 8: points and citations
  ['a null point', m => { g(m).points[1] = null; }, `${G}.points[1]: must be an object`],
  ['an array point', m => { g(m).points[1] = []; }, `${G}.points[1]: must be an object`],
  ['an empty point text', m => { g(m).points[0].text = ''; }, `${G}.points[0].text: must be a non-empty string`],
  ['a blank point text', m => { g(m).points[0].text = '  '; }, `${G}.points[0].text:`],
  ['a numeric point text', m => { g(m).points[0].text = 5; }, `${G}.points[0].text:`],
  ['a missing point text', m => { delete g(m).points[0].text; }, `${G}.points[0].text:`],
  ['an unknown point type', m => { g(m).points[0].type = 'rumor'; }, `${G}.points[0].type: must be one of fact, opinion, estimate`],
  ['a missing point type', m => { delete g(m).points[0].type; }, `${G}.points[0].type:`],
  ['a point without cites', m => { delete g(m).points[1].cites; }, `${G}.points[1].cites: must list at least 1 source id`],
  ['an empty cites array', m => { g(m).points[1].cites = []; }, `${G}.points[1].cites: must list at least 1 source id`],
  ['point cites given as a string', m => { g(m).points[1].cites = 's3'; }, `${G}.points[1].cites: must list at least 1 source id`],
  ['null point cites', m => { g(m).points[1].cites = null; }, `${G}.points[1].cites: must list at least 1 source id`],
  ['a cite wrapped in an array', m => { g(m).points[1].cites = [['s3']]; }, `${G}.points[1].cites[0]: unknown source`],
  ['a numeric cite', m => { g(m).points[1].cites = [3]; }, `${G}.points[1].cites[0]: unknown source "3"`],
  ['a null cite', m => { g(m).points[1].cites = [null]; }, `${G}.points[1].cites[0]: unknown source "null"`],
  ...['constructor', 'toString', '__proto__', 'hasOwnProperty'].map(name => [`the inherited name "${name}" as a cite`,
    m => { g(m).points[1].cites = [name]; }, `${G}.points[1].cites[0]: unknown source "${name}"`]),
  ['one unknown cite among known ones', m => { g(m).points[1].cites = ['s3', 's9']; }, `${G}.points[1].cites[1]: unknown source "s9"`],
  ['a key point with a single cite', m => { g(m).points[0].cites = ['s1']; }, `${G}.points[0]: key point needs 2 sources or singleSource`],
  ['a key point that cites one source twice', m => { g(m).points[0].cites = ['s1', 's1']; }, `${G}.points[0]: key point needs 2 sources or singleSource`],
  ['a key point with singleSource: false', m => { g(m).points[0].cites = ['s1']; g(m).points[0].singleSource = false; },
    `${G}.points[0]: key point needs 2 sources or singleSource`],
  ['a key point with singleSource as the string "true"', m => { g(m).points[0].cites = ['s1']; g(m).points[0].singleSource = 'true'; },
    `${G}.points[0]: key point needs 2 sources or singleSource`],
  ['a key point with empty cites reports only the missing cites', m => { g(m).points[0].cites = []; }, `${G}.points[0].cites: must list at least 1 source id`],
  ['a key point citing a known and an unknown source', m => { g(m).points[0].cites = ['s1', 's9']; }, `${G}.points[0].cites[1]: unknown source "s9"`],

  // Rule 9: conflicts and counterpoints
  ...['conflicts', 'counterpoints'].flatMap(f => [
    [`an empty ${f} text`, m => { g(m)[f] = [{ text: '', cites: ['s1'] }]; }, `${G}.${f}[0].text: must be a non-empty string`],
    [`a blank ${f} text`, m => { g(m)[f] = [{ text: '  ', cites: ['s1'] }]; }, `${G}.${f}[0].text:`],
    [`a ${f} item without text`, m => { g(m)[f] = [{ cites: ['s1'] }]; }, `${G}.${f}[0].text:`],
    [`empty ${f} cites`, m => { g(m)[f] = [{ text: 'a', cites: [] }]; }, `${G}.${f}[0].cites: must list at least 1 source id`],
    [`a ${f} item without cites`, m => { g(m)[f] = [{ text: 'a' }]; }, `${G}.${f}[0].cites: must list at least 1 source id`],
    [`an unknown ${f} cite`, m => { g(m)[f] = [{ text: 'a', cites: ['s9'] }]; }, `${G}.${f}[0].cites[0]: unknown source "s9"`],
    [`a bad second ${f} item`, m => { g(m)[f] = [{ text: 'a', cites: ['s1'] }, { text: '', cites: ['s1'] }]; }, `${G}.${f}[1].text:`],
    [`${f} given as a string`, m => { g(m)[f] = 'oops'; }, `${G}.${f}: must be an array`],
    [`null ${f}`, m => { g(m)[f] = null; }, `${G}.${f}: must be an array`],
    [`a null ${f} item`, m => { g(m)[f] = [null]; }, `${G}.${f}[0]: must be an object`],
  ]),

  // Rule 10: confidence on nodes that have points
  ['a frontier item with points and no confidence', m => { delete item(m).confidence; },
    `${I}.confidence: must be one of high, medium, low when a frontier node has points`],
  ['a frontier item with points and no confidenceReason', m => { delete item(m).confidenceReason; },
    `${I}.confidenceReason: must be non-empty when a frontier node has points`],
  ...['checking', 'done', 'frontier'].flatMap(st => [
    [`a ${st} node with points and no confidence`, m => { g(m).status = st; delete g(m).confidence; },
      `${G}.confidence: must be one of high, medium, low when a ${st} node has points`],
    [`a ${st} node with points and an unknown confidence`, m => { g(m).status = st; g(m).confidence = 'bogus'; }, `${G}.confidence:`],
    [`a ${st} node with points and a null confidence`, m => { g(m).status = st; g(m).confidence = null; }, `${G}.confidence:`],
    [`a ${st} node with points and no confidenceReason`, m => { g(m).status = st; delete g(m).confidenceReason; },
      `${G}.confidenceReason: must be non-empty when a ${st} node has points`],
    [`a ${st} node with points and a blank confidenceReason`, m => { g(m).status = st; g(m).confidenceReason = '  '; }, `${G}.confidenceReason:`],
    [`a ${st} node with points and a numeric confidenceReason`, m => { g(m).status = st; g(m).confidenceReason = 5; }, `${G}.confidenceReason:`],
    [`a ${st} node with points and neither`, m => { g(m).status = st; delete g(m).confidence; delete g(m).confidenceReason; },
      `${G}.confidence:`, `${G}.confidenceReason:`],
  ]),
  ['points that are not an array do not also demand confidence', m => { g(m).points = 'abc'; delete g(m).confidence; }, `${G}.points: must be an array`],
  ['null points', m => { g(m).points = null; }, `${G}.points: must be an array`],

  // Rule 11: related
  ['an unknown related id', m => { g(m).related = ['nope']; }, `${G}.related[0]: unknown node "nope"`],
  ['an unknown second related id', m => { g(m).related = ['g-do-1', 'nope']; }, `${G}.related[1]: unknown node "nope"`],
  ['a numeric related id', m => { g(m).related = [5]; }, `${G}.related[0]: unknown node "5"`],
  ['related given as a string', m => { g(m).related = 'g-do-1'; }, `${G}.related: must be an array`],
  ['null related', m => { g(m).related = null; }, `${G}.related: must be an array`],

  // Rule 12: readingPath
  ['a missing readingPath', m => { delete m.readingPath; }, 'readingPath: must be an array'],
  ['readingPath given as a string', m => { m.readingPath = 'g-know-1'; }, 'readingPath: must be an array'],
  ['a null readingPath', m => { m.readingPath = null; }, 'readingPath: must be an array'],
  ['an unknown second readingPath id', m => { m.readingPath = ['g-know-1', 'nope']; }, 'readingPath[1]: unknown node "nope"'],
  ['a numeric readingPath id', m => { m.readingPath = [5]; }, 'readingPath[0]: unknown node "5"'],

  // Rule 13: summary
  ['a missing summary', m => { delete m.summary; }, 'summary: must be an object with findings and startTomorrow'],
  ['a null summary', m => { m.summary = null; }, 'summary: must be an object with findings and startTomorrow'],
  ['an array summary', m => { m.summary = []; }, 'summary: must be an object with findings and startTomorrow'],
  ['a summary without findings', m => { delete m.summary.findings; }, 'summary.findings: must be an array'],
  ['a summary without startTomorrow', m => { delete m.summary.startTomorrow; }, 'summary.startTomorrow: must be an array'],
  ['findings given as a long string', m => { m.summary.findings = 'abcdefg'; }, 'summary.findings: must be an array'],
  ['null findings', m => { m.summary.findings = null; }, 'summary.findings: must be an array'],
  ['six findings', m => { m.summary.findings = Array(6).fill(m.summary.findings[0]); }, 'summary.findings: at most 5 items (got 6)'],
  ['a null finding', m => { m.summary.findings = [null]; }, 'summary.findings[0]: must be an object'],
  ['an empty finding text', m => { m.summary.findings[0].text = ''; }, 'summary.findings[0].text: must be a non-empty string'],
  ['a blank finding text', m => { m.summary.findings[0].text = '  '; }, 'summary.findings[0].text:'],
  ['a missing finding text', m => { delete m.summary.findings[0].text; }, 'summary.findings[0].text:'],
  ['a finding with empty cites reports only the missing cites', m => { m.summary.findings[0].cites = []; },
    'summary.findings[0].cites: must list at least 1 source id'],
  ['a finding without cites', m => { delete m.summary.findings[0].cites; }, 'summary.findings[0].cites: must list at least 1 source id'],
  ['a finding with an unknown cite', m => { m.summary.findings[0].cites = ['s1', 's9']; }, 'summary.findings[0].cites[1]: unknown source "s9"'],
  ['a finding that cites one source twice', m => { m.summary.findings[0].cites = ['s1', 's1']; },
    'summary.findings[0]: finding needs 2 sources or singleSource'],
  ['a finding with singleSource: false', m => { m.summary.findings[0].cites = ['s1']; m.summary.findings[0].singleSource = false; },
    'summary.findings[0]: finding needs 2 sources or singleSource'],
  ['a bad second finding', m => { m.summary.findings.push({ text: 'b', cites: ['s1'] }); }, 'summary.findings[1]: finding needs 2 sources or singleSource'],
  ['four startTomorrow entries', m => { m.summary.startTomorrow = ['a', 'b', 'c', 'd']; }, 'summary.startTomorrow: at most 3 items (got 4)'],
  ['a non-string startTomorrow entry', m => { m.summary.startTomorrow = ['a', 5]; }, 'summary.startTomorrow[1]: must be a string'],
  ['startTomorrow given as a long string', m => { m.summary.startTomorrow = 'abcd'; }, 'summary.startTomorrow: must be an array'],
  ['null startTomorrow', m => { m.summary.startTomorrow = null; }, 'summary.startTomorrow: must be an array'],

  // Rule 14: queue
  ['a missing queue', m => { delete m.queue; }, 'queue: must be an array'],
  ['a queue given as an object', m => { m.queue = {}; }, 'queue: must be an array'],
  ['a null queue', m => { m.queue = null; }, 'queue: must be an array'],
  ['a null queue item', m => { m.queue = [null]; }, 'queue[0]: must be an object'],
  ['a string queue item', m => { m.queue = ['detail']; }, 'queue[0]: must be an object'],
  ['an array queue item', m => { m.queue = [[]]; }, 'queue[0]: must be an object'],
  ['an unknown queue direction', m => { m.queue = [qi({ direction: 'dance' })]; },
    'queue[0].direction: must be one of detail, examples, compare, downsides, refresh, question'],
  ['a missing queue direction', m => { m.queue = [qi({ direction: undefined })]; }, 'queue[0].direction:'],
  ['an array queue direction', m => { m.queue = [qi({ direction: ['detail'] })]; }, 'queue[0].direction:'],
  ['an unknown queue nodeId', m => { m.queue = [qi({ nodeId: 'nope' })]; }, 'queue[0].nodeId: unknown node "nope"'],
  ['a missing queue nodeId', m => { m.queue = [qi({ nodeId: undefined })]; }, 'queue[0].nodeId: unknown node "undefined"'],
  ['a queue status outside pending and researching', m => { m.queue = [qi({ status: 'done' })]; }, 'queue[0].status: must be one of pending, researching'],
  ['a missing queue status', m => { m.queue = [qi({ status: undefined })]; }, 'queue[0].status:'],
  ['a bad second queue item', m => { m.queue = [qi(), qi({ id: 'q2', status: 'nope' })]; }, 'queue[1].status:'],
  ['a question without a question field', m => { m.queue = [qi({ direction: 'question' })]; },
    'queue[0].question: must be non-empty when direction is "question"'],
  ['a question with a blank question', m => { m.queue = [qi({ direction: 'question', question: '  ' })]; }, 'queue[0].question:'],
  ['a question with a numeric question', m => { m.queue = [qi({ direction: 'question', question: 5 })]; }, 'queue[0].question:'],
];
for (const [name, mutate, ...expected] of reject) test(`rejects ${name}`, () => rejects(mutate, ...expected));

// Damage that makes other checks fail too, so only the root cause is pinned.
const cascade = [
  ['a null sources object', m => { m.sources = null; }, 'sources: must be an object keyed by source id', 'unknown source "s1"'],
  ['an array of sources', m => { m.sources = []; }, 'sources: must be an object keyed by source id'],
  ['a string for sources', m => { m.sources = 'x'; }, 'sources: must be an object keyed by source id'],
  ['missing sources', m => { delete m.sources; }, 'sources: must be an object keyed by source id'],
  ['zone entries that are not objects', m => { m.root.children = [null, 1, 'x', [], {}]; },
    'root.children[0]: must be an object', 'root.children[1]: must be an object', 'root.children[3]: must be an object',
    'root.children[4].id: must be a non-empty string', 'root.children[4].level: must be "zone"', ZONES_MSG],
  ['cites that are not strings', m => { g(m).points[1].cites = [{}, [], null, 5, undefined]; },
    ...[0, 1, 2, 3, 4].map(i => `${G}.points[1].cites[${i}]: unknown source`)],
];
for (const [name, mutate, ...expected] of cascade) test(`rejects ${name}`, () => rejectsAmong(mutate, ...expected));

// Maps that must pass.
const accept = [
  ['dates with a time and an offset', m => {
    m.createdAt = '2026-11-01T10:00:00Z'; m.updatedAt = '2026-11-01T17:00:00.123+07:00'; m.sources.s1.accessedAt = '2026-11-01T10:00:00Z';
  }],
  ['http and https urls', m => { m.sources.s1.url = 'http://example.com/a'; m.sources.s2.url = 'https://example.org/b?c=d#e'; }],
  ...Object.keys(S.DEPTHS).map(d => [`depth ${d}`, m => { m.brief.depth = d; }]),
  ...S.SOURCE_TYPES.map(t => [`source type ${t}`, m => { m.sources.s3.type = t; }]),
  ['fields the validator does not know', m => {
    Object.assign(g(m), {
      summary: 'x', why: 'y', forYou: 'z', logo: 'threedotjs', zone: 'know', researchedAt: '2026-11-01T00:00:00Z',
      expansions: [{ direction: 'detail', at: '2026-11-01T00:00:00Z' }],
    });
    Object.assign(m.sources.s1, { publisher: 'P', publishedAt: '2026-01-01' });
    m.inboxOffset = 12;
  }],
  ['leaf nodes that omit children', m => {
    (function strip(n) { if (n.children.length === 0) delete n.children; else n.children.forEach(strip); })(m.root);
  }],
  ['a root without a status', m => { delete m.root.status; }],
  ...S.STATUSES.map(st => [`a ${st} node without points`, m => { m.root.children[1].children[0].status = st; }]),

  // Rule 8: the singleSource escape hatch and the distinct-source count
  ['a key point with one cite and singleSource: true', m => { g(m).points[0].cites = ['s1']; g(m).points[0].singleSource = true; }],
  ['a key point with two distinct cites', m => { g(m).points[0].cites = ['s1', 's3']; }],
  ['a key point with three cites', m => { g(m).points[0].cites = ['s1', 's2', 's3']; }],
  ['a point with key: false and one cite', m => { g(m).points[0].key = false; g(m).points[0].cites = ['s1']; }],
  ['a point without key and with one cite', m => { delete g(m).points[0].key; g(m).points[0].cites = ['s1']; }],
  ...S.POINT_TYPES.map(t => [`point type ${t}`, m => { g(m).points[1].type = t; }]),

  // Rule 9: conflicts and counterpoints need no second source
  ...['conflicts', 'counterpoints'].map(f => [`${f} with a single cite`, m => { g(m)[f] = [{ text: 'a', cites: ['s1'] }, { text: 'b', cites: ['s2', 's3'] }]; }]),
  ['conflicts and counterpoints on an item', m => {
    item(m).conflicts = [{ text: 'a', cites: ['s1'] }]; item(m).counterpoints = [{ text: 'b', cites: ['s3'] }];
  }],

  // Rule 10: who needs confidence
  ...S.CONFIDENCE.map(c => [`confidence ${c}`, m => { g(m).confidence = c; }]),
  ...['planned', 'researching'].map(st => [`a ${st} node with points needs no confidence`,
    m => { g(m).status = st; delete g(m).confidence; delete g(m).confidenceReason; }]),
  ['a done node with an empty points array needs no confidence', m => { g(m).points = []; delete g(m).confidence; delete g(m).confidenceReason; }],
  ['a done node without a points field needs no confidence', m => { delete g(m).points; delete g(m).confidence; delete g(m).confidenceReason; }],
  ['a node with points but no status needs no confidence', m => { delete g(m).status; delete g(m).confidence; delete g(m).confidenceReason; }],

  // Rules 11-12: references may point anywhere in the tree
  ['related ids across zones, to the root and forward in the tree', m => { g(m).related = ['g-do-1', 'z-warn', 'root', 'g-know-1-1', 'g-next-1']; }],
  ['an empty related list', m => { g(m).related = []; }],
  ['a readingPath of groups, items and zones', m => { m.readingPath = ['g-know-1', 'g-know-1-1', 'z-do']; }],
  ['an empty readingPath', m => { m.readingPath = []; }],

  // Rule 13: summary
  ['a finding with one cite and singleSource: true', m => { m.summary.findings[0].cites = ['s1']; m.summary.findings[0].singleSource = true; }],
  ['a finding with three cites', m => { m.summary.findings[0].cites = ['s1', 's2', 's3']; }],
  ['five findings', m => { m.summary.findings = Array(5).fill(m.summary.findings[0]); }],
  ['no findings', m => { m.summary.findings = []; }],
  ['three startTomorrow entries', m => { m.summary.startTomorrow = ['a', 'b', 'c']; }],
  ['no startTomorrow entries', m => { m.summary.startTomorrow = []; }],

  // Rule 14: queue
  ...S.DIRECTIONS.filter(d => d.id !== 'question').flatMap(d => S.QUEUE_STATUSES.map(st => [`queue direction ${d.id} with status ${st} and no question`,
    m => { m.queue = [qi({ direction: d.id, status: st })]; }])),
  ['a question direction with its question', m => { m.queue = [qi({ direction: 'question', question: 'ทำไมถึงเป็นแบบนี้' })]; }],
  ['a queue item pointing at a zone', m => { m.queue = [qi({ nodeId: 'z-do' })]; }],
  ['a queue item pointing at an item', m => { m.queue = [qi({ nodeId: 'g-know-1-1' })]; }],
  ['several queue items', m => { m.queue = [qi(), qi({ id: 'q2', direction: 'compare', status: 'researching' }), qi({ id: 'q3', nodeId: 'g-do-1' })]; }],
  ['no queue items', m => { m.queue = []; }],
];
for (const [name, mutate] of accept) test(`accepts ${name}`, () => accepts(mutate));

// Behavior of the function as a whole.
test('a non-object map is rejected without throwing', () => {
  for (const bad of [null, undefined, 5, 'x', true, [], [1, 2], () => 1]) {
    assert.deepEqual(validateMap(bad), { ok: false, errors: ['map: must be an object'] });
  }
});

test('an empty object reports every required top-level field', () => {
  const paths = validateMap({}).errors.map(e => e.split(':')[0]);
  assert.deepEqual(paths.sort(), ['brief', 'createdAt', 'queue', 'readingPath', 'root', 'schemaVersion', 'slug', 'sources', 'summary', 'topic', 'updatedAt']);
});

const sevenProblems = m => {
  m.schemaVersion = 9; m.slug = 'X'; m.brief.depth = 'x'; m.sources.s1.url = 'ftp://x';
  g(m).points[1].cites = ['s9']; m.readingPath = ['nope']; m.summary.findings[0].cites = ['s1'];
};
test('collects every error instead of stopping at the first', () => {
  const r = run(sevenProblems);
  assert.equal(r.errors.length, 7, r.errors.join('\n'));
});
test('every error reads "<path>: <message>"', () => {
  for (const e of run(sevenProblems).errors) assert.match(e, /^[\w.[\]]+: \S/);
});

test('returns exactly { ok, errors }', () => {
  assert.deepEqual(validateMap(structuredClone(fixture)), { ok: true, errors: [] });
  const bad = run(m => { m.topic = ''; });
  assert.deepEqual(Object.keys(bad), ['ok', 'errors']);
});

test('does not mutate the map it validates', () => {
  const m = structuredClone(fixture);
  m.slug = 'Bad Slug'; g(m).points[1].cites = ['s9']; m.queue = [qi({ direction: 'dance' })];
  const before = structuredClone(m);
  validateMap(m);
  assert.deepEqual(m, before);
});

test('does not mutate the shared constants', () => {
  const before = structuredClone(S);
  validateMap(structuredClone(fixture));
  validateMap({});
  run(sevenProblems);
  assert.deepEqual(S, before);
});
