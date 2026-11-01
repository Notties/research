const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../assets/shared.js');
const C = require('../assets/viewer-core.js');
const { createMap, acceptRequests, startItem, queueKey: mapQueueKey } = require('../scripts/lib/map.cjs');

// Some of these tests carry the plan's own assertions word for word (badgeFor, shortLabel, numberCites, readingNav, the
// queue command, splitSides and safeStorage). The others pin what the plan only implies: the edge cases of each function,
// the queue key that scripts/lib/map.cjs shares, and the two ways the file is loaded (require, and a browser global).

const ASSETS = path.join(__dirname, '..', 'assets');
const CORE_PATH = path.join(ASSETS, 'viewer-core.js');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-map.json'), 'utf8'));
const ids = nodes => nodes.map(n => n.id);

// ---- isExpandable and badgeFor ----

test('isExpandable: a childless group or item that is frontier, done or checking', () => {
  for (const level of ['group', 'item']) {
    for (const status of ['frontier', 'done', 'checking']) {
      assert.equal(C.isExpandable({ level, status, children: [] }), true, `${level} ${status}`);
    }
  }
});

test('isExpandable: not the root, not while planned or researching, not once it has children', () => {
  assert.equal(C.isExpandable({ level: 'root', status: 'done', children: [] }), false);
  for (const status of ['planned', 'researching', undefined]) {
    assert.equal(C.isExpandable({ level: 'item', status, children: [] }), false, String(status));
  }
  for (const status of ['frontier', 'done', 'checking']) {
    assert.equal(C.isExpandable({ level: 'group', status, children: [{ id: 'x' }] }), false, status);
  }
});

test('isExpandable: a missing children field counts as no children', () => {
  assert.equal(C.isExpandable({ level: 'item', status: 'frontier' }), true);
  assert.equal(C.isExpandable({ level: 'item', status: 'planned' }), false);
  assert.equal(C.isExpandable({ level: 'root', status: 'frontier' }), false);
});

test('badgeFor: the badges the plan lists', () => {
  assert.equal(C.badgeFor({ level: 'group', status: 'done', children: [{}, {}, {}] }, { collapsed: true }), '+3');
  assert.equal(C.badgeFor({ level: 'item', status: 'frontier', children: [] }, { collapsed: false }), '+');
  assert.equal(C.badgeFor({ level: 'item', status: 'planned', children: [] }, { collapsed: false }), null);
  assert.equal(C.badgeFor({ level: 'root', status: 'done', children: [{}] }, { collapsed: true }), null);
});

test('badgeFor: a collapsed node shows its child count whatever its status, an open one shows nothing', () => {
  assert.equal(C.badgeFor({ level: 'group', status: 'planned', children: [{}] }, { collapsed: true }), '+1');
  assert.equal(C.badgeFor({ level: 'group', status: 'researching', children: [{}, {}] }, { collapsed: true }), '+2');
  assert.equal(C.badgeFor({ level: 'group', status: 'done', children: [{}, {}] }, { collapsed: false }), null);
});

test('badgeFor: a collapsed node with no children is "+" only when it is expandable', () => {
  assert.equal(C.badgeFor({ level: 'item', status: 'done', children: [] }, { collapsed: true }), '+');
  assert.equal(C.badgeFor({ level: 'item', status: 'researching', children: [] }, { collapsed: true }), null);
  assert.equal(C.badgeFor({ level: 'item', status: 'frontier' }, { collapsed: true }), '+');
});

test('badgeFor: the root never has one, and a missing view object means not collapsed', () => {
  assert.equal(C.badgeFor({ level: 'root', status: 'frontier', children: [] }, { collapsed: false }), null);
  assert.equal(C.badgeFor({ level: 'item', status: 'frontier', children: [] }), '+');
  assert.equal(C.badgeFor({ level: 'group', status: 'done', children: [{}] }), null);
});

test('badgeFor on the nodes of the fixture map', () => {
  const know = fixture.root.children[0].children[0]; // g-know-1: done, with one child
  const leaf = know.children[0]; // g-know-1-1: frontier, no children
  const planned = fixture.root.children[1].children[0]; // g-do-1: planned, no children
  assert.equal(C.badgeFor(know, { collapsed: true }), '+1');
  assert.equal(C.badgeFor(know, { collapsed: false }), null);
  assert.equal(C.badgeFor(leaf, { collapsed: false }), '+');
  assert.equal(C.badgeFor(planned, { collapsed: false }), null);
  assert.equal(C.badgeFor(fixture.root, { collapsed: true }), null);
  assert.equal(C.isExpandable(leaf), true);
  assert.equal(C.isExpandable(know), false);
});

// ---- shortLabel ----

