const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../assets/shared.js');
const { validateMap } = require('../scripts/lib/validate.cjs');
const {
  createMap, loadMap, saveMap, findNode, parentOf, walk, mergeFragment,
  setStatus, markChecked, acceptRequests, startItem, finishItem,
} = require('../scripts/lib/map.cjs');

// The seven tests that carry the plan's names come from the plan. The others pin what the plan only implies:
// the atomic save, the all-or-nothing merge, URL normalization, id allocation and the queue edge cases.

const T0 = new Date('2026-11-01T10:00:00Z');
const T1 = new Date('2026-11-01T11:30:00Z');
const ISO0 = '2026-11-01T10:00:00.000Z';
const ISO1 = '2026-11-01T11:30:00.000Z';
const BRIEF = { goal: 'สร้างงาน', level: 'ไม่รู้เลย', focus: '', exclude: '', depth: 'standard', constraints: '' };
const VALID = { ok: true, errors: [] };

const fresh = () => createMap({ topic: 'ทดสอบ', slug: 'test-topic', brief: BRIEF, now: T0 });
const source = (url, extra) => ({ url, title: `หน้า ${url}`, type: 'official', accessedAt: '2026-11-01', ...extra });
// createMap starts with no sources, so the merge tests seed s1 themselves.
const seeded = () => { const m = fresh(); m.sources.s1 = { id: 's1', ...source('https://example.com/a') }; return m; };
const point = (cites, extra) => ({ text: 'ข้อเท็จจริง', type: 'fact', cites, ...extra });
// A fragment item with one cited point. A merged node is "checking", so a node with points needs confidence.
const item = (title, cites, extra) => ({
  title, summary: `สรุป ${title}`, points: [point(cites)], confidence: 'high', confidenceReason: 'แหล่งตรงกัน', ...extra,
});
const request = extra => ({ id: 'r-1', nodeId: 'g-know-1', direction: 'detail', at: ISO0, ...extra });
const snapshot = m => JSON.stringify(m);

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-map-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- createMap ----

test('createMap builds 5 zones and 18 planned groups and validates', () => {
  const m = fresh();
  assert.deepEqual(m.root.children.map(z => z.id), ['z-know', 'z-do', 'z-see', 'z-warn', 'z-next']);
  const groups = m.root.children.flatMap(z => z.children);
  assert.equal(groups.length, 18);
  assert.ok(groups.every(g => g.level === 'group' && g.status === 'planned'));
  assert.equal(findNode(m, 'g-do-2').title, 'สิ่งที่ต้องมี');
  assert.deepEqual(validateMap(m), VALID);
  assert.equal(validateMap(m).ok, true);
});

test('createMap sets the root, zone, group and file fields the plan lists', () => {
  const m = fresh();
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.topic, 'ทดสอบ');
  assert.equal(m.slug, 'test-topic');
  assert.equal(m.createdAt, ISO0);
  assert.equal(m.updatedAt, ISO0);
  assert.deepEqual(m.brief, BRIEF);
  assert.deepEqual(m.sources, {});
  assert.deepEqual(m.queue, []);
  assert.deepEqual(m.readingPath, []);
  assert.deepEqual(m.summary, { findings: [], startTomorrow: [] });
  assert.equal(m.inboxOffset, 0);
  assert.deepEqual([m.root.id, m.root.level, m.root.status, m.root.title], ['root', 'root', 'planned', 'ทดสอบ']);
  for (const zone of S.ZONES) {
    const node = findNode(m, `z-${zone.id}`);
    assert.deepEqual([node.level, node.title], ['zone', zone.label]);
    assert.deepEqual(
      node.children.map(g => [g.id, g.level, g.status, g.title, g.children]),
      S.DEFAULT_GROUPS[zone.id].map((title, i) => [`g-${zone.id}-${i + 1}`, 'group', 'planned', title, []]),
    );
  }
});

test('createMap copies the brief and leaves the shared constants alone', () => {
  const before = structuredClone(S);
  const brief = { ...BRIEF };
  const m = createMap({ topic: 't', slug: 's', brief, now: T0 });
  m.brief.depth = 'deep';
  m.root.children[0].children[0].title = 'เปลี่ยน';
  assert.equal(brief.depth, 'standard');
  assert.deepEqual(S, before);
  assert.equal(fresh().root.children[0].children[0].title, 'ภาพรวม');
});

// ---- loadMap and saveMap ----

test('saveMap is atomic', t => {
  const dir = tmpDir(t);
  const m = fresh();
  saveMap(dir, m, { now: new Date('2026-11-01T10:00:00Z') });
  assert.equal(fs.existsSync(path.join(dir, 'map.json.tmp')), false);
  assert.equal(loadMap(dir).updatedAt, '2026-11-01T10:00:00.000Z');
});

test('saveMap writes map.json.tmp completely and then renames it over map.json', t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'map.json');
  const tmp = `${file}.tmp`;
  const m = fresh();
  saveMap(dir, m, { now: T0 });
  m.topic = 'หัวข้อใหม่';
  const rename = fs.renameSync;
  const swaps = t.mock.method(fs, 'renameSync', (from, to) => {
    // At the swap the temp file already holds the whole new map, and map.json still holds the old one.
    assert.equal(JSON.parse(fs.readFileSync(tmp, 'utf8')).topic, 'หัวข้อใหม่');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).topic, 'ทดสอบ');
    return rename(from, to);
  });
  saveMap(dir, m, { now: T1 });
  assert.deepEqual(swaps.mock.calls.map(c => c.arguments), [[tmp, file]]);
  assert.equal(loadMap(dir).topic, 'หัวข้อใหม่');
});

