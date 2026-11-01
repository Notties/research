const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateMap } = require('../scripts/lib/validate.cjs');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-map.json'), 'utf8'));
const g = m => m.root.children[0].children[0];

test('valid fixture passes', () => {
  const r = validateMap(structuredClone(fixture));
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

const cases = [
  ['schemaVersion', m => { m.schemaVersion = 2; }, 'schemaVersion'],
  ['slug', m => { m.slug = 'Bad Slug'; }, 'slug'],
  ['depth', m => { m.brief.depth = 'huge'; }, 'brief.depth'],
  ['source url', m => { m.sources.s1.url = 'ftp://x'; }, 'sources.s1'],
  ['source type', m => { m.sources.s2.type = 'blog'; }, 'sources.s2'],
  ['zone order', m => { m.root.children.reverse(); }, 'zones'],
  ['duplicate id', m => { m.root.children[1].id = 'z-know'; }, 'duplicate id'],
  ['bad status', m => { g(m).status = 'finished'; }, 'status'],
  ['uncited point', m => { g(m).points[1].cites = []; }, 'cites'],
  ['unknown cite', m => { g(m).points[1].cites = ['s9']; }, 'unknown source "s9"'],
  ['key point single source', m => { g(m).points[0].cites = ['s1']; }, 'needs 2 sources or singleSource'],
  ['missing confidence', m => { delete g(m).confidence; }, 'confidence'],
  ['bad related', m => { g(m).related = ['nope']; }, 'unknown node "nope"'],
  ['bad reading path', m => { m.readingPath = ['nope']; }, 'readingPath'],
  ['finding single source', m => { m.summary.findings[0].cites = ['s1']; }, 'summary.findings[0]'],
  ['too many findings', m => { m.summary.findings = Array(6).fill(m.summary.findings[0]); }, 'at most 5'],
  ['queue direction', m => { m.queue = [{ id: 'q1', nodeId: 'g-know-1', direction: 'dance', status: 'pending', at: '2026-11-01T00:00:00Z' }]; }, 'queue[0]'],
  ['question without text', m => { m.queue = [{ id: 'q1', nodeId: 'g-know-1', direction: 'question', status: 'pending', at: '2026-11-01T00:00:00Z' }]; }, 'question'],
];
for (const [name, mutate, expected] of cases) test(`rejects ${name}`, () => {
  const m = structuredClone(fixture); mutate(m);
  const r = validateMap(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes(expected)), r.errors.join('\n'));
});