test('shortLabel never splits a Thai grapheme', () => {
  const input = 'ที่นี่มีน้ำใจมากมาย';
  const out = C.shortLabel(input, 3);
  assert.ok(out.endsWith('…'));
  const kept = out.slice(0, -1);
  assert.ok(input.startsWith(kept));
  assert.ok(!/^\p{M}/u.test(input.slice(kept.length)));
  assert.equal(C.shortLabel('สั้น', 28), 'สั้น');
});

test('shortLabel keeps every Thai mark with its letter at every cut', () => {
  const input = 'ที่นี่มีน้ำใจมากมาย'; // 12 graphemes: ที่ นี่ มี น้ำ ใ จ ม า ก ม า ย
  for (let max = 1; max < 12; max++) {
    const out = C.shortLabel(input, max);
    const kept = out.slice(0, -1);
    assert.ok(out.endsWith('…') && input.startsWith(kept), `max ${max}`);
    assert.ok(!/^\p{M}/u.test(input.slice(kept.length)), `max ${max}`);
  }
  // Sara Am is a letter, not a mark, but it still belongs to the grapheme before it.
  assert.equal(C.shortLabel(input, 4), 'ที่นี่มีน้ำ…');
  assert.equal(C.shortLabel(input, 11), 'ที่นี่มีน้ำใจมากมา…');
});

test('shortLabel counts graphemes: text of at most max comes back unchanged, one more is cut', () => {
  const input = 'ที่นี่มีน้ำใจมากมาย'; // 12 graphemes in 19 UTF-16 units: counting units would cut it at max 12
  assert.equal(C.shortLabel(input, 12), input);
  assert.equal(C.shortLabel('abc', 3), 'abc');
  assert.equal(C.shortLabel('abcd', 3), 'abc…');
  assert.equal(C.shortLabel('', 3), '');
});

test('shortLabel: max defaults to 28', () => {
  assert.equal(C.shortLabel('a'.repeat(28)), 'a'.repeat(28));
  assert.equal(C.shortLabel('a'.repeat(29)), `${'a'.repeat(28)}…`);
  assert.equal(C.shortLabel('ก'.repeat(40)), `${'ก'.repeat(28)}…`);
});

test('shortLabel: the ellipsis is the single character U+2026', () => {
  const out = C.shortLabel('abcd', 3);
  assert.equal(out.length, 4);
  assert.equal(out.charCodeAt(3), 0x2026);
});

test('shortLabel: a surrogate pair is never cut', () => {
  const smile = String.fromCodePoint(0x1F600);
  assert.equal(C.shortLabel(smile.repeat(3), 3), smile.repeat(3));
  assert.equal(C.shortLabel(smile.repeat(3), 2), `${smile.repeat(2)}…`);
});

// ---- numberCites ----

test('numberCites numbers sources in order of first appearance', () => {
  const n = { points: [{ cites: ['s2', 's1'] }, { cites: ['s1', 's3'] }], counterpoints: [{ cites: ['s4'] }] };
  assert.deepEqual(C.numberCites(n), { order: ['s2', 's1', 's3', 's4'], index: { s2: 1, s1: 2, s3: 3, s4: 4 } });
});

test('numberCites: points come first, then conflicts, then counterpoints', () => {
  const n = {
    counterpoints: [{ cites: ['s2'] }],
    conflicts: [{ cites: ['s1', 's4'] }],
    points: [{ cites: ['s3'] }],
  };
  assert.deepEqual(C.numberCites(n), { order: ['s3', 's1', 's4', 's2'], index: { s3: 1, s1: 2, s4: 3, s2: 4 } });
});

test('numberCites: a source cited again, in one claim or in another, keeps its first number', () => {
  const n = { points: [{ cites: ['s1', 's1'] }, { cites: ['s2', 's1'] }], conflicts: [{ cites: ['s2', 's3'] }] };
  assert.deepEqual(C.numberCites(n), { order: ['s1', 's2', 's3'], index: { s1: 1, s2: 2, s3: 3 } });
});

test('numberCites: a node with no claims has no citations', () => {
  assert.deepEqual(C.numberCites({}), { order: [], index: {} });
  assert.deepEqual(C.numberCites({ points: [], conflicts: [], counterpoints: [] }), { order: [], index: {} });
});

test('numberCites numbers the sources of a node of the fixture map', () => {
  const group = fixture.root.children[0].children[0]; // g-know-1: points cite [s1, s2] and [s3]
  assert.deepEqual(C.numberCites(group), { order: ['s1', 's2', 's3'], index: { s1: 1, s2: 2, s3: 3 } });
});

test('numberCites: an id that is also an inherited name is only a name', () => {
  const n = { points: [{ cites: ['constructor', '__proto__', 'toString', 'constructor'] }] };
  const { order, index } = C.numberCites(n);
  assert.deepEqual(order, ['constructor', '__proto__', 'toString']);
  assert.deepEqual(Object.keys(index), ['constructor', '__proto__', 'toString']);
  assert.deepEqual(Object.values(index), [1, 2, 3]);
  assert.equal(Object.getPrototypeOf(index), Object.prototype);
});