test('saveMap stamps updatedAt on the map, round-trips it and keeps the file readable', t => {
  const dir = tmpDir(t);
  const m = fresh();
  saveMap(dir, m, { now: T1 });
  assert.equal(m.updatedAt, ISO1);
  assert.equal(m.createdAt, ISO0);
  assert.deepEqual(loadMap(dir), m);
  const text = fs.readFileSync(path.join(dir, 'map.json'), 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.split('\n').length > 50, 'one field per line');
  assert.ok(text.includes('ภาพรวม'), 'Thai is stored as text, not as \\u escapes');
});

test('a save that cannot be serialized touches no file', t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'map.json');
  const m = fresh();
  saveMap(dir, m, { now: T0 });
  const good = fs.readFileSync(file, 'utf8');
  m.self = m; // a cycle: JSON.stringify throws
  assert.throws(() => saveMap(dir, m, { now: T1 }), TypeError);
  assert.equal(fs.readFileSync(file, 'utf8'), good);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('a save whose rename fails removes the temp file and keeps the previous map.json', t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'map.json');
  const m = fresh();
  saveMap(dir, m, { now: T0 });
  const good = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw new Error('rename blocked'); });
  m.topic = 'หัวข้อใหม่';
  assert.throws(() => saveMap(dir, m, { now: T1 }), /rename blocked/);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(fs.readFileSync(file, 'utf8'), good);
});

// Windows refuses to rename over a file another process has open (the live server reading map.json) with these codes.
const refused = code => Object.assign(new Error(`${code}: rename refused`), { code });

test('saveMap retries a rename that is refused because another process has map.json open', t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'map.json');
  const m = fresh();
  saveMap(dir, m, { now: T0 });
  const rename = fs.renameSync;
  const codes = ['EPERM', 'EACCES', 'EBUSY'];
  const swaps = t.mock.method(fs, 'renameSync', (from, to) => {
    if (codes.length > 0) throw refused(codes.shift());
    return rename(from, to);
  });
  m.topic = 'หัวข้อใหม่';
  saveMap(dir, m, { now: T1 });
  assert.equal(swaps.mock.callCount(), 4);
  assert.equal(loadMap(dir).topic, 'หัวข้อใหม่');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('saveMap stops retrying a refused rename, removes the temp file and keeps the previous map.json', t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'map.json');
  const m = fresh();
  saveMap(dir, m, { now: T0 });
  const good = fs.readFileSync(file, 'utf8');
  const swaps = t.mock.method(fs, 'renameSync', () => { throw refused('EPERM'); });
  assert.throws(() => saveMap(dir, m, { now: T1 }), /EPERM/);
  assert.ok(swaps.mock.callCount() > 1 && swaps.mock.callCount() < 20, `${swaps.mock.callCount()} attempts`);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(fs.readFileSync(file, 'utf8'), good);
});

test('saveMap does not retry an error that is not a busy file', t => {
  const dir = tmpDir(t);
  const m = fresh();
  const swaps = t.mock.method(fs, 'renameSync', () => { throw refused('ENOENT'); });
  assert.throws(() => saveMap(dir, m, { now: T1 }), /ENOENT/);
  assert.equal(swaps.mock.callCount(), 1);
  assert.equal(fs.existsSync(path.join(dir, 'map.json.tmp')), false);
});

test('createMap, mergeFragment, finishItem and saveMap default now to the current time', t => {
  const dir = tmpDir(t);
  const lo = Date.now();
  const m = createMap({ topic: 'ทดสอบ', slug: 'test-topic', brief: BRIEF });
  mergeFragment(m, 'g-know-1', { children: [{ title: 'ก' }] });
  acceptRequests(m, [request()]);
  finishItem(m, 'r-1');
  saveMap(dir, m);
  const hi = Date.now();
  const g = findNode(m, 'g-know-1');
  for (const stamp of [m.createdAt, g.researchedAt, findNode(m, 'g-know-1-1').researchedAt, g.expansions[0].at, m.updatedAt]) {
    assert.ok(Date.parse(stamp) >= lo && Date.parse(stamp) <= hi, stamp);
  }
  assert.equal(m.createdAt === m.updatedAt, false, 'updatedAt moves on save');
});

// ---- findNode, parentOf and walk ----

test('findNode and parentOf locate nodes at any depth', () => {
  const m = fresh();
  mergeFragment(m, 'g-know-1', { children: [{ title: 'ก', children: [{ title: 'ก1' }] }] }, { now: T0 });
  assert.equal(findNode(m, 'root'), m.root);
  assert.equal(findNode(m, 'z-do').title, 'ลงมือ');
  assert.equal(findNode(m, 'g-see-3').title, 'เกณฑ์ว่าแบบไหนดี');
  assert.equal(findNode(m, 'g-know-1-1-1').title, 'ก1');
  assert.equal(findNode(m, 'g-know-1-2'), null);
  assert.equal(findNode(m, 'nope'), null);
  assert.equal(parentOf(m, 'g-see-3').id, 'z-see');
  assert.equal(parentOf(m, 'g-know-1-1-1').id, 'g-know-1-1');
  assert.equal(parentOf(m, 'z-see'), m.root);
  assert.equal(parentOf(m, 'root'), null);
  assert.equal(parentOf(m, 'nope'), null);
});

