const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../assets/shared.js');
const { validateMap } = require('../scripts/lib/validate.cjs');

// tests/fixtures/demo-map.json is the map the viewer is checked against by hand (Task 7, Step 4). The first test is the
// plan's own; the second pins what the plan asks the demo to hold, so a later edit cannot quietly drop a case the check
// needs (a logo, a status, a conflict...).

const demo = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'demo-map.json'), 'utf8'));

// Every node with its zone id (null for the root), parents before their children.
function nodesOf(map) {
  const out = [];
  const visit = (node, zone) => {
    out.push({ node, zone });
    for (const child of node.children ?? []) visit(child, zone ?? child.id.replace(/^z-/, ''));
  };
  visit(map.root, null);
  return out;
}

test('demo fixture validates', () => {
  const { ok, errors } = validateMap(demo);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('demo fixture holds every case the viewer check needs', () => {
  assert.equal(demo.topic, 'ทำเว็บ 3D ระดับ Awwwards');
  assert.equal(demo.slug, 'awwwards-3d-web');

  // All 5 zones, each with its default groups in order: 18 in all.
  const zones = demo.root.children;
  assert.deepEqual(zones.map(z => z.id), S.ZONES.map(z => `z-${z.id}`));
  for (const zone of zones) {
    const groups = zone.children.filter(n => n.level === 'group').map(n => n.title);
    assert.deepEqual(groups, S.DEFAULT_GROUPS[zone.id.slice(2)], zone.id);
  }

  const all = nodesOf(demo);
  const nodes = all.map(entry => entry.node);
  const zoneOf = new Map(all.map(({ node, zone }) => [node.id, zone]));
  for (const node of nodes) assert.match(node.id, /^[a-z0-9-]+$/, `node id "${node.id}"`);
  assert.ok(nodes.filter(n => n.level === 'item').length >= 12);
  assert.ok(nodes.some(n => n.logo === 'threedotjs'));
  for (const status of S.STATUSES) assert.ok(nodes.some(n => n.status === status), `a node with status ${status}`);

  const points = nodes.flatMap(n => n.points ?? []);
  assert.ok(points.some(p => p.key === true && p.singleSource === true && p.cites.length === 1));
  assert.ok(nodes.some(n => (n.conflicts ?? []).length > 0));
  assert.ok(nodes.some(n => (n.counterpoints ?? []).length > 0));
  assert.ok(nodes.some(n => typeof n.forYou === 'string' && n.forYou !== ''));
  assert.ok(nodes.some(n => (n.related ?? []).some(id => zoneOf.get(id) !== zoneOf.get(n.id))), 'a related link across zones');

  const sources = Object.values(demo.sources);
  assert.equal(sources.length, 8);
  assert.deepEqual(new Set(sources.map(s => s.type)), new Set(S.SOURCE_TYPES)); // mixed: every type at least once
  // For the source-age tag: one source published more than 2 years before it was read, one less, and some with no date.
  const yearsOld = s => (Date.parse(s.accessedAt) - Date.parse(s.publishedAt)) / (365.25 * 24 * 3600 * 1000);
  assert.ok(sources.some(s => s.publishedAt && yearsOld(s) > 2.1), 'a source older than 2 years');
  assert.ok(sources.some(s => s.publishedAt && yearsOld(s) < 1.9), 'a source younger than 2 years');
  assert.ok(sources.some(s => !s.publishedAt), 'a source with no publish date');

  assert.equal(demo.readingPath.length, 5);
  assert.equal(demo.summary.findings.length, 5);
  assert.equal(demo.summary.findings.filter(f => f.singleSource === true).length, 1);
  assert.equal(demo.summary.startTomorrow.length, 3);
  assert.equal(demo.queue.filter(q => q.status === 'pending').length, 1);
});