// ---- pathTo ----

test('pathTo returns the nodes from the root down to the target, both included', () => {
  const root = fixture.root;
  const trail = C.pathTo(root, 'g-know-1-1');
  assert.deepEqual(ids(trail), ['root', 'z-know', 'g-know-1', 'g-know-1-1']);
  assert.equal(trail[0], root); // the nodes themselves, not copies
  assert.equal(trail[3], root.children[0].children[0].children[0]);
  assert.deepEqual(ids(C.pathTo(root, 'z-warn')), ['root', 'z-warn']); // after the dead end of the first branches
  assert.deepEqual(ids(C.pathTo(root, 'g-next-1')), ['root', 'z-next', 'g-next-1']);
});

test('pathTo: the root is a path of its own', () => {
  assert.deepEqual(C.pathTo(fixture.root, 'root'), [fixture.root]);
  const lone = { id: 'r' };
  assert.deepEqual(C.pathTo(lone, 'r'), [lone]);
});

test('pathTo gives [] when the id is not in the tree', () => {
  assert.deepEqual(C.pathTo(fixture.root, 'nope'), []);
  assert.deepEqual(C.pathTo({ id: 'r', children: [] }, 'x'), []);
  assert.deepEqual(C.pathTo({ id: 'r' }, 'x'), []);
});

test('pathTo treats a missing children field as no children', () => {
  const leaf = { id: 'leaf' };
  const inner = { id: 'b', children: [leaf] };
  const root = { id: 'r', children: [{ id: 'a' }, inner] };
  const trail = C.pathTo(root, 'leaf');
  assert.deepEqual(trail, [root, inner, leaf]);
  assert.equal(trail[2], leaf);
});

// ---- readingNav ----

test('readingNav steps along the reading path', () => {
  const rp = { readingPath: ['a', 'b', 'c'] };
  assert.equal(C.readingNav(rp, null, 1), 'a'); assert.equal(C.readingNav(rp, 'a', 1), 'b');
  assert.equal(C.readingNav(rp, 'c', 1), null); assert.equal(C.readingNav(rp, 'a', -1), null);
});

test('readingNav: every step forward and back, and null past either end', () => {
  const rp = { readingPath: ['a', 'b', 'c'] };
  assert.equal(C.readingNav(rp, 'b', 1), 'c');
  assert.equal(C.readingNav(rp, 'b', -1), 'a');
  assert.equal(C.readingNav(rp, 'c', -1), 'b');
  assert.equal(C.readingNav(rp, 'c', 1), null);
  assert.equal(C.readingNav(rp, 'a', -1), null); // not the last stop: the path does not wrap round
});

test('readingNav: a currentId that is null or not on the path counts as before the start', () => {
  const rp = { readingPath: ['a', 'b', 'c'] };
  for (const current of [null, undefined, 'zzz', 'z-know']) {
    assert.equal(C.readingNav(rp, current, 1), 'a', `${current} forward`);
    assert.equal(C.readingNav(rp, current, -1), null, `${current} back`);
  }
});

test('readingNav gives null for a missing or empty reading path', () => {
  for (const map of [{}, { readingPath: [] }]) {
    assert.equal(C.readingNav(map, null, 1), null);
    assert.equal(C.readingNav(map, null, -1), null);
    assert.equal(C.readingNav(map, 'a', 1), null);
    assert.equal(C.readingNav(map, 'a', -1), null);
  }
});

test('readingNav follows the reading path of the fixture map', () => {
  assert.equal(C.readingNav(fixture, null, 1), 'g-know-1');
  assert.equal(C.readingNav(fixture, 'g-know-1', 1), null);
  assert.equal(C.readingNav(fixture, 'g-know-1', -1), null);
});

// ---- queueKey and queueCounts ----

const ISO = '2026-11-01T00:00:00.000Z';
const queued = (id, nodeId, direction, status, extra) => ({ id, nodeId, direction, at: ISO, status, ...extra });

test('queueKey is the rule of scripts/lib/map.cjs', () => {
  const requests = [
    { nodeId: 'g-do-1', direction: 'detail' }, // question absent
    { nodeId: 'g-do-1', direction: 'detail', question: null },
    { nodeId: 'g-do-1', direction: 'detail', question: '' },
    { nodeId: 'g-warn-1', direction: 'question', question: 'ราคา "จริง" เท่าไร; ปี 2026: ไทย' },
    queued('q1', 'g-know-1', 'examples', 'pending', { question: 'x' }),
  ];
  for (const request of requests) assert.equal(C.queueKey(request), mapQueueKey(request), JSON.stringify(request));
});