test('walk visits every node in document order with its parent', () => {
  const m = fresh();
  mergeFragment(m, 'g-know-1', { children: [{ title: 'ก', children: [{ title: 'ก1' }] }, { title: 'ข' }] }, { now: T0 });
  const seen = [];
  walk(m, (node, parent) => seen.push(`${node.id}<${parent ? parent.id : '-'}`));
  assert.equal(seen.length, 1 + 5 + 18 + 3);
  assert.deepEqual(seen.slice(0, 8), [
    'root<-', 'z-know<root', 'g-know-1<z-know', 'g-know-1-1<g-know-1', 'g-know-1-1-1<g-know-1-1',
    'g-know-1-2<g-know-1', 'g-know-2<z-know', 'g-know-3<z-know',
  ]);
  assert.equal(seen.at(-1), 'g-next-4<z-next');
});

// ---- mergeFragment ----

test('mergeFragment remaps cites and dedupes sources', () => {
  const m = seeded();
  const fragment = {
    sources: { a: source('https://EXAMPLE.com/a/'), b: source('https://example.com/b') },
    children: [item('รายการแรก', ['a', 'b']), item('รายการที่สอง', ['a', 'b'])],
  };
  const { added, sourceIds } = mergeFragment(m, 'g-know-1', fragment, { now: T0 });
  assert.deepEqual(added, ['g-know-1-1', 'g-know-1-2']);
  assert.deepEqual(sourceIds, { a: 's1', b: 's2' });
  for (const id of added) {
    assert.deepEqual(findNode(m, id).points[0].cites, ['s1', 's2']);
    assert.equal(findNode(m, id).status, 'checking');
  }
  assert.equal(findNode(m, 'g-know-1').status, 'checking');
  assert.deepEqual(Object.keys(m.sources), ['s1', 's2']);
  assert.deepEqual(validateMap(m), VALID);
});

test('mergeFragment rejects unknown cite', () => {
  const m = seeded();
  const before = snapshot(m);
  const fragment = { sources: { a: source('https://example.com/new') }, children: [item('ก', ['a']), item('ข', ['a', 'zz'])] };
  assert.throws(() => mergeFragment(m, 'g-know-1', fragment, { now: T0 }), /unknown cite "zz"/);
  assert.equal(snapshot(m), before);
});

test('mergeFragment drops repeated cites after remapping and keeps first-seen order', () => {
  const m = fresh();
  const fragment = {
    sources: { a: source('https://example.com/x'), b: source('https://EXAMPLE.com/x/#top'), c: source('https://example.com/y') },
    children: [
      item('ข้อสำคัญ', ['a', 'b'], { points: [point(['a', 'b'], { key: true })] }),
      item('เรียงลำดับ', ['c', 'a', 'b', 'c']),
    ],
  };
  const { sourceIds } = mergeFragment(m, 'g-know-1', fragment, { now: T0 });
  assert.deepEqual(sourceIds, { a: 's1', b: 's1', c: 's2' });
  assert.deepEqual(findNode(m, 'g-know-1-1').points[0].cites, ['s1']);
  assert.deepEqual(findNode(m, 'g-know-1-2').points[0].cites, ['s2', 's1']);
  // Two spellings of one url are one source, so a key point citing both is not corroborated.
  const { errors } = validateMap(m);
  assert.deepEqual(errors.map(e => e.replace(/^.*?: /, '')), ['key point needs 2 sources or singleSource']);
  findNode(m, 'g-know-1-1').points[0].singleSource = true;
  assert.deepEqual(validateMap(m), VALID);
});

// [first url, second url, are they one source?]
const urlPairs = [
  ['https://example.com/a', 'https://EXAMPLE.com/a', true],
  ['https://example.com/a', 'https://example.com/a#intro', true],
  ['https://example.com/a', 'https://example.com/a/', true],
  ['https://example.com/a', 'https://example.com/a//', true],
  ['https://example.com', 'https://example.com/', true],
  ['https://example.com/a?x=1', 'https://example.com/a/?x=1', true],
  ['https://example.com/a', 'https://example.com:443/a', true],
  ['https://example.com/a?x=1', 'https://example.com/a?x=2', false],
  ['https://example.com/a', 'https://example.com/A', false],
  ['https://example.com/a', 'http://example.com/a', false],
  ['https://example.com/a', 'https://www.example.com/a', false],
  ['https://example.com/a', 'https://example.com:8443/a', false],
  ['https://example.com/a', 'https://example.com/a/b', false],
];
for (const [x, y, same] of urlPairs) {
  test(`mergeFragment: ${x} and ${y} are ${same ? 'one source' : 'two sources'}`, () => {
    const m = fresh();
    const { sourceIds } = mergeFragment(m, 'g-know-1', { sources: { a: source(x), b: source(y) } }, { now: T0 });
    assert.equal(sourceIds.a === sourceIds.b, same);
    assert.equal(Object.keys(m.sources).length, same ? 1 : 2);
  });
}

test('mergeFragment copes with a source that has no usable url, and compares such values as written', () => {
  const m = fresh();
  const fragment = {
    sources: {
      a: { title: 'ไม่มี url', type: 'official', accessedAt: '2026-11-01' },
      b: source('not a url'), c: source('not a url'), d: source('another one'),
    },
  };
  const { sourceIds } = mergeFragment(m, 'g-know-1', fragment, { now: T0 });
  assert.deepEqual(sourceIds, { a: 's1', b: 's2', c: 's2', d: 's3' });
  // Reporting them is the validator's job.
  assert.deepEqual(validateMap(m).errors.map(e => e.split(':')[0]), ['sources.s1.url', 'sources.s2.url', 'sources.s3.url']);
});

