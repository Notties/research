const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { inspect } = require('node:util');
const { appendRequest, readRequests, watchInbox } = require('../scripts/lib/inbox.cjs');

// Almost every Thai character is 3 bytes in UTF-8, so a byte offset and a character offset are far apart.
const THAI = 'ราคาเท่าไร ใช้เวลานานแค่ไหน';
// idleMs has to be above 0, and this is as close to 0 as a number gets: the idle window has run out as soon as it starts.
const NO_WAIT = Number.MIN_VALUE;
// The module as a source text a script can require.
const INBOX_MODULE = JSON.stringify(path.join(__dirname, '..', 'scripts', 'lib', 'inbox.cjs'));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return dir;
}
const inboxFile = dir => path.join(dir, 'inbox.jsonl');
const sizeOf = dir => fs.statSync(inboxFile(dir)).size;
// A request line the way a hand-written file would hold it.
const requestLine = (nodeId, extra = {}) =>
  JSON.stringify({ id: `r-${nodeId}`, nodeId, direction: 'detail', at: '2026-11-01T00:00:00.000Z', ...extra });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waits until check() is truthy. The limits below are generous: only a broken watch ever reaches one.
async function waitFor(check, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(5);
  }
}
function within(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
// Starts a watch that is stopped when the test ends, however it ends.
function startWatch(t, dir, options) {
  const watch = watchInbox(dir, options);
  t.after(() => watch.stop());
  return watch;
}
// Counts how often the inbox file is opened. A poll opens it once, and these tests touch it only on their own cue.
function countPolls(t, dir) {
  const real = fs.openSync;
  const polls = { count: 0 };
  t.mock.method(fs, 'openSync', (file, ...rest) => {
    if (file === inboxFile(dir)) polls.count += 1;
    return real(file, ...rest);
  });
  return polls;
}
// The set of files that have been opened and not yet closed.
function trackOpenFiles(t) {
  const open = new Set();
  const realOpen = fs.openSync;
  const realClose = fs.closeSync;
  t.mock.method(fs, 'openSync', (...args) => { const fd = realOpen(...args); open.add(fd); return fd; });
  t.mock.method(fs, 'closeSync', fd => { open.delete(fd); return realClose(fd); });
  return open;
}

// ---- appendRequest ----

test('append and read', t => {
  const dir = tmpDir(t);
  const a = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const b = appendRequest(dir, { nodeId: 'g-warn-2', direction: 'question', question: 'how much does it cost?' });
  const r = readRequests(dir);
  assert.equal(r.requests.length, 2);
  assert.deepEqual(r.requests, [a, b]);
  assert.equal(r.offset, sizeOf(dir));
});

test('appendRequest returns the documented request and appends it as one JSON line', t => {
  const dir = tmpDir(t);
  const before = Date.now();
  const plain = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const asked = appendRequest(dir, { nodeId: 'g-do-2', direction: 'question', question: THAI });
  const after = Date.now();
  // No question key at all when none was given, so the line stays { id, nodeId, direction, at }.
  assert.deepEqual(Object.keys(plain), ['id', 'nodeId', 'direction', 'at']);
  assert.deepEqual(Object.keys(asked), ['id', 'nodeId', 'direction', 'question', 'at']);
  assert.equal(asked.question, THAI);
  for (const req of [plain, asked]) {
    assert.match(req.id, /^r-[0-9a-z]+-[0-9a-z]{4}$/);
    const idTime = parseInt(req.id.split('-')[1], 36);
    assert.ok(idTime >= before && idTime <= after, 'the id carries the time of the request');
    assert.equal(new Date(req.at).toISOString(), req.at, 'at is an ISO 8601 UTC time');
    assert.ok(Date.parse(req.at) >= before && Date.parse(req.at) <= after);
  }
  assert.equal(fs.readFileSync(inboxFile(dir), 'utf8'), `${JSON.stringify(plain)}\n${JSON.stringify(asked)}\n`);
});

test('every id is r-<time>-<4 base-36 characters>, and all 4 are random', t => {
  const dir = tmpDir(t);
  const ids = Array.from({ length: 500 }, () => appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' }).id);
  // One draw in 36 is below 36^3 and would come out short if it were not padded, so 500 draws all but surely show it.
  for (const id of ids) assert.match(id, /^r-[0-9a-z]+-[0-9a-z]{4}$/);
  const suffixes = ids.map(id => id.slice(-4));
  assert.ok(new Set(suffixes).size > 450, 'the suffix varies from one request to the next');
  for (let place = 0; place < 4; place++) {
    assert.ok(new Set(suffixes.map(s => s[place])).size > 20, `character ${place + 1} of the suffix takes many values`);
  }
});

test('appendRequest rejects a request without nodeId, direction or a text question, and writes nothing', t => {
  const dir = tmpDir(t);
  const bad = [
    {}, { nodeId: 'g-know-1' }, { direction: 'detail' },
    { nodeId: '', direction: 'detail' }, { nodeId: 'g-know-1', direction: '' },
    { nodeId: 7, direction: 'detail' }, { nodeId: 'g-know-1', direction: ['detail'] },
    { nodeId: 'g-know-1', direction: 'question', question: 5 },
  ];
  for (const req of bad) assert.throws(() => appendRequest(dir, req), /nodeId|direction|question/, JSON.stringify(req));
  assert.equal(fs.existsSync(inboxFile(dir)), false);
});

test('appendRequest called with something that is not an object throws its own validation error', t => {
  const dir = tmpDir(t);
  // The module's own Error and message, not the TypeError that destructuring null or undefined would raise.
  const isOwnError = err => err.constructor === Error && /request must be an object/.test(err.message);
  for (const bad of [null, undefined, 'detail', 42, true, [], ['g-know-1', 'detail'], () => {}]) {
    assert.throws(() => appendRequest(dir, bad), isOwnError, inspect(bad));
  }
  assert.throws(() => appendRequest(dir), isOwnError, 'no second argument at all');
  assert.equal(fs.existsSync(inboxFile(dir)), false);
});

test('appendRequest accepts a null question and leaves it out', t => {
  const dir = tmpDir(t);
  const req = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail', question: null });
  assert.equal('question' in req, false);
  assert.equal(JSON.parse(fs.readFileSync(inboxFile(dir), 'utf8')).question, undefined);
});

test('a question with line breaks and U+2028 stays on one line and reads back unchanged', t => {
  const dir = tmpDir(t);
  // U+2028 and U+2029 are line separators to some tools, but the lines of this file end only at the newline character.
  const separators = String.fromCharCode(0x2028, 0x2029);
  const question = `บรรทัดแรก\nบรรทัดสอง\r\nสาม${separators}สี่ "quoted" \\ back </script><!--`;
  const req = appendRequest(dir, { nodeId: 'g-know-1', direction: 'question', question });
  assert.equal(fs.readFileSync(inboxFile(dir), 'utf8').split('\n').length, 2, 'one line, then the empty piece after its newline');
  const r = readRequests(dir);
  assert.deepEqual(r.requests, [req]);
  assert.equal(r.requests[0].question, question);
});

test('requests appended by several processes at once never run into each other', async t => {
  const dir = tmpDir(t);
  const writers = 3;
  const each = 60;
  const script = `
    const { appendRequest } = require(${INBOX_MODULE});
    for (let i = 0; i < ${each}; i++) {
      const question = process.argv[1] + ' #' + i + ' ' + ${JSON.stringify(THAI)} + ' ' + 'ก'.repeat(i * 5);
      appendRequest(${JSON.stringify(dir)}, { nodeId: 'g-know-1', direction: 'question', question });
    }`;
  await Promise.all(Array.from({ length: writers }, (_, w) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, `w${w}`], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited with ${code}`))));
  })));
  // Every physical line is a whole request: none was run into its neighbour and skipped as malformed.
  const lines = fs.readFileSync(inboxFile(dir), 'utf8').split('\n').filter(line => line !== '');
  assert.equal(lines.length, writers * each);
  assert.ok(lines.every(line => typeof JSON.parse(line).question === 'string'));
  const r = readRequests(dir);
  assert.equal(r.requests.length, writers * each);
  assert.equal(r.offset, sizeOf(dir));
  for (let w = 0; w < writers; w++) {
    const mine = r.requests.map(req => /^(w\d+) #(\d+) /.exec(req.question)).filter(m => m[1] === `w${w}`).map(m => Number(m[2]));
    assert.deepEqual(mine, Array.from({ length: each }, (_, i) => i), `writer ${w}: every request, in the order it was written`);
  }
});

test('appendRequest starts a new line when the file ends in an unterminated one', t => {
  const dir = tmpDir(t);
  const first = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  fs.appendFileSync(inboxFile(dir), '{"id":"torn"'); // a writer that died part way through its line
  const next = appendRequest(dir, { nodeId: 'g-know-2', direction: 'examples' });
  const r = readRequests(dir);
  // Without the new line the torn text and this request would be one broken line, and the request would be lost.
  assert.deepEqual(r.requests, [first, next]);
  assert.equal(r.offset, sizeOf(dir));
});

// ---- readRequests ----

test('partial line is not consumed', t => {
  const dir = tmpDir(t);
  const a = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const b = appendRequest(dir, { nodeId: 'g-know-2', direction: 'detail' });
  const complete = sizeOf(dir);
  fs.appendFileSync(inboxFile(dir), '{"id":"x"'); // no newline yet
  const r = readRequests(dir);
  assert.deepEqual(r.requests, [a, b]);
  assert.equal(r.offset, complete, 'the offset stays before the partial text');
  assert.deepEqual(readRequests(dir, r.offset), { requests: [], offset: complete }, 'and reading on from it consumes nothing');
});

test('a partial line is delivered once it is completed, and only once', t => {
  const dir = tmpDir(t);
  const full = requestLine('g-know-3', { id: 'r-late' });
  fs.appendFileSync(inboxFile(dir), full.slice(0, 20));
  const first = readRequests(dir);
  assert.deepEqual(first, { requests: [], offset: 0 });
  fs.appendFileSync(inboxFile(dir), `${full.slice(20)}\n`);
  const second = readRequests(dir, first.offset);
  assert.deepEqual(second.requests.map(r => r.id), ['r-late']);
  assert.equal(second.offset, sizeOf(dir));
  assert.deepEqual(readRequests(dir, second.offset), { requests: [], offset: second.offset });
});

test('Thai text: the offset counts bytes, not characters', t => {
  const dir = tmpDir(t);
  const first = appendRequest(dir, { nodeId: 'g-know-1', direction: 'question', question: THAI });
  const text = fs.readFileSync(inboxFile(dir), 'utf8');
  assert.ok(Buffer.byteLength(text) > text.length, 'the file holds multi-byte characters');
  const r1 = readRequests(dir);
  assert.deepEqual(r1.requests, [first]);
  assert.equal(r1.offset, sizeOf(dir));
  assert.equal(r1.offset, Buffer.byteLength(text));
  assert.notEqual(r1.offset, text.length);
  // Reading on from the stored offset must land exactly on the next line.
  const second = appendRequest(dir, { nodeId: 'g-warn-1', direction: 'question', question: `${THAI} อีกครั้ง` });
  const r2 = readRequests(dir, r1.offset);
  assert.deepEqual(r2.requests, [second]);
  assert.equal(r2.offset, sizeOf(dir));
  assert.deepEqual(readRequests(dir, r2.offset), { requests: [], offset: r2.offset });
});

test('a read that stops in the middle of a Thai character waits for the rest of it', t => {
  const dir = tmpDir(t);
  const done = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const complete = sizeOf(dir);
  const line = Buffer.from(`${JSON.stringify({ id: 'r-cut', nodeId: 'g-know-2', direction: 'question', question: THAI, at: '2026-11-01T00:00:00.000Z' })}\n`);
  const cut = line.indexOf(Buffer.from('ร')) + 1; // one byte into the first 3-byte letter of the question
  fs.appendFileSync(inboxFile(dir), line.subarray(0, cut));
  const early = readRequests(dir);
  assert.deepEqual(early, { requests: [done], offset: complete });
  fs.appendFileSync(inboxFile(dir), line.subarray(cut));
  const late = readRequests(dir, early.offset);
  assert.equal(late.requests.length, 1);
  assert.equal(late.requests[0].question, THAI);
  assert.equal(late.offset, sizeOf(dir));
});

test('readRequests on a missing file returns the offset it was given', t => {
  const dir = tmpDir(t);
  assert.deepEqual(readRequests(dir), { requests: [], offset: 0 });
  assert.deepEqual(readRequests(dir, 17), { requests: [], offset: 17 });
  assert.deepEqual(readRequests(path.join(dir, 'no-such-folder'), 5), { requests: [], offset: 5 });
});

test('readRequests from an offset returns only the requests after it', t => {
  const dir = tmpDir(t);
  const a = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const afterA = sizeOf(dir);
  const b = appendRequest(dir, { nodeId: 'g-know-2', direction: 'examples' });
  const afterB = sizeOf(dir);
  const c = appendRequest(dir, { nodeId: 'g-know-3', direction: 'compare' });
  assert.deepEqual(readRequests(dir, 0), { requests: [a, b, c], offset: sizeOf(dir) });
  assert.deepEqual(readRequests(dir, afterA), { requests: [b, c], offset: sizeOf(dir) });
  assert.deepEqual(readRequests(dir, afterB), { requests: [c], offset: sizeOf(dir) });
});

test('an offset at the end of the file reads nothing and comes back unchanged', t => {
  const dir = tmpDir(t);
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const end = sizeOf(dir);
  assert.deepEqual(readRequests(dir, end), { requests: [], offset: end });
});

test('an offset past the end of the file means it was truncated or replaced, so reading restarts at byte 0', t => {
  const dir = tmpDir(t);
  const a = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const b = appendRequest(dir, { nodeId: 'g-know-2', direction: 'detail' });
  const restarted = readRequests(dir, 10000);
  assert.deepEqual(restarted, { requests: [a, b], offset: sizeOf(dir) });
  // The offset it returns belongs to the file as it is now: reading on from it gives only what comes next.
  const c = appendRequest(dir, { nodeId: 'g-know-3', direction: 'detail' });
  assert.deepEqual(readRequests(dir, restarted.offset), { requests: [c], offset: sizeOf(dir) });
  // A shorter file with new content in its place is read from its start too.
  const stale = sizeOf(dir);
  fs.writeFileSync(inboxFile(dir), `${requestLine('g-warn-1')}\n`);
  assert.deepEqual(readRequests(dir, stale).requests.map(x => x.nodeId), ['g-warn-1']);
  // A file emptied out: the offset follows it back to 0, so what is written next is read.
  const emptied = sizeOf(dir);
  fs.writeFileSync(inboxFile(dir), '');
  assert.deepEqual(readRequests(dir, emptied), { requests: [], offset: 0 });
  const d = appendRequest(dir, { nodeId: 'g-warn-2', direction: 'detail' });
  assert.deepEqual(readRequests(dir, 0), { requests: [d], offset: sizeOf(dir) });
});

test('blank, malformed and non-object lines are skipped but still consumed', t => {
  const dir = tmpDir(t);
  const lines = [requestLine('g-know-1'), '', '   ', '{"id":"broken"', 'null', '42', '[]', '"text"', 'not json at all', requestLine('g-know-2')];
  fs.writeFileSync(inboxFile(dir), `${lines.join('\n')}\n`);
  const r = readRequests(dir);
  assert.deepEqual(r.requests.map(x => x.nodeId), ['g-know-1', 'g-know-2']);
  assert.equal(r.offset, sizeOf(dir), 'a bad line must not hold the offset back, or it would block every line after it');
});

test('lines that parse to an object but are not requests are skipped, and still consumed', t => {
  const dir = tmpDir(t);
  const lines = [requestLine('g-know-1'), '{}', '{"a":1}', '{"nodeId":5,"direction":[]}', requestLine('g-know-2')];
  fs.writeFileSync(inboxFile(dir), `${lines.join('\n')}\n`);
  const r = readRequests(dir);
  assert.deepEqual(r.requests.map(x => x.nodeId), ['g-know-1', 'g-know-2']);
  assert.equal(r.offset, sizeOf(dir), 'an object that is not a request must not hold the offset back either');
});

test('appendRequest and readRequests share one rule for what a request is', t => {
  // nodeId and direction are non-empty strings, and question is absent, null or a string. Each shape goes in through
  // both functions: appendRequest must refuse exactly what readRequests would skip.
  const shapes = [
    [{ nodeId: 'g-know-1', direction: 'detail' }, true],
    [{ nodeId: 'g-know-1', direction: 'detail', question: null }, true],
    [{ nodeId: 'g-know-1', direction: 'question', question: THAI }, true],
    [{ nodeId: 'g-know-1', direction: 'question', question: '' }, true],
    [{ nodeId: 'g-know-1', direction: 'detail', other: 1 }, true],
    [{}, false],
    [{ a: 1 }, false],
    [{ nodeId: 'g-know-1' }, false],
    [{ direction: 'detail' }, false],
    [{ nodeId: '', direction: 'detail' }, false],
    [{ nodeId: 'g-know-1', direction: '' }, false],
    [{ nodeId: 5, direction: [] }, false],
    [{ nodeId: 5, direction: 'detail' }, false],
    [{ nodeId: 'g-know-1', direction: ['detail'] }, false],
    [{ nodeId: 'g-know-1', direction: 'detail', question: 5 }, false],
    [{ nodeId: 'g-know-1', direction: 'detail', question: {} }, false],
  ];
  const readDir = tmpDir(t);
  const appendDir = tmpDir(t);
  for (const [shape, isRequest] of shapes) {
    fs.writeFileSync(inboxFile(readDir), `${JSON.stringify(shape)}\n`);
    const read = readRequests(readDir);
    assert.equal(read.requests.length, isRequest ? 1 : 0, `readRequests and ${inspect(shape)}`);
    assert.equal(read.offset, sizeOf(readDir), `the line is passed over either way: ${inspect(shape)}`);
    let appended = true;
    try { appendRequest(appendDir, shape); } catch { appended = false; }
    assert.equal(appended, isRequest, `appendRequest and ${inspect(shape)}`);
  }
});

test('CRLF line endings and a leading BOM are tolerated', t => {
  const dir = tmpDir(t);
  const bom = Buffer.from([0xef, 0xbb, 0xbf]); // the UTF-8 byte order mark that some Windows editors put at the start of a file
  const body = Buffer.from(`${requestLine('g-know-1')}\r\n\r\n${requestLine('g-know-2')}\r\n`);
  fs.writeFileSync(inboxFile(dir), Buffer.concat([bom, body]));
  const r = readRequests(dir);
  assert.deepEqual(r.requests.map(x => x.nodeId), ['g-know-1', 'g-know-2']);
  assert.equal(r.offset, sizeOf(dir));
});

test('readRequests rejects an offset that is not a non-negative integer', t => {
  const dir = tmpDir(t);
  for (const bad of [-1, 1.5, NaN, Infinity, '0', null]) assert.throws(() => readRequests(dir, bad), /offset/, String(bad));
});

test('readRequests reports any read error other than a missing file', t => {
  const dir = tmpDir(t);
  const real = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...rest) => {
    if (file === inboxFile(dir)) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return real(file, ...rest);
  });
  assert.throws(() => readRequests(dir), /access denied/);
});

test('readRequests stops when the file shrinks under it instead of waiting for bytes that are gone', t => {
  const dir = tmpDir(t);
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  let calls = 0;
  // Every read finds nothing left. The assertion turns a reader that would loop forever into a failure.
  t.mock.method(fs, 'readSync', () => {
    assert.ok(++calls < 100, 'readRequests keeps reading a file that has nothing left');
    return 0;
  });
  assert.deepEqual(readRequests(dir), { requests: [], offset: 0 });
});

test('every file that appendRequest or readRequests opens is closed again, even when they fail', t => {
  const dir = tmpDir(t);
  const open = trackOpenFiles(t);
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  appendRequest(dir, { nodeId: 'g-know-2', direction: 'detail' }); // the file has content now, so this one also peeks at its last byte
  readRequests(dir);
  readRequests(dir, sizeOf(dir));
  readRequests(path.join(dir, 'no-such-folder'));
  assert.equal(open.size, 0, 'after calls that succeed');
  t.mock.method(fs, 'readSync', () => { throw new Error('disk error'); });
  assert.throws(() => readRequests(dir), /disk error/);
  assert.throws(() => appendRequest(dir, { nodeId: 'g-know-3', direction: 'detail' }), /disk error/);
  // A folder where the inbox file belongs is refused once it has been opened, and has to be closed all the same.
  const odd = tmpDir(t);
  fs.mkdirSync(inboxFile(odd));
  assert.throws(() => readRequests(odd), /not a regular file/);
  assert.equal(open.size, 0, 'after calls that fail');
});

// ---- watchInbox ----

test('watchInbox reports requests then idles', async t => {
  const dir = tmpDir(t);
  const events = [];
  const finished = new Promise(resolve => {
    startWatch(t, dir, {
      offset: 0, pollMs: 20, idleMs: 150,
      onRequest: req => events.push(`request ${req.nodeId}`),
      onIdle: () => { events.push('idle'); resolve(); },
    });
    // The watch is running but has not polled yet, so this request arrives after it started.
    appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  });
  await within(finished, 5000, 'the watch to go idle');
  assert.deepEqual(events, ['request g-know-1', 'idle']);
});

test('watchInbox reports the requests already in the file, from the offset it is given (0 when none is)', async t => {
  const dir = tmpDir(t);
  const a = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const afterA = sizeOf(dir);
  const b = appendRequest(dir, { nodeId: 'g-know-2', direction: 'detail' });
  const c = appendRequest(dir, { nodeId: 'g-know-3', direction: 'detail' });
  const reported = options => within(new Promise(resolve => {
    const ids = [];
    startWatch(t, dir, { pollMs: 20, idleMs: 60, ...options, onRequest: r => ids.push(r.id), onIdle: () => resolve(ids) });
  }), 5000, 'the watch to go idle');
  assert.deepEqual(await reported({ offset: 0 }), [a.id, b.id, c.id]);
  assert.deepEqual(await reported({ offset: afterA }), [b.id, c.id]);
  assert.deepEqual(await reported({ offset: sizeOf(dir) }), []);
  assert.deepEqual(await reported({}), [a.id, b.id, c.id]);
});

test('watchInbox started with an offset past the end of the file reads the file from the beginning', async t => {
  const dir = tmpDir(t);
  const a = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const reported = within(new Promise(resolve => {
    const ids = [];
    startWatch(t, dir, { offset: 100_000, pollMs: 20, idleMs: 60, onRequest: r => ids.push(r.id), onIdle: () => resolve(ids) });
  }), 5000, 'the watch to go idle');
  assert.deepEqual(await reported, [a.id]);
});

test('watchInbox keeps polling an inbox that does not exist yet and reports once the file appears', async t => {
  const dir = tmpDir(t);
  const polls = countPolls(t, dir);
  const seen = [];
  startWatch(t, dir, { offset: 0, pollMs: 20, idleMs: 60_000, onRequest: r => seen.push(r.nodeId) });
  await waitFor(() => polls.count >= 3, 'three polls of the missing file');
  assert.equal(fs.existsSync(inboxFile(dir)), false);
  assert.deepEqual(seen, []);
  appendRequest(dir, { nodeId: 'g-warn-1', direction: 'examples' });
  await waitFor(() => seen.length === 1, 'the first request');
  appendRequest(dir, { nodeId: 'g-warn-2', direction: 'examples' });
  await waitFor(() => seen.length === 2, 'the second request');
  assert.deepEqual(seen, ['g-warn-1', 'g-warn-2']);
});

test('watchInbox also waits for a topic folder that does not exist yet', async t => {
  const dir = path.join(tmpDir(t), 'later');
  const polls = countPolls(t, dir);
  const seen = [];
  startWatch(t, dir, { offset: 0, pollMs: 20, idleMs: 60_000, onRequest: r => seen.push(r.nodeId) });
  await waitFor(() => polls.count >= 3, 'three polls of the missing folder');
  fs.mkdirSync(dir);
  appendRequest(dir, { nodeId: 'g-warn-1', direction: 'examples' });
  await waitFor(() => seen.length === 1, 'the request');
  assert.deepEqual(seen, ['g-warn-1']);
});

// The next three tests drive the watch's timers and its clock by hand, so they measure intervals exactly and wait for
// nothing. advance(ms) moves the fake clock and the fake timers forward together.
function fakeTime(t) {
  let now = 1000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  return ms => { now += ms; t.mock.timers.tick(ms); };
}

// Whatever pollMs is given is the interval, with no floor under it: 20 ms is as good as 4 s. With none given, it is a second.
for (const [name, options, every] of [
  ['20 ms', { pollMs: 20 }, 20], ['37 ms', { pollMs: 37 }, 37], ['250 ms', { pollMs: 250 }, 250],
  ['4 s', { pollMs: 4000 }, 4000], ['second when pollMs is not given', {}, 1000],
]) {
  test(`watchInbox polls every ${name}`, t => {
    const dir = tmpDir(t);
    const advance = fakeTime(t);
    const polls = countPolls(t, dir);
    startWatch(t, dir, { offset: 0, idleMs: 3_600_000, onRequest() {}, ...options });
    advance(0);
    assert.equal(polls.count, 1, 'the first poll comes at once');
    for (let n = 2; n <= 4; n++) {
      advance(every - 1);
      assert.equal(polls.count, n - 1, `poll ${n} does not come before ${every} ms have passed`);
      advance(1);
      assert.equal(polls.count, n, `poll ${n} comes ${every} ms after the one before`);
    }
  });
}

test('watchInbox goes idle after 30 minutes without a request when idleMs is not given', t => {
  const dir = tmpDir(t);
  const advance = fakeTime(t);
  let idle = 0;
  // A 10 minute pollMs keeps this to a few steps: the poll nearest the deadline is brought forward to land on it.
  startWatch(t, dir, { offset: 0, pollMs: 600_000, onRequest() {}, onIdle: () => { idle += 1; } });
  advance(0);
  advance(600_000);
  advance(600_000);
  advance(599_999);
  assert.equal(idle, 0, 'not a millisecond before 30 minutes');
  advance(1);
  assert.equal(idle, 1, 'at 30 minutes');
});

test('the idle window restarts with each request, and a request is read before idle is declared', async t => {
  const dir = tmpDir(t);
  const idleMs = 200;
  const log = [];
  const finished = new Promise(resolve => {
    let fed = 0;
    startWatch(t, dir, {
      offset: 0, pollMs: 20, idleMs,
      onRequest: () => {
        log.push(['request', performance.now()]);
        // The next request is appended from inside the callback, so the watch finds it on its next poll whatever the load.
        if (++fed < 3) appendRequest(dir, { nodeId: `g-know-${fed + 1}`, direction: 'detail' });
      },
      onIdle: () => { log.push(['idle', performance.now()]); resolve(); },
    });
    appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  });
  await within(finished, 5000, 'the watch to go idle');
  assert.deepEqual(log.map(([event]) => event), ['request', 'request', 'request', 'idle']);
  const quiet = log[3][1] - log[2][1];
  assert.ok(quiet >= idleMs, `idle came ${quiet} ms after the last request, before the ${idleMs} ms window ran out`);
});

test('a slow onRequest does not use up the idle window', async t => {
  const dir = tmpDir(t);
  const idleMs = 60;
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  let handledAt;
  const finished = new Promise(resolve => {
    startWatch(t, dir, {
      offset: 0, pollMs: 20, idleMs,
      // 100 ms of work, longer than the whole window. The window counts from when the request has been handled.
      onRequest: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); handledAt = performance.now(); },
      onIdle: () => resolve(performance.now()),
    });
  });
  const idleAt = await within(finished, 5000, 'the watch to go idle');
  assert.ok(idleAt - handledAt >= idleMs, `idle came ${idleAt - handledAt} ms after the request was handled`);
});

test('watchInbox calls onIdle once and then stops for good, no sooner than idleMs after it started', async t => {
  const dir = tmpDir(t);
  const idleMs = 60;
  const calls = [];
  const startedAt = performance.now();
  let idleAt;
  const finished = new Promise(resolve => {
    startWatch(t, dir, {
      offset: 0, pollMs: 20, idleMs,
      onRequest: r => calls.push(`request ${r.nodeId}`),
      onIdle: () => { idleAt = performance.now(); calls.push('idle'); resolve(); },
    });
  });
  await within(finished, 5000, 'the watch to go idle');
  assert.ok(idleAt - startedAt >= idleMs, `idle came ${idleAt - startedAt} ms after the start, before the ${idleMs} ms window ran out`);
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  await sleep(150); // several polls: a watch that kept going would report the request
  assert.deepEqual(calls, ['idle']);
});

test('the first poll comes right after watchInbox returns, not a pollMs later', async t => {
  const dir = tmpDir(t);
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const seen = [];
  startWatch(t, dir, { offset: 0, pollMs: 60_000, idleMs: 60_000, onRequest: r => seen.push(r.nodeId) });
  await waitFor(() => seen.length === 1, 'the request that was already waiting', 3000);
});

test('an idleMs shorter than pollMs is still met', async t => {
  const dir = tmpDir(t);
  const finished = new Promise(resolve => {
    startWatch(t, dir, { offset: 0, pollMs: 60_000, idleMs: 50, onRequest() {}, onIdle: resolve });
  });
  await within(finished, 3000, 'idle, a minute-long poll interval notwithstanding');
});

test('onIdle is optional', async t => {
  const dir = tmpDir(t);
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const seen = [];
  startWatch(t, dir, { offset: 0, pollMs: 20, idleMs: NO_WAIT, onRequest: r => seen.push(r.nodeId) });
  await waitFor(() => seen.length === 1, 'the request');
  await sleep(50); // idle is declared in the same poll as the request, and would have thrown on a missing onIdle by now
  assert.deepEqual(seen, ['g-know-1']);
});

test('stop() ends the watch before it reports anything, idle included', async t => {
  const dir = tmpDir(t);
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' }); // already waiting in the file
  const calls = [];
  // An idle window of NO_WAIT would report the request and go idle at once if this watch were not stopped.
  const watch = watchInbox(dir, { offset: 0, pollMs: 20, idleMs: NO_WAIT, onRequest: () => calls.push('request'), onIdle: () => calls.push('idle') });
  watch.stop();
  watch.stop(); // stopping twice is fine
  await sleep(150);
  assert.deepEqual(calls, []);
});

test('stop() inside onRequest drops the rest of that batch and never reports idle', async t => {
  for (const waiting of [1, 3]) { // with one request, stop() runs in the last callback of the batch
    const dir = tmpDir(t);
    for (let i = 1; i <= waiting; i++) appendRequest(dir, { nodeId: `g-know-${i}`, direction: 'detail' });
    const calls = [];
    // An idle window of NO_WAIT would declare idle right after the batch if stop() did not hold.
    const watch = startWatch(t, dir, {
      offset: 0, pollMs: 20, idleMs: NO_WAIT,
      onRequest: r => { calls.push(r.nodeId); watch.stop(); },
      onIdle: () => calls.push('idle'),
    });
    await sleep(150);
    assert.deepEqual(calls, ['g-know-1'], `${waiting} request(s) waiting`);
  }
});

test('watchInbox rejects a missing or non-function callback and a bad offset', t => {
  const dir = tmpDir(t);
  const ok = { offset: 0, pollMs: 20, idleMs: 100, onRequest() {} };
  const started = [];
  t.after(() => started.forEach(watch => watch.stop())); // a watch that should have been refused must not outlive the test
  const bad = [{ onRequest: undefined }, { onRequest: 'go' }, { onIdle: 'done' }, { offset: -1 }, { offset: 1.5 }, { offset: '0' }, { offset: null }];
  for (const options of bad) {
    assert.throws(() => started.push(watchInbox(dir, { ...ok, ...options })), /onRequest|onIdle|offset/, inspect(options));
  }
});

test('watchInbox throws a RangeError, before it starts any timer, for a pollMs or idleMs it cannot honor', t => {
  const dir = tmpDir(t);
  const advance = fakeTime(t);
  const polls = countPolls(t, dir);
  const ok = { offset: 0, pollMs: 20, idleMs: 100, onRequest() {} };
  const started = [];
  t.after(() => started.forEach(watch => watch.stop()));
  // pollMs has to be a number from 1 to 2**31 - 1: setTimeout turns a delay outside that into 1 ms, a busy loop.
  // idleMs has to be a number above 0 (Infinity: never idle).
  const bad = [
    { pollMs: 0 }, { pollMs: -1 }, { pollMs: NaN }, { pollMs: 2 ** 31 }, { pollMs: '5' }, { pollMs: 0.5 }, { pollMs: Infinity },
    { idleMs: 0 }, { idleMs: -5 }, { idleMs: NaN }, { idleMs: '100' },
  ];
  for (const options of bad) {
    assert.throws(() => started.push(watchInbox(dir, { ...ok, ...options })),
      err => err instanceof RangeError && /pollMs|idleMs/.test(err.message), inspect(options));
  }
  advance(60_000); // a timer started by any of those calls would poll now
  assert.equal(polls.count, 0, 'no poll ran, so no call started a timer');
  assert.equal(started.length, 0);
  // The edges that are fine, and a watch with every default.
  for (const options of [{ pollMs: 1 }, { pollMs: 2 ** 31 - 1 }, { idleMs: Infinity }, { idleMs: NO_WAIT }]) {
    started.push(watchInbox(dir, { ...ok, ...options }));
  }
  started.push(watchInbox(dir, { onRequest() {} }));
  assert.equal(started.length, 5);
});

test('an idleMs of Infinity never goes idle, however long the watch runs', t => {
  const dir = tmpDir(t);
  const advance = fakeTime(t);
  const polls = countPolls(t, dir);
  let idle = 0;
  const longest = 2 ** 31 - 1; // the longest pollMs there is: about 25 days
  startWatch(t, dir, { offset: 0, pollMs: longest, idleMs: Infinity, onRequest() {}, onIdle: () => { idle += 1; } });
  advance(0);
  for (let i = 0; i < 3; i++) advance(longest);
  assert.equal(polls.count, 4, 'it keeps polling, a poll every pollMs');
  assert.equal(idle, 0);
});

// ---- failing loudly ----
// dr.cjs watch relies on these: a watch that hits a failure must end the process, not carry on and report idle. The
// two watch cases run in a process of their own, so what is tested is the real crash and not node:test's handling of one.

function runChild(t, source) {
  const script = path.join(tmpDir(t), 'child.cjs');
  fs.writeFileSync(script, source);
  return spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
}
// A script that watches dir and prints IDLE-MARKER if it ever goes idle. idleMs is long enough for a watch that
// ignored the failure to get there, so the marker's absence means something.
const watchScript = (dir, onRequest) => `
  const { watchInbox } = require(${INBOX_MODULE});
  watchInbox(${JSON.stringify(dir)}, {
    offset: 0, pollMs: 20, idleMs: 300,
    onRequest: ${onRequest},
    onIdle() { console.log('IDLE-MARKER'); },
  });`;

test('an onRequest that throws ends the process with that error, and no idle line', t => {
  const dir = tmpDir(t);
  appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const child = runChild(t, watchScript(dir, "() => { throw new Error('boom from onRequest'); }"));
  assert.equal(child.error, undefined, 'the process ended by itself');
  assert.ok(child.status > 0, `exit status ${child.status}`);
  assert.match(child.stderr, /boom from onRequest/);
  assert.doesNotMatch(child.stdout, /IDLE-MARKER/);
});

test('a read error during a poll ends the process with that error, and no idle line', t => {
  const dir = tmpDir(t);
  fs.mkdirSync(inboxFile(dir)); // a folder where the inbox file belongs: not a missing file, and not an empty inbox either
  const child = runChild(t, watchScript(dir, '() => {}'));
  assert.equal(child.error, undefined, 'the process ended by itself');
  assert.ok(child.status > 0, `exit status ${child.status}`);
  assert.match(child.stderr, /not a regular file/);
  assert.doesNotMatch(child.stdout, /IDLE-MARKER/);
});

test('appendRequest into a folder that does not exist throws ENOENT and creates nothing', t => {
  const parent = tmpDir(t);
  const missing = path.join(parent, 'no-such-topic');
  assert.throws(() => appendRequest(missing, { nodeId: 'g-know-1', direction: 'detail' }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(missing), false);
  assert.deepEqual(fs.readdirSync(parent), []);
});