test('queueKey: an absent, null and empty question are one key, and node, direction and question each change it', () => {
  const base = { nodeId: 'a', direction: 'detail' };
  const key = C.queueKey(base);
  assert.equal(C.queueKey({ ...base, question: null }), key);
  assert.equal(C.queueKey({ ...base, question: '' }), key);
  assert.equal(C.queueKey({ ...base, id: 'q1', status: 'pending', at: ISO }), key); // id, status and time are not part of it
  assert.notEqual(C.queueKey({ ...base, nodeId: 'b' }), key);
  assert.notEqual(C.queueKey({ ...base, direction: 'examples' }), key);
  assert.notEqual(C.queueKey({ ...base, question: 'why' }), key);
});

test('queueCounts counts queued items, and local items that are not already queued', () => {
  const map = { queue: [queued('q1', 'g-do-1', 'detail', 'researching'), queued('q2', 'g-warn-1', 'examples', 'pending')] };
  const duplicate = { nodeId: 'g-warn-1', direction: 'examples' };
  assert.deepEqual(C.queueCounts(map), { researching: 1, pending: 1 });
  assert.deepEqual(C.queueCounts(map, []), { researching: 1, pending: 1 });
  assert.deepEqual(C.queueCounts(map, [duplicate]), { researching: 1, pending: 1 });
  assert.deepEqual(C.queueCounts(map, [duplicate, { nodeId: 'g-next-1', direction: 'detail' }]), { researching: 1, pending: 2 });
});

test('queueCounts: a local item that duplicates the researching item is not counted either', () => {
  const map = { queue: [queued('q1', 'g-do-1', 'detail', 'researching')] };
  assert.deepEqual(C.queueCounts(map, [{ nodeId: 'g-do-1', direction: 'detail' }]), { researching: 1, pending: 0 });
});

test('queueCounts: a local item is the queued request only when node, direction and question all match', () => {
  const map = { queue: [queued('q1', 'g-do-1', 'question', 'pending', { question: 'ทำไม' })] };
  const local = extra => ({ nodeId: 'g-do-1', direction: 'question', ...extra });
  assert.deepEqual(C.queueCounts(map, [local({ question: 'ทำไม' })]), { researching: 0, pending: 1 }); // the queued one
  assert.deepEqual(C.queueCounts(map, [local({ question: 'อย่างไร' })]), { researching: 0, pending: 2 }); // another question
  assert.deepEqual(C.queueCounts(map, [local()]), { researching: 0, pending: 2 }); // no question at all
  assert.deepEqual(C.queueCounts(map, [{ ...local({ question: 'ทำไม' }), nodeId: 'g-do-2' }]), { researching: 0, pending: 2 });
  assert.deepEqual(C.queueCounts(map, [{ ...local({ question: 'ทำไม' }), direction: 'detail' }]), { researching: 0, pending: 2 });
});

test('queueCounts: an absent, null and empty question are the same question', () => {
  const map = { queue: [queued('q1', 'g-do-1', 'detail', 'pending')] }; // queued with no question
  for (const question of [undefined, null, '']) {
    const local = { nodeId: 'g-do-1', direction: 'detail', question };
    assert.deepEqual(C.queueCounts(map, [local]), { researching: 0, pending: 1 }, String(question));
  }
});

test('queueCounts: the same local request twice counts once', () => {
  const local = extra => ({ nodeId: 'g-do-1', direction: 'detail', ...extra });
  assert.deepEqual(C.queueCounts({ queue: [] }, [local(), local()]), { researching: 0, pending: 1 });
  assert.deepEqual(C.queueCounts({ queue: [] }, [local(), local({ question: null }), local({ question: '' })]), { researching: 0, pending: 1 });
  assert.deepEqual(C.queueCounts({ queue: [] }, [local({ question: 'a' }), local({ question: 'a' }), local({ question: 'b' })]),
    { researching: 0, pending: 2 });
});

test('queueCounts: a map without a queue counts as an empty queue', () => {
  assert.deepEqual(C.queueCounts({}), { researching: 0, pending: 0 });
  assert.deepEqual(C.queueCounts({}, [{ nodeId: 'a', direction: 'detail' }, { nodeId: 'b', direction: 'detail' }]), { researching: 0, pending: 2 });
  assert.deepEqual(C.queueCounts(fixture), { researching: 0, pending: 0 }); // the fixture has queue: []
});

test('queueCounts: local items given as null (what safeStorage gives for a missing key) are none', () => {
  const map = { queue: [queued('q1', 'g-do-1', 'detail', 'pending')] };
  assert.deepEqual(C.queueCounts(map, null), { researching: 0, pending: 1 });
  assert.deepEqual(C.queueCounts(map, undefined), { researching: 0, pending: 1 });
});