test('mergeFragment resolves cites through the fragment only, even when local ids look like global ones', () => {
  const m = seeded();
  // Local s1 is a new page and local s2 is the page the map already holds as s1.
  const fragment = {
    sources: { s1: source('https://example.com/new'), s2: source('https://example.com/a') },
    children: [item('ก', ['s1', 's2'])],
  };
  const { sourceIds } = mergeFragment(m, 'g-know-1', fragment, { now: T0 });
  assert.deepEqual(sourceIds, { s1: 's2', s2: 's1' });
  assert.deepEqual(findNode(m, 'g-know-1-1').points[0].cites, ['s2', 's1']);
  assert.equal(m.sources.s1.url, 'https://example.com/a');
  assert.equal(m.sources.s2.url, 'https://example.com/new');
});

test('mergeFragment stores a new source under its global id with its url as written and leaves a matched one alone', () => {
  const m = fresh();
  const existing = { id: 's1', url: 'https://example.com/a', title: 'ของเดิม', type: 'official', accessedAt: '2026-10-01' };
  m.sources.s1 = structuredClone(existing);
  const second = {
    id: 'b', url: 'https://Example.com/B/', title: 'บทความ B', type: 'community',
    publisher: 'Blog', publishedAt: '2026-05-05', accessedAt: '2026-11-01',
  };
  const fragment = {
    sources: { a: source('https://example.com/a/', { title: 'ของใหม่' }), b: second, c: source('https://example.com/c') },
  };
  mergeFragment(m, 'g-know-1', fragment, { now: T0 });
  assert.deepEqual(m.sources.s1, existing);
  assert.deepEqual(m.sources.s2, { ...second, id: 's2' });
  assert.equal(m.sources.s3.url, 'https://example.com/c'); // a source nothing cites is still stored
  assert.deepEqual(Object.keys(m.sources), ['s1', 's2', 's3']);
});

test('mergeFragment numbers new sources after the highest existing id', () => {
  const m = fresh();
  m.sources.s2 = { id: 's2', ...source('https://example.com/two') };
  m.sources.s7 = { id: 's7', ...source('https://example.com/seven') };
  const { sourceIds } = mergeFragment(m, 'g-know-1', { sources: { a: source('https://example.com/new') } }, { now: T0 });
  assert.deepEqual(sourceIds, { a: 's8' });
  assert.deepEqual(Object.keys(m.sources), ['s2', 's7', 's8']);
});

test('mergeFragment numbers new nodes after the existing children and nests their ids', () => {
  const m = fresh();
  const first = mergeFragment(m, 'g-know-1', {
    children: [{ title: 'ก' }, { title: 'ข', children: [{ title: 'ข1' }, { title: 'ข2', children: [{ title: 'ข2ก' }] }] }],
  }, { now: T0 });
  assert.deepEqual(first.added, ['g-know-1-1', 'g-know-1-2', 'g-know-1-2-1', 'g-know-1-2-2', 'g-know-1-2-2-1']);
  assert.deepEqual(mergeFragment(m, 'g-know-1', { children: [{ title: 'ค' }] }, { now: T1 }).added, ['g-know-1-3']);
  assert.deepEqual(mergeFragment(m, 'g-know-1-2', { children: [{ title: 'ข3' }] }, { now: T1 }).added, ['g-know-1-2-3']);
  assert.deepEqual(findNode(m, 'g-know-1').children.map(c => c.title), ['ก', 'ข', 'ค']);
  assert.deepEqual(findNode(m, 'g-know-1-2').children.map(c => c.title), ['ข1', 'ข2', 'ข3']);
  assert.deepEqual(validateMap(m), VALID);
});

test('mergeFragment never reuses an id, even after a sibling was removed', () => {
  const m = fresh();
  mergeFragment(m, 'g-know-1', { children: [{ title: 'ก' }, { title: 'ข' }] }, { now: T0 });
  findNode(m, 'g-know-1').children.shift(); // only g-know-1-2 is left
  const { added } = mergeFragment(m, 'g-know-1', { children: [{ title: 'ค' }] }, { now: T1 });
  assert.deepEqual(added, ['g-know-1-3']);
  assert.deepEqual(validateMap(m), VALID);
});

test('mergeFragment adds children to a parent that has no children field', () => {
  const m = fresh();
  mergeFragment(m, 'g-know-1', { children: [{ title: 'ก' }] }, { now: T0 });
  delete findNode(m, 'g-know-1-1').children;
  const { added } = mergeFragment(m, 'g-know-1-1', { children: [{ title: 'ก1' }] }, { now: T1 });
  assert.deepEqual(added, ['g-know-1-1-1']);
  assert.deepEqual(findNode(m, 'g-know-1-1').children.map(c => c.id), ['g-know-1-1-1']);
});

test('mergeFragment gives each new node its level, status, timestamp and fields, and stamps the parent', () => {
  const m = fresh();
  const { added } = mergeFragment(m, 'z-see', {
    children: [
      {
        title: 'ตลาดและคู่แข่ง', level: 'group', summary: 'สรุป', why: 'เพราะ', forYou: 'สำหรับคุณ', logo: 'threedotjs',
        related: ['g-do-1'], extra: 'ignored', status: 'done', id: 'hijack', researchedAt: '1999-01-01',
      },
      { title: 'รายการ' },
    ],
  }, { now: T1 });
  assert.deepEqual(added, ['z-see-4', 'z-see-5']);
  assert.deepEqual(findNode(m, 'z-see-4'), {
    id: 'z-see-4', level: 'group', title: 'ตลาดและคู่แข่ง', status: 'checking', researchedAt: ISO1,
    summary: 'สรุป', why: 'เพราะ', forYou: 'สำหรับคุณ', logo: 'threedotjs', related: ['g-do-1'], children: [],
  });
  assert.deepEqual(findNode(m, 'z-see-5'), { id: 'z-see-5', level: 'item', title: 'รายการ', status: 'checking', researchedAt: ISO1, children: [] });
  assert.deepEqual([findNode(m, 'z-see').status, findNode(m, 'z-see').researchedAt], ['checking', ISO1]);
  assert.equal(findNode(m, 'g-know-1').status, 'planned');
  assert.deepEqual(validateMap(m), VALID);
});

test('mergeFragment lets self overwrite the parent fields and ignores everything else in it', () => {
  const m = fresh();
  Object.assign(findNode(m, 'g-know-1'), {
    summary: 'เดิม', why: 'เดิม', forYou: 'เดิม', logo: 'old', confidence: 'low', confidenceReason: 'เดิม',
    points: [point(['s1']), point(['s1'])], expansions: [{ direction: 'detail', at: ISO0 }],
  });
  const fragment = {
    sources: { a: source('https://example.com/a'), b: source('https://example.com/b') },
    self: {
      summary: 'ภาพรวมใหม่', why: 'เหตุผลใหม่', points: [point(['a', 'b'], { key: true })],
      conflicts: [{ text: 'ขัดกัน', cites: ['b'] }], counterpoints: [{ text: 'แย้ง', cites: ['a', 'b', 'a'] }],
      confidence: 'high', confidenceReason: 'สองแหล่งตรงกัน', related: ['g-do-1'],
      // Not NodeFields, so the merge must ignore them.
      id: 'hijack', title: 'ชื่อใหม่', level: 'item', status: 'done', researchedAt: '1999-01-01', expansions: [], children: [{ title: 'x' }],
    },
  };
  mergeFragment(m, 'g-know-1', fragment, { now: T1 });
  const g = findNode(m, 'g-know-1');
  assert.deepEqual([g.id, g.title, g.level, g.status, g.researchedAt], ['g-know-1', 'ภาพรวม', 'group', 'checking', ISO1]);
  assert.deepEqual(g.children, []);
  assert.deepEqual(g.expansions, [{ direction: 'detail', at: ISO0 }]);
  assert.deepEqual([g.summary, g.why, g.confidence, g.confidenceReason], ['ภาพรวมใหม่', 'เหตุผลใหม่', 'high', 'สองแหล่งตรงกัน']);
  assert.deepEqual(g.points, [point(['s1', 's2'], { key: true })]); // replaced, not appended, and remapped
  assert.deepEqual(g.conflicts, [{ text: 'ขัดกัน', cites: ['s2'] }]);
  assert.deepEqual(g.counterpoints, [{ text: 'แย้ง', cites: ['s1', 's2'] }]);
  assert.deepEqual(g.related, ['g-do-1']);
  assert.deepEqual([g.forYou, g.logo], ['เดิม', 'old']); // fields self does not mention stay
  assert.equal(findNode(m, 'g-know-2').status, 'planned');
  assert.deepEqual(validateMap(m), VALID);
});

test('mergeFragment treats null sources, self, children and fields as absent', () => {
  const m = fresh();
  Object.assign(findNode(m, 'g-know-1'), { forYou: 'เดิม', summary: 'เดิม' });
  const { added } = mergeFragment(m, 'g-know-1', {
    sources: null, self: { forYou: null, summary: 'ใหม่' }, children: [{ title: 'ก', why: null, children: null }],
  }, { now: T0 });
  assert.deepEqual(added, ['g-know-1-1']);
  const g = findNode(m, 'g-know-1');
  assert.deepEqual([g.forYou, g.summary], ['เดิม', 'ใหม่']); // a null field does not clear the old value
  assert.deepEqual(findNode(m, 'g-know-1-1'), { id: 'g-know-1-1', level: 'item', title: 'ก', status: 'checking', researchedAt: ISO0, children: [] });
  assert.deepEqual(mergeFragment(m, 'g-know-2', { self: null, children: null }, { now: T0 }).added, []);
  assert.deepEqual(validateMap(m), VALID);
});

test('mergeFragment leaves malformed claims for validateMap to report instead of throwing', () => {
  const m = seeded();
  const { added } = mergeFragment(m, 'g-know-1', {
    children: [{
      title: 'ก',
      points: [{ text: 'ไม่มี cites', type: 'fact' }, { text: 'cites เป็นข้อความ', type: 'fact', cites: 's1' }, null],
      conflicts: 'oops',
      confidence: 'high', confidenceReason: 'เหตุผล',
    }],
  }, { now: T0 });
  assert.deepEqual(added, ['g-know-1-1']);
  const { ok, errors } = validateMap(m);
  assert.equal(ok, false);
  for (const expected of ['points[0].cites: must list at least 1 source id', 'points[1].cites: must list at least 1 source id',
    'points[2]: must be an object', 'conflicts: must be an array']) {
    assert.ok(errors.some(e => e.includes(expected)), `no error contains "${expected}"; errors were:\n${errors.join('\n')}`);
  }
});

test('mergeFragment remaps cites in points, conflicts and counterpoints at every depth', () => {
  const m = fresh();
  const fragment = {
    sources: { p: source('https://example.com/p'), q: source('https://example.com/q'), r: source('https://example.com/r') },
    children: [{
      title: 'ชั้นบน',
      children: [{
        title: 'ชั้นล่าง',
        points: [point(['r'])], conflicts: [{ text: 'ก', cites: ['q'] }], counterpoints: [{ text: 'ข', cites: ['p', 'r'] }],
        confidence: 'medium', confidenceReason: 'เหตุผล',
      }],
    }],
  };
  mergeFragment(m, 'g-know-1', fragment, { now: T0 });
  const deep = findNode(m, 'g-know-1-1-1');
  assert.deepEqual(deep.points[0].cites, ['s3']);
  assert.deepEqual(deep.conflicts[0].cites, ['s2']);
  assert.deepEqual(deep.counterpoints[0].cites, ['s1', 's3']);
  assert.deepEqual(validateMap(m), VALID);
});