test('queueCounts counts only the statuses the queue has', () => {
  const map = {
    queue: [
      queued('q1', 'a', 'detail', 'pending'), queued('q2', 'b', 'detail', 'pending'),
      queued('q3', 'c', 'detail', 'researching'), queued('q4', 'd', 'detail', 'done'),
    ],
  };
  assert.deepEqual(C.queueCounts(map), { researching: 1, pending: 2 });
});

test('queueCounts reads the queue items scripts/lib/map.cjs produces', () => {
  const brief = { goal: 'สร้างงาน', level: 'ไม่รู้เลย', focus: '', exclude: '', depth: 'standard', constraints: '' };
  const map = createMap({ topic: 'ทดสอบ', slug: 'test-topic', brief });
  acceptRequests(map, [
    { id: 'r-1', nodeId: 'g-know-1', direction: 'detail', at: ISO },
    { id: 'r-2', nodeId: 'g-do-1', direction: 'question', question: 'ทำไม', at: ISO },
  ]);
  startItem(map, 'r-1');
  assert.deepEqual(C.queueCounts(map), { researching: 1, pending: 1 });
  const both = [{ nodeId: 'g-know-1', direction: 'detail' }, { nodeId: 'g-do-1', direction: 'question', question: 'ทำไม' }];
  assert.deepEqual(C.queueCounts(map, both), { researching: 1, pending: 1 });
  assert.deepEqual(C.queueCounts(map, [...both, { nodeId: 'g-see-1', direction: 'examples' }]), { researching: 1, pending: 2 });
});

// ---- formatQueue, parseQueue and buildQueueCommand ----

test('the plan example: buildQueueCommand, and formatQueue then parseQueue', () => {
  const items = [{ nodeId: 'g-do-2-1', direction: 'detail' }, { nodeId: 'g-warn-1', direction: 'question', question: 'ราคา "จริง" เท่าไร; ปี 2026: ไทย' }];
  assert.equal(C.buildQueueCommand('awwwards-3d-web', items),
    `/deep-research ต่อ awwwards-3d-web --queue "g-do-2-1:detail; g-warn-1:question:ราคา 'จริง' เท่าไร, ปี 2026: ไทย"`);
  assert.deepEqual(C.parseQueue(C.formatQueue(items)),
    [{ nodeId: 'g-do-2-1', direction: 'detail' }, { nodeId: 'g-warn-1', direction: 'question', question: "ราคา 'จริง' เท่าไร, ปี 2026: ไทย" }]);
  assert.throws(() => C.parseQueue('x:dance'));
});

test('formatQueue: each item is nodeId:direction[:question], joined with "; "', () => {
  assert.equal(C.formatQueue([{ nodeId: 'g-do-1', direction: 'detail' }]), 'g-do-1:detail');
  assert.equal(C.formatQueue([
    { nodeId: 'g-do-1', direction: 'detail' },
    { nodeId: 'g-warn-1', direction: 'question', question: 'ทำไม' },
    { nodeId: 'g-see-1', direction: 'examples' },
  ]), 'g-do-1:detail; g-warn-1:question:ทำไม; g-see-1:examples');
});

test('formatQueue: an empty queue, or null, is the empty string', () => {
  assert.equal(C.formatQueue([]), '');
  assert.equal(C.formatQueue(null), '');
  assert.equal(C.formatQueue(undefined), '');
});

test('formatQueue: in a question every " becomes \' and every ; becomes ,, and a : stays', () => {
  const out = C.formatQueue([{ nodeId: 'n', direction: 'question', question: 'a "b" c "d"; e; f: g' }]);
  assert.equal(out, "n:question:a 'b' c 'd', e, f: g");
});

test('formatQueue: a run of CR, LF or tab in a question becomes one space, and the question is trimmed', () => {
  const format = question => C.formatQueue([{ nodeId: 'n', direction: 'question', question }]);
  assert.equal(format('ราคา\r\nเท่าไร'), 'n:question:ราคา เท่าไร');
  assert.equal(format('a\n\n\nb\t\tc\r\r\rd\r\n\t\r\ne'), 'n:question:a b c d e');
  assert.equal(format('  \n เริ่มตรงไหน \t\r\n'), 'n:question:เริ่มตรงไหน');
  assert.equal(format('\tเริ่ม\nตรงไหน\r\n'), 'n:question:เริ่ม ตรงไหน');
});

test('formatQueue: an item with no usable question has no third part', () => {
  for (const question of [undefined, null, '', '   ', '\r\n\t', ' \n ']) {
    const out = C.formatQueue([{ nodeId: 'n', direction: 'question', question }]);
    assert.equal(out, 'n:question', JSON.stringify(question));
  }
  assert.equal(C.formatQueue([{ nodeId: 'n', direction: 'detail', question: '' }, { nodeId: 'm', direction: 'detail' }]), 'n:detail; m:detail');
});