test('mergeFragment leaves the fragment untouched and keeps no references into it', () => {
  const m = fresh();
  const fragment = {
    sources: { a: source('https://example.com/a'), b: source('https://example.com/b') },
    self: { summary: 'ก', points: [point(['a', 'b'], { key: true })], confidence: 'high', confidenceReason: 'เหตุผล', related: ['g-do-1'] },
    children: [item('ข', ['a'], { related: ['g-do-2'] })],
  };
  const pristine = structuredClone(fragment);
  mergeFragment(m, 'g-know-1', fragment, { now: T0 });
  assert.deepEqual(fragment, pristine); // its cites are still local ids
  const merged = snapshot(m);
  fragment.sources.a.title = 'เปลี่ยน';
  fragment.self.points[0].cites.push('x');
  fragment.self.related.push('g-do-3');
  fragment.children[0].points[0].text = 'เปลี่ยน';
  fragment.children[0].related.push('g-do-3');
  assert.equal(snapshot(m), merged);
});

test('mergeFragment edits the map in place, so nodes the caller already holds stay live', () => {
  const m = fresh();
  const { root, sources } = m;
  const parent = findNode(m, 'g-know-1');
  mergeFragment(m, 'g-know-1', { sources: { a: source('https://example.com/a') }, children: [item('ก', ['a'])] }, { now: T0 });
  assert.equal(m.root, root);
  assert.equal(m.sources, sources);
  assert.equal(findNode(m, 'g-know-1'), parent);
  assert.equal(parent.children.length, 1);
  assert.equal(parent.status, 'checking');
  assert.ok(sources.s1);
});

test('mergeFragment treats odd local source ids as plain names', () => {
  const m = fresh();
  const fragment = JSON.parse(`{
    "sources": {
      "__proto__": { "url": "https://example.com/p", "title": "P", "type": "official", "accessedAt": "2026-11-01" },
      "constructor": { "url": "https://example.com/c", "title": "C", "type": "official", "accessedAt": "2026-11-01" }
    },
    "children": [{ "title": "x", "points": [{ "text": "t", "type": "fact", "cites": ["__proto__", "constructor"] }],
      "confidence": "high", "confidenceReason": "r" }]
  }`);
  const { sourceIds } = mergeFragment(m, 'g-know-1', fragment, { now: T0 });
  assert.deepEqual(Object.entries(sourceIds), [['__proto__', 's1'], ['constructor', 's2']]);
  assert.deepEqual(findNode(m, 'g-know-1-1').points[0].cites, ['s1', 's2']);
  assert.deepEqual(validateMap(m), VALID);
});

// [name, fragment, error that must be thrown]. Each case must leave the map exactly as it was.
const claim = (cites, key = 'points') => ({ [key]: [{ text: 'ข้อ', type: 'fact', cites }] });
const bad = [
  ['a fragment that is not an object', null, /fragment must be an object/],
  ['sources that are an array', { sources: [source('https://example.com/a')] }, /sources must be an object/],
  ['a source that is a bare url string', { sources: { a: 'https://example.com/a' } }, /source "a" must be an object/],
  ['a source that is null', { sources: { a: null } }, /source "a" must be an object/],
  ['self that is a string', { self: 'ก' }, /self must be an object/],
  ['children that are not an array', { children: { title: 'ก' } }, /children must be an array/],
  ['nested children that are not an array', { children: [{ title: 'ก', children: 'x' }] }, /children must be an array/],
  ['a child that is not an object', { children: [null] }, /fragment node needs a title/],
  ['a child without a title', { children: [{ summary: 'ก' }] }, /fragment node needs a title/],
  ['a child with a blank title', { children: [{ title: '  ' }] }, /fragment node needs a title/],
  ['a nested child without a title', { children: [{ title: 'ก', children: [{}] }] }, /fragment node needs a title/],
  ['a level that is not group or item', { children: [{ title: 'ก', level: 'zone' }] }, /invalid level "zone"/],
  ['a nested level that is not group or item', { children: [{ title: 'ก', children: [{ title: 'ข', level: 'leaf' }] }] }, /invalid level "leaf"/],
  ['an unknown cite in a child', { sources: {}, children: [{ title: 'ก', ...claim(['zz']) }] }, /unknown cite "zz"/],
  ['an unknown cite in self', { sources: {}, self: claim(['zz']) }, /unknown cite "zz"/],
  ['an unknown cite in conflicts', { sources: {}, children: [{ title: 'ก', conflicts: [{ text: 'ข', cites: ['zz'] }] }] }, /unknown cite "zz"/],
  ['an unknown cite in counterpoints', { sources: {}, children: [{ title: 'ก', counterpoints: [{ text: 'ข', cites: ['zz'] }] }] }, /unknown cite "zz"/],
  ['an unknown cite deep in the tree after new sources were read', {
    sources: { a: source('https://example.com/new') },
    children: [{ title: 'ก', children: [{ title: 'ข', ...claim(['a', 'zz']) }] }],
  }, /unknown cite "zz"/],
  ['an inherited name used as a cite', { sources: {}, children: [{ title: 'ก', ...claim(['constructor']) }] }, /unknown cite "constructor"/],
  ['a global source id used as a cite', { sources: {}, children: [{ title: 'ก', ...claim(['s1']) }] }, /unknown cite "s1"/],
];
for (const [name, fragment, error] of bad) {
  test(`mergeFragment rejects ${name} and leaves the map untouched`, () => {
    const m = seeded();
    const before = snapshot(m);
    assert.throws(() => mergeFragment(m, 'g-know-1', fragment, { now: T0 }), error);
    assert.equal(snapshot(m), before);
  });
}

test('mergeFragment rejects an unknown parent and leaves the map untouched', () => {
  const m = seeded();
  const before = snapshot(m);
  const fragment = { sources: { a: source('https://example.com/new') }, children: [{ title: 'ก' }] };
  assert.throws(() => mergeFragment(m, 'g-know-9', fragment, { now: T0 }), /unknown node "g-know-9"/);
  assert.equal(snapshot(m), before);
});

// ---- setStatus and markChecked ----

test('setStatus sets every listed node and rejects unknown ids or statuses without changing anything', () => {
  const m = fresh();
  setStatus(m, ['g-know-1', 'g-do-1'], 'researching');
  assert.deepEqual(['g-know-1', 'g-do-1', 'g-do-2'].map(id => findNode(m, id).status), ['researching', 'researching', 'planned']);
  setStatus(m, 'g-know-2', 'frontier');
  assert.equal(findNode(m, 'g-know-2').status, 'frontier');
  const before = snapshot(m);
  assert.throws(() => setStatus(m, ['g-know-3', 'g-nope'], 'done'), /unknown node "g-nope"/);
  assert.throws(() => setStatus(m, ['g-know-3'], 'learned'), /unknown status "learned"/);
  assert.equal(snapshot(m), before);
});

test('markChecked', () => {
  const m = fresh();
  mergeFragment(m, 'g-know-1', { children: [{ title: 'ก' }] }, { now: T0 }); // the parent and the new leaf are now checking
  const changed = markChecked(m);
  assert.equal(findNode(m, 'g-know-1-1').status, 'frontier');
  assert.equal(findNode(m, 'g-know-1').status, 'done');
  assert.equal(changed, 2);
});

test('markChecked counts only checking nodes and treats a missing children field as a leaf', () => {
  const m = fresh();
  setStatus(m, 'g-know-1', 'checking');
  setStatus(m, 'g-know-2', 'researching');
  setStatus(m, 'g-know-3', 'done');
  setStatus(m, 'g-do-1', 'frontier');
  delete findNode(m, 'g-know-1').children;
  assert.equal(markChecked(m), 1);
  assert.deepEqual(['g-know-1', 'g-know-2', 'g-know-3', 'g-do-1', 'g-do-2'].map(id => findNode(m, id).status),
    ['frontier', 'researching', 'done', 'frontier', 'planned']);
  assert.equal(markChecked(m), 0);
});

// ---- the expansion queue ----

test('acceptRequests skips duplicates', () => {
  const m = fresh();
  const accepted = acceptRequests(m, [request(), request()]);
  assert.equal(m.queue.length, 1);
  assert.equal(accepted.length, 1);
});

// [name, requests, queue length afterwards]. The dedupe key is nodeId + direction + question, so id and time do not count.
const dedupe = [
  ['the same request under another id and time', [request(), request({ id: 'r-2', at: ISO1 })], 1],
  ['the same question twice', [request({ direction: 'question', question: 'ราคาเท่าไร' }), request({ id: 'r-2', direction: 'question', question: 'ราคาเท่าไร' })], 1],
  ['no question and an empty question', [request(), request({ id: 'r-2', question: '' })], 1],
  ['another direction', [request(), request({ id: 'r-2', direction: 'examples' })], 2],
  ['another node', [request(), request({ id: 'r-2', nodeId: 'g-know-2' })], 2],
  ['another question', [request({ direction: 'question', question: 'ก' }), request({ id: 'r-2', direction: 'question', question: 'ข' })], 2],
  ['a question and none', [request({ direction: 'question' }), request({ id: 'r-2', direction: 'question', question: 'ก' })], 2],
];
for (const [name, requests, length] of dedupe) {
  test(`acceptRequests queues ${length} for ${name}`, () => {
    const m = fresh();
    acceptRequests(m, requests);
    assert.equal(m.queue.length, length);
  });
}

test('acceptRequests also skips a request that matches an item already queued or being researched', () => {
  const m = fresh();
  acceptRequests(m, [request()]);
  assert.deepEqual(acceptRequests(m, [request({ id: 'r-2' })]), []);
  startItem(m, 'r-1');
  assert.deepEqual(acceptRequests(m, [request({ id: 'r-3' })]), []);
  assert.equal(m.queue.length, 1);
});

test('acceptRequests returns the items it added as pending queue items and leaves the requests alone', () => {
  const m = fresh();
  const first = request();
  const second = request({ id: 'r-2', nodeId: 'g-warn-1', direction: 'question', question: 'ราคา: เท่าไร', status: 'done' });
  const accepted = acceptRequests(m, [first, first, second]);
  assert.deepEqual(accepted, [
    { id: 'r-1', nodeId: 'g-know-1', direction: 'detail', at: ISO0, status: 'pending' },
    { id: 'r-2', nodeId: 'g-warn-1', direction: 'question', question: 'ราคา: เท่าไร', at: ISO0, status: 'pending' },
  ]);
  assert.deepEqual(m.queue, accepted);
  assert.equal('status' in first, false);
  assert.equal(second.status, 'done');
  assert.deepEqual(validateMap(m), VALID);
});