test('formatQueue: one item per line of text, whatever the questions hold', () => {
  const out = C.formatQueue([
    { nodeId: 'a', direction: 'question', question: 'บรรทัดแรก\nบรรทัดสอง\r\nบรรทัดสาม\tแท็บ' },
    { nodeId: 'b', direction: 'question', question: '"quoted"; and more' },
  ]);
  assert.ok(!/[\r\n\t]/.test(out), JSON.stringify(out));
  assert.ok(!out.includes('"'), out);
  assert.equal(out.split('; ').length, 2, out);
});

test('parseQueue: an item without a question has no question key at all', () => {
  for (const text of ['g-do-1:detail', 'g-do-1:detail:', 'g-do-1:detail:   ', '  g-do-1:detail:  ']) {
    const items = C.parseQueue(text);
    assert.deepEqual(items, [{ nodeId: 'g-do-1', direction: 'detail' }], text);
    assert.equal(Object.hasOwn(items[0], 'question'), false, text);
  }
});

test('parseQueue cuts each item at its first two colons only, so a question keeps its colons', () => {
  assert.deepEqual(C.parseQueue('g-1:question:ปี 2026: เวลา 10:30:45 น.'),
    [{ nodeId: 'g-1', direction: 'question', question: 'ปี 2026: เวลา 10:30:45 น.' }]);
  assert.deepEqual(C.parseQueue('g-1:detail:a:b'), [{ nodeId: 'g-1', direction: 'detail', question: 'a:b' }]);
  assert.deepEqual(C.parseQueue('g-1:detail::'), [{ nodeId: 'g-1', direction: 'detail', question: ':' }]);
});

test('parseQueue trims items and skips empty ones', () => {
  assert.deepEqual(C.parseQueue('a:detail; '), [{ nodeId: 'a', direction: 'detail' }]); // a trailing "; " is fine
  assert.deepEqual(C.parseQueue(' ; a:detail ;; b:examples:ทำไม ; '),
    [{ nodeId: 'a', direction: 'detail' }, { nodeId: 'b', direction: 'examples', question: 'ทำไม' }]);
  assert.deepEqual(C.parseQueue('  a:detail  ;\n\tb:question:  ทำไม  \n'),
    [{ nodeId: 'a', direction: 'detail' }, { nodeId: 'b', direction: 'question', question: 'ทำไม' }]);
  assert.deepEqual(C.parseQueue('a:detail;b:examples'), [{ nodeId: 'a', direction: 'detail' }, { nodeId: 'b', direction: 'examples' }]);
});

test('parseQueue: nothing to parse gives an empty list', () => {
  for (const text of ['', '   ', ' ; ;  ', null, undefined]) assert.deepEqual(C.parseQueue(text), [], String(text));
});

test('parseQueue throws on an unknown direction and says which', () => {
  assert.throws(() => C.parseQueue('x:dance'), /dance/);
  assert.throws(() => C.parseQueue('x:constructor'), /constructor/);
  assert.throws(() => C.parseQueue('a:detail; b:nope; c:examples'), /nope/); // a bad item anywhere throws, wherever it is
  assert.throws(() => C.parseQueue('x:dance:ทำไม'), /dance/);
});

test('parseQueue throws on an item with no direction or no node id', () => {
  assert.throws(() => C.parseQueue('x'), /direction/);
  assert.throws(() => C.parseQueue('x:'), /direction/);
  assert.throws(() => C.parseQueue('x::ทำไม'), /direction/);
  assert.throws(() => C.parseQueue(':detail'), /node id/);
  assert.throws(() => C.parseQueue('  :detail:ทำไม'), /node id/);
});

test('parseQueue accepts every direction in shared.js', () => {
  for (const { id } of S.DIRECTIONS) assert.deepEqual(C.parseQueue(`n:${id}`), [{ nodeId: 'n', direction: id }], id);
});

test('formatQueue then parseQueue round-trips every direction, with and without a question', () => {
  const items = S.DIRECTIONS.flatMap(d => [
    { nodeId: 'g-1', direction: d.id },
    { nodeId: 'g-2-1', direction: d.id, question: 'ทำไมถึงแพง: ช่วยอธิบาย' },
  ]);
  assert.deepEqual(C.parseQueue(C.formatQueue(items)), items);
});

test('buildQueueCommand: /deep-research ต่อ <slug> --queue "<items>"', () => {
  assert.equal(C.buildQueueCommand('test-topic', [{ nodeId: 'g-know-1', direction: 'detail' }]),
    '/deep-research ต่อ test-topic --queue "g-know-1:detail"');
  assert.equal(C.buildQueueCommand('test-topic', []), '/deep-research ต่อ test-topic --queue ""');
  assert.equal(C.buildQueueCommand('test-topic', null), '/deep-research ต่อ test-topic --queue ""');
});

test('buildQueueCommand stays on one line and holds no stray quote, whatever the questions hold', () => {
  const cmd = C.buildQueueCommand('t', [{ nodeId: 'a', direction: 'question', question: 'ราคา "จริง"\r\nเท่าไร;\tครับ' }]);
  assert.equal(cmd, `/deep-research ต่อ t --queue "a:question:ราคา 'จริง' เท่าไร, ครับ"`);
  assert.equal(cmd.split('"').length, 3, cmd); // only the two quotes around the option
});

// ---- splitSides ----

test('splitSides gives the right side the first ceil(n/2) ids', () => {
  assert.deepEqual(C.splitSides(['a', 'b', 'c', 'd', 'e']), { right: ['a', 'b', 'c'], left: ['d', 'e'] });
});

test('splitSides: even, single and empty lists, and the order is kept', () => {
  assert.deepEqual(C.splitSides(['a', 'b', 'c', 'd']), { right: ['a', 'b'], left: ['c', 'd'] });
  assert.deepEqual(C.splitSides(['a', 'b']), { right: ['a'], left: ['b'] });
  assert.deepEqual(C.splitSides(['a']), { right: ['a'], left: [] });
  assert.deepEqual(C.splitSides([]), { right: [], left: [] });
  for (let n = 0; n <= 9; n++) {
    const all = Array.from({ length: n }, (_, i) => `n${i}`);
    const { right, left } = C.splitSides(all);
    assert.equal(right.length, Math.ceil(n / 2), `n=${n}`);
    assert.equal(left.length, Math.floor(n / 2), `n=${n}`);
    assert.deepEqual([...right, ...left], all, `n=${n}`);
  }
});

test('splitSides returns new arrays and leaves its input alone', () => {
  const all = ['a', 'b', 'c'];
  const { right, left } = C.splitSides(all);
  right.push('x'); left.push('y');
  assert.deepEqual(all, ['a', 'b', 'c']);
});

test('splitSides splits the zones of the fixture map', () => {
  const { right, left } = C.splitSides(ids(fixture.root.children));
  assert.deepEqual(right, ['z-know', 'z-do', 'z-see']);
  assert.deepEqual(left, ['z-warn', 'z-next']);
});

// ---- safeStorage ----

// A stand-in for localStorage: getItem gives null for a missing key, and setItem stores the text of its value (so an
// undefined value would be stored as the text "undefined"), as the real one does.
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

test('safeStorage falls back to memory', () => {
  const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  const s = C.safeStorage(bad); s.set('k', [1]); assert.deepEqual(s.get('k'), [1]);
});

test('safeStorage stores JSON in the storage and reads it back', () => {
  const storage = fakeStorage();
  const s = C.safeStorage(storage);
  const queue = [{ nodeId: 'g-do-1', direction: 'detail' }, { nodeId: 'g-warn-1', direction: 'question', question: 'ราคา?' }];
  s.set('dr-queue:test-topic', queue);
  assert.equal(storage.data.get('dr-queue:test-topic'), JSON.stringify(queue));
  assert.deepEqual(s.get('dr-queue:test-topic'), queue);
  assert.deepEqual(C.safeStorage(storage).get('dr-queue:test-topic'), queue); // another page load sees it
  for (const value of [0, false, 'ข้อความ', { a: [1, { b: null }] }, null]) {
    s.set('k', value);
    assert.deepEqual(s.get('k'), value);
    assert.equal(storage.data.get('k'), JSON.stringify(value));
  }
});

test('safeStorage reads what an earlier page load stored', () => {
  const s = C.safeStorage(fakeStorage({ 'dr-queue:t': '[{"nodeId":"a","direction":"detail"}]' }));
  assert.deepEqual(s.get('dr-queue:t'), [{ nodeId: 'a', direction: 'detail' }]);
});

test('safeStorage: get gives null for a missing key, for unparsable JSON and for a getItem that throws', () => {
  assert.equal(C.safeStorage(fakeStorage()).get('nope'), null);
  assert.equal(C.safeStorage(fakeStorage({ k: '{not json' })).get('k'), null);
  assert.equal(C.safeStorage(fakeStorage({ k: '' })).get('k'), null);
  assert.equal(C.safeStorage({ getItem() { throw new Error('x'); }, setItem() {} }).get('k'), null);
  assert.equal(C.safeStorage({}).get('k'), null); // no getItem at all
});

test('safeStorage keeps a value in memory when setItem throws, and it wins over an older stored one', () => {
  const full = { getItem: key => (key === 'k' ? '["old"]' : null), setItem() { throw new Error('QuotaExceededError'); } };
  const s = C.safeStorage(full);
  assert.deepEqual(s.get('k'), ['old']); // read through to the storage
  s.set('k', ['new']);
  assert.deepEqual(s.get('k'), ['new']); // not the stale ['old']
  assert.equal(s.get('other'), null);
});