test('start/finish lifecycle', () => {
  const m = fresh();
  acceptRequests(m, [request()]);
  const started = startItem(m, 'r-1');
  assert.equal(started.id, 'r-1');
  assert.equal(started.status, 'researching');
  assert.equal(m.queue[0].status, 'researching');
  assert.equal(findNode(m, 'g-know-1').status, 'researching');
  assert.deepEqual(validateMap(m), VALID);
  finishItem(m, 'r-1', { now: T1 });
  const node = findNode(m, 'g-know-1');
  assert.equal(node.status, 'frontier');
  assert.equal(node.expansions.length, 1);
  assert.deepEqual(node.expansions[0], { direction: 'detail', at: ISO1 });
  assert.deepEqual(m.queue, []);
});

test('finishItem settles a node that is still researching: checking with children, frontier without', () => {
  const m = fresh();
  mergeFragment(m, 'g-know-1', { children: [{ title: 'ก' }] }, { now: T0 });
  acceptRequests(m, [request(), request({ id: 'r-2', nodeId: 'g-know-2' })]);
  startItem(m, 'r-1');
  startItem(m, 'r-2');
  finishItem(m, 'r-1', { now: T1 });
  finishItem(m, 'r-2', { now: T1 });
  assert.equal(findNode(m, 'g-know-1').status, 'checking');
  assert.equal(findNode(m, 'g-know-2').status, 'frontier');
});

test('finishItem leaves a node alone unless it is still researching', () => {
  const m = fresh();
  acceptRequests(m, [
    request({ id: 'r-1', nodeId: 'g-know-1', direction: 'refresh' }),
    request({ id: 'r-2', nodeId: 'g-know-2' }),
    request({ id: 'r-3', nodeId: 'g-know-3' }),
  ]);
  startItem(m, 'r-1');
  mergeFragment(m, 'g-know-1', { self: { summary: 'อัปเดต' } }, { now: T0 }); // a refresh adds no children: the node is checking
  setStatus(m, 'g-know-2', 'done'); // r-2 and r-3 were never started
  for (const id of ['r-1', 'r-2', 'r-3']) finishItem(m, id, { now: T1 });
  assert.deepEqual(['g-know-1', 'g-know-2', 'g-know-3'].map(id => findNode(m, id).status), ['checking', 'done', 'planned']);
});

test('finishItem removes exactly the item it finishes', () => {
  const m = fresh();
  acceptRequests(m, [request({ id: 'r-1' }), request({ id: 'r-2', direction: 'examples' }), request({ id: 'r-3', direction: 'compare' })]);
  finishItem(m, 'r-2', { now: T1 });
  assert.deepEqual(m.queue.map(q => q.id), ['r-1', 'r-3']);
  finishItem(m, 'r-3', { now: T1 });
  assert.deepEqual(m.queue.map(q => q.id), ['r-1']);
});

test('finishItem records every expansion on the node in order, with the question when there is one', () => {
  const m = fresh();
  acceptRequests(m, [request(), request({ id: 'r-2', direction: 'question', question: 'ราคา: เท่าไร' })]);
  finishItem(m, 'r-1', { now: T0 });
  finishItem(m, 'r-2', { now: T1 });
  assert.deepEqual(findNode(m, 'g-know-1').expansions, [
    { direction: 'detail', at: ISO0 },
    { direction: 'question', question: 'ราคา: เท่าไร', at: ISO1 },
  ]);
  assert.deepEqual(m.queue, []);
});

test('an expansion runs accept, start, merge, finish and markChecked and leaves a valid map', () => {
  const m = fresh();
  acceptRequests(m, [request({ id: 'r-1', nodeId: 'g-do-1', direction: 'question', question: 'ราคา: เท่าไร' })]);
  startItem(m, 'r-1');
  const fragment = {
    sources: { a: source('https://example.com/a'), b: source('https://example.com/b') },
    children: [item('ราคา', ['a', 'b'])],
  };
  mergeFragment(m, 'g-do-1', fragment, { now: T0 });
  finishItem(m, 'r-1', { now: T1 });
  assert.equal(findNode(m, 'g-do-1').status, 'checking'); // the merge moved it on, so finishItem does not demote it
  assert.deepEqual(m.queue, []);
  assert.equal(markChecked(m), 2);
  assert.equal(findNode(m, 'g-do-1').status, 'done');
  assert.equal(findNode(m, 'g-do-1-1').status, 'frontier');
  assert.deepEqual(findNode(m, 'g-do-1').expansions, [{ direction: 'question', question: 'ราคา: เท่าไร', at: ISO1 }]);
  assert.deepEqual(validateMap(m), VALID);
});

test('startItem and finishItem reject an unknown item or node and change nothing', () => {
  const m = fresh();
  acceptRequests(m, [request(), request({ id: 'r-2', nodeId: 'g-nope' })]);
  const before = snapshot(m);
  assert.throws(() => startItem(m, 'r-9'), /unknown queue item "r-9"/);
  assert.throws(() => finishItem(m, 'r-9', { now: T1 }), /unknown queue item "r-9"/);
  assert.throws(() => startItem(m, 'r-2'), /unknown node "g-nope"/);
  assert.throws(() => finishItem(m, 'r-2', { now: T1 }), /unknown node "g-nope"/);
  assert.equal(snapshot(m), before);
});

test('the map library never modifies the shared constants', () => {
  const before = structuredClone(S);
  const m = fresh();
  mergeFragment(m, 'g-know-1', { sources: { a: source('https://example.com/a') }, children: [item('ก', ['a'])] }, { now: T0 });
  setStatus(m, 'g-do-1', 'researching');
  acceptRequests(m, [request()]);
  startItem(m, 'r-1');
  finishItem(m, 'r-1', { now: T1 });
  markChecked(m);
  assert.deepEqual(S, before);
});