test('safeStorage: a value is written to the storage and kept in memory, and memory wins on get', () => {
  const storage = fakeStorage();
  const s = C.safeStorage(storage);
  s.set('k', 1);
  assert.equal(storage.data.get('k'), '1');
  storage.data.set('k', '2'); // changed behind its back, for example by another tab
  assert.equal(s.get('k'), 1);
  s.set('k', 3);
  assert.equal(storage.data.get('k'), '3');
  assert.equal(s.get('k'), 3);
});

test('safeStorage still serves what was set when only getItem throws', () => {
  const written = new Map();
  const s = C.safeStorage({ getItem() { throw new Error('x'); }, setItem: (k, v) => { written.set(k, v); } });
  assert.equal(s.get('k'), null);
  s.set('k', { a: 1 });
  assert.deepEqual(s.get('k'), { a: 1 });
  assert.equal(written.get('k'), '{"a":1}');
});

test('safeStorage works from memory alone for a null or undefined storage', () => {
  for (const storage of [null, undefined]) {
    const s = C.safeStorage(storage);
    assert.equal(s.get('k'), null, String(storage));
    s.set('k', [1, 2]);
    assert.deepEqual(s.get('k'), [1, 2], String(storage));
    s.set('k', { a: 'ข' });
    assert.deepEqual(s.get('k'), { a: 'ข' }, String(storage));
    s.set('other', 'x');
    assert.equal(s.get('other'), 'x', String(storage));
    assert.deepEqual(s.get('k'), { a: 'ข' }, String(storage));
  }
});

test('safeStorage: get gives a fresh copy, whether it came from the storage or from memory', () => {
  for (const storage of [fakeStorage(), null]) {
    const s = C.safeStorage(storage);
    s.set('k', [1]);
    s.get('k').push(2);
    assert.deepEqual(s.get('k'), [1]);
  }
});

test('safeStorage: setting undefined stores null, never the text "undefined"', () => {
  const storage = fakeStorage();
  const s = C.safeStorage(storage);
  s.set('k', undefined);
  assert.equal(s.get('k'), null);
  assert.equal(storage.data.get('k'), 'null');
  assert.equal(C.safeStorage(storage).get('k'), null);
});

// ---- the file itself ----

test('exports the 12 functions of the plan and queueKey, nothing else', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'badgeFor', 'buildQueueCommand', 'formatQueue', 'isExpandable', 'numberCites', 'parseQueue', 'pathTo',
    'queueCounts', 'queueKey', 'readingNav', 'safeStorage', 'shortLabel', 'splitSides',
  ]);
  for (const [name, fn] of Object.entries(C)) assert.equal(typeof fn, 'function', name);
});

test('viewer-core.js can be inlined in a script element: no closing script tag, no comment opener', () => {
  const source = fs.readFileSync(CORE_PATH, 'utf8');
  assert.equal(/<\/script/i.test(source), false, 'contains a closing script tag');
  assert.equal(source.includes('<!--'), false, 'contains an HTML comment opener');
});

// A page: a global object with no module and no require. Results cross a realm boundary, so they are compared as JSON.
const inPage = (page, code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, page));

test('in a browser it loads as the global DRCore, after shared.js has loaded DRShared', () => {
  const page = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ASSETS, 'shared.js'), 'utf8'), page);
  vm.runInContext(fs.readFileSync(CORE_PATH, 'utf8'), page);
  assert.deepEqual([...Object.keys(page.DRCore)].sort(), Object.keys(C).sort());
  assert.deepEqual(inPage(page, `DRCore.parseQueue('g-1:detail; g-2:question:why: now?')`),
    [{ nodeId: 'g-1', direction: 'detail' }, { nodeId: 'g-2', direction: 'question', question: 'why: now?' }]);
  assert.deepEqual(inPage(page, `DRCore.splitSides(['a', 'b', 'c'])`), { right: ['a', 'b'], left: ['c'] });
  assert.throws(() => vm.runInContext(`DRCore.parseQueue('x:dance')`, page), /dance/);
});

test('in a browser the directions are the ones DRShared lists', () => {
  const page = vm.createContext({ DRShared: { DIRECTIONS: [{ id: 'zoom', label: 'z' }] } });
  vm.runInContext(fs.readFileSync(CORE_PATH, 'utf8'), page);
  assert.deepEqual(inPage(page, `DRCore.parseQueue('n:zoom')`), [{ nodeId: 'n', direction: 'zoom' }]);
  assert.throws(() => vm.runInContext(`DRCore.parseQueue('n:detail')`, page), /detail/);
});

test('without DRShared the browser build fails at load with a message that names it', () => {
  assert.throws(() => vm.runInContext(fs.readFileSync(CORE_PATH, 'utf8'), vm.createContext({})), /DRShared/);
});
