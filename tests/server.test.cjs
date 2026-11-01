const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { inspect } = require('node:util');
const { createMap, saveMap } = require('../scripts/lib/map.cjs');
const { appendRequest, readRequests } = require('../scripts/lib/inbox.cjs');
const { renderIndexHtml } = require('../scripts/lib/render.cjs');
const { startServer } = require('../scripts/lib/server.cjs');

// The first eight tests carry the plan's names. The others pin what the rulings and the dispatch notes add: how the server
// starts and stops (a rejected promise, never a crash; the idle stop and the `closed` promise), how it treats map.json
// while Claude writes it, what each stream and route sends, the guards against other websites and DNS rebinding, and
// everything POST /expand does with a body. Every server and every stream a test opens is closed when the test ends,
// whether it passed or not, so the process can exit. A test that waits on a server that never answers fails after a minute
// instead of hanging the run.
const test = (name, fn) => nodeTest(name, { timeout: 60000 }, fn);

const T0 = new Date('2026-11-01T10:00:00Z');
const BRIEF = { goal: 'สร้างงาน', level: 'ไม่รู้เลย', focus: '', exclude: '', depth: 'standard', constraints: '' };
const THAI = /[ก-๛]/; // the text of every error is a Thai sentence
const CRLF = String.fromCharCode(13, 10);
const NEL = String.fromCharCode(0x85); // next line: not white space to String.prototype.trim, and to no regular expression's \s
const KB = 1024;
const DETAIL = { nodeId: 'g-know-1', direction: 'detail' };
const AS_JSON = { 'Content-Type': 'application/json' };

const later = minutes => new Date(T0.getTime() + minutes * 60000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waits until check() is truthy. The limits are generous: only a broken server ever reaches one.
async function waitFor(check, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(5);
  }
}
// Rejects when the promise has not settled within `ms`, so that a hang is a failure that says what hung.
function within(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
// The timers that keep this process alive. A server's poll, ping and idle timers are among them while it runs.
const liveTimers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return dir;
}
// A folder with a map.json: a new map (all groups planned, so every group is a leaf) that `edit` may change first.
function seeded(t, edit) {
  const dir = tmpDir(t);
  const map = createMap({ topic: 'ทดสอบ', slug: 'test-topic', brief: BRIEF, now: T0 });
  edit?.(map);
  saveMap(dir, map, { now: T0 });
  return { dir, map };
}
async function start(t, dir, options) {
  const server = await startServer({ dir, ...options });
  t.after(() => server.close());
  return server;
}
// What startServer rejects with for these options. A server that starts anyway is closed, and the test fails.
async function refusedWith(options) {
  let server;
  try {
    server = await startServer(options);
  } catch (err) {
    return err;
  }
  await server.close();
  return assert.fail(`startServer accepted ${inspect(options)}`);
}
const mapFile = dir => path.join(dir, 'map.json');
const inboxFile = dir => path.join(dir, 'inbox.jsonl');
const inboxLines = dir => (fs.existsSync(inboxFile(dir)) ? fs.readFileSync(inboxFile(dir), 'utf8').split('\n').filter(Boolean) : []);

// One request over node:http, which lets a test set what fetch will not (Host) or would tidy up (Origin, the content type),
// and send a path exactly as written. It gives up after 5 s.
function send(url, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: target, method, headers, agent: false, timeout: 5000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer to ${method} ${target}`)));
    req.on('error', reject);
    req.end(body);
  });
}
const post = (url, body, headers = AS_JSON) => send(url, {
  method: 'POST', path: '/expand', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
});
// The response is a refusal: this status and a JSON body of just { error }, whose text is Thai.
function assertRefused(res, status) {
  assert.equal(res.status, status, res.text);
  assert.match(res.headers['content-type'], /^application\/json/);
  const body = res.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.match(body.error, THAI);
}
// The bytes of a request, as written on a socket, and everything that comes back until the server closes it.
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1', timeout: 5000 }, () => socket.write(text));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('timeout', () => socket.destroy(new Error('no answer')));
    socket.on('error', reject);
  });
}
// A raw answer, cut into the same shape send() gives: { status, headers, text, json() }.
function parseResponse(answer) {
  const split = answer.indexOf(CRLF + CRLF);
  const [statusLine, ...headerLines] = answer.slice(0, split).split(CRLF);
  const headers = Object.fromEntries(headerLines.map(line => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
  const text = answer.slice(split + CRLF.length * 2);
  return { status: Number(statusLine.split(' ')[1]), headers, text, json: () => JSON.parse(text) };
}
// A POST whose body goes out in the chunks given and has no Content-Length. It is written by hand: node's own client adds a
// Content-Length to a body it is given whole, and then the limit on a body that has none would never be tried.
async function postChunked(port, pieces) {
  const head = ['POST /expand HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Content-Type: application/json', 'Transfer-Encoding: chunked', 'Connection: close', '', ''].join(CRLF);
  const chunks = pieces.map(piece => `${Buffer.byteLength(piece).toString(16)}${CRLF}${piece}${CRLF}`).join('');
  return parseResponse(await raw(port, `${head}${chunks}0${CRLF}${CRLF}`));
}
// The text of a POST /expand body of exactly this many bytes: a question padded with ASCII.
function questionBody(bytes) {
  const empty = Buffer.byteLength(JSON.stringify({ nodeId: 'g-know-1', direction: 'question', question: '' }));
  const body = JSON.stringify({ nodeId: 'g-know-1', direction: 'question', question: 'x'.repeat(bytes - empty) });
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}
// Resolves when a connection to host:port is made, rejects when it is refused or does not come within `ms`.
function connects(host, port, ms = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: ms });
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('no answer')); });
    socket.on('error', reject);
  });
}

// Opens /events and collects what arrives. The connection is dropped when the test ends.
function openEvents(t, url, headers) {
  const stream = { text: '', status: null, headers: null, ended: false };
  const { hostname, port } = new URL(url);
  stream.req = http.get({ hostname, port, path: '/events', agent: false, headers }, res => {
    stream.status = res.statusCode;
    stream.headers = res.headers;
    res.setEncoding('utf8');
    res.on('data', chunk => { stream.text += chunk; });
    res.on('end', () => { stream.ended = true; });
    res.on('close', () => { stream.ended = true; });
  });
  stream.req.on('error', () => {});
  t.after(() => stream.req.destroy());
  return stream;
}
const opened = stream => waitFor(() => stream.status !== null, 'the stream to open');
// The events in the text of a stream, as { event, data } with the data read as JSON. Comment lines are not events.
function eventsIn(text) {
  const blocks = text.split('\n\n');
  blocks.pop(); // what follows the last blank line is either nothing or an event that has not all arrived
  return blocks.filter(block => /^event: /m.test(block)).map(block => ({
    event: /^event: (.*)$/m.exec(block)[1],
    data: JSON.parse(/^data: (.*)$/m.exec(block)[1]),
  }));
}
const eventsNamed = (stream, name) => eventsIn(stream.text).filter(e => e.event === name);

// ---- the plan's tests ----

test('GET / serves live page', async t => {
  const { dir, map } = seeded(t);
  const { url } = await start(t, dir);
  const res = await fetch(`${url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();
  assert.ok(html.includes('data-mode="live"'));
  // It is the renderer's page for the map, nothing added and nothing left out.
  assert.equal(html, renderIndexHtml(map, { live: true }));
});

test('GET /map.json returns the map', async t => {
  const { dir, map } = seeded(t);
  const { url } = await start(t, dir);
  const res = await fetch(`${url}/map.json`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), map);
});

test('POST /expand queues a request', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const res = await fetch(`${url}/expand`, { method: 'POST', headers: AS_JSON, body: JSON.stringify(DETAIL) });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  assert.match(id, /^r-/);
  const { requests } = readRequests(dir);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, id);
  assert.equal(requests[0].nodeId, 'g-know-1');
  assert.equal(requests[0].direction, 'detail');
  assert.equal('question' in requests[0], false);
});

test('POST /expand rejects bad input', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const bad = [
    { nodeId: 'g-know-1', direction: 'sideways' }, // an unknown direction
    { nodeId: 'g-nowhere', direction: 'detail' }, // an unknown node
    { nodeId: 'g-know-1', direction: 'question' }, // a question without text
    { nodeId: 'g-know-1', direction: 'question', question: '   ' }, // and one that is only white space
  ];
  for (const body of bad) assertRefused(await post(url, body), 400);
  assert.deepEqual(readRequests(dir).requests, []);
});

test('POST /expand dedupes', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const first = await post(url, DETAIL);
  const second = await post(url, DETAIL);
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(second.json().duplicate, true);
  assert.equal(second.json().id, first.json().id);
  assert.equal(inboxLines(dir).length, 1);
});

test('serves last good map when map.json is corrupt', async t => {
  const { dir, map } = seeded(t);
  const { url } = await start(t, dir);
  fs.writeFileSync(mapFile(dir), '{"bad');
  await sleep(700); // the map is polled every 500 ms
  const res = await fetch(`${url}/map.json`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), map);
});

test('SSE reports map changes', async t => {
  const { dir, map } = seeded(t);
  const { url } = await start(t, dir);
  const stream = openEvents(t, url);
  await opened(stream);
  saveMap(dir, map, { now: later(1) });
  await waitFor(() => stream.text.includes('event: map'), 'a map event', 3000);
  assert.deepEqual(eventsNamed(stream, 'map')[0].data, { updatedAt: later(1).toISOString() });
  assert.deepEqual(await (await fetch(`${url}/map.json`)).json(), map); // and /map.json already has the new map
});

test('binds loopback only', async t => {
  const { dir } = seeded(t);
  const server = await start(t, dir);
  assert.ok(server.url.startsWith('http://127.0.0.1:'), server.url);
  assert.ok(Number.isInteger(server.port) && server.port > 0);
  assert.equal(new URL(server.url).port, String(server.port));
  // A server bound to every interface would answer on 127.0.0.2 too (all of 127.0.0.0/8 is this machine on Windows and Linux),
  // and on the machine's own address; this one answers on neither.
  await assert.rejects(connects('127.0.0.2', server.port, 500), undefined, 'the server answered on 127.0.0.2');
  const other = Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal);
  if (other) await assert.rejects(connects(other.address, server.port, 300), undefined, `the server answered on ${other.address}`);
});

// ---- starting and stopping ----

test('startServer rejects, and does not throw, when map.json cannot be loaded', async t => {
  const dir = tmpDir(t);
  const attempt = startServer({ dir });
  assert.ok(attempt instanceof Promise);
  await assert.rejects(attempt, { code: 'ENOENT' }); // no map.json at all

  fs.writeFileSync(mapFile(dir), '{"bad');
  assert.ok(await refusedWith({ dir }) instanceof SyntaxError);
  for (const text of ['null', '[]', '42', '"text"']) { // JSON that parses but is not a map
    fs.writeFileSync(mapFile(dir), text);
    assert.match((await refusedWith({ dir })).message, /map/, text);
  }
});

test('startServer rejects when the port is taken, and leaves no timer running', async t => {
  const { dir } = seeded(t);
  const blocker = net.createServer();
  t.after(() => blocker.close());
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const before = liveTimers();
  const err = await refusedWith({ dir, port: blocker.address().port });
  assert.equal(err.code, 'EADDRINUSE');
  assert.equal(liveTimers(), before);
});

test('startServer rejects options it cannot honour', async t => {
  const { dir } = seeded(t);
  const refused = [
    [{ dir: undefined }, TypeError, /dir/],
    [{ dir: '' }, TypeError, /dir/],
    [{ dir, host: '0.0.0.0' }, RangeError, /host/], // the server binds to the loopback interface only
    [{ dir, host: 'example.com' }, RangeError, /host/],
    [{ dir, port: 65536 }, RangeError, /port/],
    [{ dir, port: -1 }, RangeError, /port/],
    [{ dir, port: 1.5 }, RangeError, /port/],
    [{ dir, port: 'abc' }, RangeError, /port/], // listen would take that for the name of a pipe or a socket file
    [{ dir, port: null }, RangeError, /port/],
    [{ dir, port: 80 }, RangeError, /port 80/], // a browser leaves the default port out of Host and Origin, so every request would be 403
    [{ dir, idleMs: 0 }, RangeError, /idleMs/],
    [{ dir, idleMs: -1 }, RangeError, /idleMs/],
    [{ dir, idleMs: Number.NaN }, RangeError, /idleMs/],
    [{ dir, idleMs: '5000' }, RangeError, /idleMs/],
    [{ dir, idleMs: 2 ** 31 }, RangeError, /idleMs/], // setTimeout would run that one after 1 ms
    [{ dir, pingMs: 0 }, RangeError, /pingMs/],
    [{ dir, pingMs: Infinity }, RangeError, /pingMs/],
  ];
  for (const [options, type, message] of refused) {
    const err = await refusedWith(options);
    assert.ok(err instanceof type, `${inspect(options)} gave ${err}`);
    assert.match(err.message, message);
  }
  // Infinity is how a caller says "never idle"; localhost is a loopback name too.
  const never = await start(t, dir, { idleMs: Infinity, host: 'localhost' });
  assert.equal(new URL(never.url).hostname, 'localhost');
  assert.equal((await fetch(`${never.url}/map.json`)).status, 200);
});

test('an error from the listening socket is written to stderr, and the server carries on', async t => {
  // net.Server emits "error" when it fails to accept a connection (EMFILE: too many open files). Nothing listening for it
  // makes that a thrown error, which ends the process and leaves the page offline.
  const { dir } = seeded(t);
  const createServer = http.createServer;
  let inner;
  const spy = t.mock.method(http, 'createServer', (...args) => { inner = createServer(...args); return inner; });
  const { url } = await start(t, dir);
  spy.mock.restore();
  assert.ok(inner, 'startServer did not create its server with http.createServer');

  const written = t.mock.method(process.stderr, 'write', () => true);
  let thrown = null;
  try {
    inner.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
  } catch (err) {
    thrown = err;
  }
  written.mock.restore();
  assert.equal(thrown, null, 'the error event was thrown');
  assert.equal(written.mock.callCount(), 1);
  assert.match(String(written.mock.calls[0].arguments[0]), /^.*EMFILE.*too many open files.*\n$/); // one line, with the code and the message
  assert.equal((await fetch(`${url}/map.json`)).status, 200); // and the server still answers
  assert.equal((await post(url, DETAIL)).status, 202);
});

test('close() ends the streams, frees the port, clears its timers and resolves closed', async t => {
  const { dir } = seeded(t);
  const before = liveTimers();
  const server = await start(t, dir);
  assert.ok(liveTimers() > before, 'a running server has timers, or this test measures nothing');
  const stream = openEvents(t, server.url);
  await opened(stream);
  assert.equal(await Promise.race([server.closed, sleep(50).then(() => 'still open')]), 'still open');

  assert.equal(await server.close(), undefined);
  assert.equal(await server.closed, 'closed');
  await waitFor(() => stream.ended, 'the stream to end', 2000);
  await assert.rejects(connects('127.0.0.1', server.port)); // the port is free again
  await sleep(20);
  assert.equal(liveTimers(), before);
  assert.equal(await server.close(), undefined); // a second call is fine
  assert.equal(await server.closed, 'closed');
});

test('close() does not wait for a request that is still being sent', async t => {
  const { dir } = seeded(t);
  const server = await start(t, dir);
  const socket = net.connect(server.port, '127.0.0.1');
  socket.on('error', () => {});
  const head = ['POST /expand HTTP/1.1', `Host: 127.0.0.1:${server.port}`, 'Content-Type: application/json', 'Content-Length: 500', '', '{"nodeId":'].join(CRLF);
  await new Promise(resolve => socket.write(head, resolve));
  await sleep(50); // the server is now waiting for the other 490 bytes, which never come
  try {
    await within(server.close(), 3000, 'close() to finish with a request open');
  } finally {
    socket.destroy(); // so that a close() that is stuck lets go, and the test can end
  }
});

test('the server stops itself after idleMs with no POST /expand', async t => {
  const { dir } = seeded(t);
  const idleMs = 1000; // long enough that starting a server and opening a stream cannot use it up, even on a slow machine
  const before = liveTimers();
  const startedAt = performance.now(); // taken before start(): the idle timer is armed after this, so it cannot run out sooner
  const server = await start(t, dir, { idleMs });
  const stream = openEvents(t, server.url);
  await opened(stream);
  assert.equal(await server.closed, 'idle');
  const waited = performance.now() - startedAt;
  assert.ok(waited >= idleMs - 20, `it stopped after ${Math.round(waited)} ms, not idleMs (a timer may run a millisecond or two early)`);
  await waitFor(() => stream.ended, 'the stream to end', 2000);
  await assert.rejects(connects('127.0.0.1', server.port)); // closed does not resolve before the port is free
  await sleep(20);
  assert.equal(liveTimers(), before);
  assert.equal(await server.close(), undefined); // closing a server that has stopped is fine
  assert.equal(await server.closed, 'idle'); // and it was the idle timer that stopped it
});

test('a POST /expand that passes the origin checks resets the idle timer', async t => {
  const { dir } = seeded(t);
  const idleMs = 1000; // the POST has to land before this runs out: 750 ms of room, however slow the machine is
  const server = await start(t, dir, { idleMs });
  await sleep(250);
  const sentAt = performance.now(); // before the POST goes out, so the server has not yet reset its timer
  assert.equal((await post(server.url, DETAIL)).status, 202);
  assert.equal(await server.closed, 'idle');
  // Without the reset the server would have closed about 750 ms after the POST.
  assert.ok(performance.now() - sentAt >= idleMs - 20, `closed ${Math.round(performance.now() - sentAt)} ms after the POST`);
});

test('requests that fail the origin checks, and plain GETs, do not reset the idle timer', async t => {
  // Two servers start together with the same idleMs. Only the first is sent the requests below. If one of them reset its timer
  // the first would stop 300 ms after the second; a slow machine delays both stops by the same amount, so the two are compared
  // with each other and not with the clock.
  const { dir } = seeded(t);
  const idleMs = 1000;
  const [touched, untouched] = await Promise.all([start(t, dir, { idleMs }), start(t, dir, { idleMs })]);
  const stoppedAt = server => server.closed.then(reason => ({ reason, at: performance.now() }));
  const stops = Promise.all([stoppedAt(touched), stoppedAt(untouched)]);
  await sleep(300);
  assertRefused(await post(touched.url, DETAIL, { ...AS_JSON, Origin: 'https://evil.example' }), 403);
  assertRefused(await post(touched.url, '{}', { ...AS_JSON, Host: 'evil.example' }), 403);
  assert.equal((await fetch(`${touched.url}/map.json`)).status, 200);
  assert.equal((await fetch(`${touched.url}/`)).status, 200);
  const [first, second] = await stops;
  assert.deepEqual([first.reason, second.reason], ['idle', 'idle']);
  assert.ok(first.at - second.at < 150, `the server that was sent the requests stopped ${Math.round(first.at - second.at)} ms after the other`);
});

// ---- the map cache ----

test('keeps the last good map when map.json is missing or is not a map, and sends no event for them', async t => {
  const { dir, map } = seeded(t);
  const { url } = await start(t, dir);
  const stream = openEvents(t, url);
  await opened(stream);
  const unchanged = async () => {
    await sleep(600); // a poll has come by since the write
    assert.deepEqual(await (await fetch(`${url}/map.json`)).json(), map);
    assert.equal((await fetch(`${url}/`)).status, 200); // the page is still drawn from the last good map
    assert.equal(stream.text.includes('event: map'), false);
  };
  await sleep(600);
  assert.equal(stream.text.includes('event: map'), false); // a file that did not change is not news
  for (const text of ['null', '[]']) {
    fs.writeFileSync(mapFile(dir), text);
    await unchanged();
  }
  fs.rmSync(mapFile(dir));
  await unchanged();

  // The next good file comes through, as one event.
  saveMap(dir, map, { now: later(2) });
  await waitFor(() => stream.text.includes('event: map'), 'a map event', 3000);
  assert.deepEqual(await (await fetch(`${url}/map.json`)).json(), map);
  assert.equal(eventsNamed(stream, 'map').length, 1);
});

test('a corrupt map.json sends no event, and the next good one does', async t => {
  const { dir, map } = seeded(t);
  const { url } = await start(t, dir);
  const stream = openEvents(t, url);
  await opened(stream);
  fs.writeFileSync(mapFile(dir), '{"bad');
  await sleep(700);
  assert.equal(stream.text.includes('event: map'), false);
  saveMap(dir, map, { now: later(3) });
  await waitFor(() => stream.text.includes('event: map'), 'a map event', 3000);
  assert.deepEqual(eventsNamed(stream, 'map')[0].data, { updatedAt: later(3).toISOString() });
});

test('a map.json that cannot be read for a moment is read again, not skipped', async t => {
  const { dir, map } = seeded(t);
  const { url } = await start(t, dir);
  const stream = openEvents(t, url);
  await opened(stream);
  // Windows refuses a read of map.json while another process renames over it: EPERM or EBUSY, gone a moment later.
  const read = fs.readFileSync;
  const target = mapFile(dir);
  const locked = t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (file === target) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    return read(file, ...rest);
  });
  const attempts = () => locked.mock.calls.filter(call => call.arguments[0] === target).length;
  saveMap(dir, map, { now: later(4) });
  await waitFor(() => attempts() >= 2, 'two polls to fail to read it', 4000); // it tries again on every poll
  assert.equal(stream.text.includes('event: map'), false);
  assert.equal((await fetch(`${url}/map.json`)).status, 200); // the server is still up, on the last good map
  locked.mock.restore();
  await waitFor(() => stream.text.includes('event: map'), 'the map event once it can be read', 3000);
  assert.deepEqual(await (await fetch(`${url}/map.json`)).json(), map);
});

test('a save is noticed even when it has the same size and modification time as the one before', async t => {
  // On a file system with a coarse clock two quick saves can share an mtime, and these two texts have the same length.
  // A save replaces the file, so its file id differs, and that is what tells them apart.
  const { dir, map } = seeded(t);
  const file = mapFile(dir);
  const pinned = new Date('2026-11-01T09:00:00Z');
  fs.utimesSync(file, pinned, pinned);
  const before = fs.statSync(file, { bigint: true });
  const { url } = await start(t, dir);
  const stream = openEvents(t, url);
  await opened(stream);
  saveMap(dir, map, { now: later(6) });
  fs.utimesSync(file, pinned, pinned); // no await in between: the server cannot look at the file while it has another mtime
  const after = fs.statSync(file, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ino, before.ino);
  await waitFor(() => stream.text.includes('event: map'), 'a map event', 3000);
  assert.deepEqual(await (await fetch(`${url}/map.json`)).json(), map);
});

// ---- streams ----

test('GET /events opens at once, with the documented headers', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const stream = openEvents(t, url);
  await waitFor(() => stream.status !== null && stream.text !== '', 'the first comment', 1000);
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream');
  assert.equal(stream.headers['cache-control'], 'no-cache');
  assert.match(stream.text, /^: .*\n\n$/); // a comment line, so the page's EventSource fires "open" without waiting for an event
  assert.deepEqual(eventsIn(stream.text), []);
});

test('SSE sends a ping comment every pingMs', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir, { pingMs: 40 });
  const stream = openEvents(t, url);
  await waitFor(() => (stream.text.match(/^: ping\n\n/gm) ?? []).length >= 2, 'two pings', 3000);
  assert.deepEqual(eventsIn(stream.text), []); // a ping is a comment, not an event
});

test('SSE tells every stream about a queued request, once', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const a = openEvents(t, url);
  const b = openEvents(t, url);
  const gone = openEvents(t, url);
  await Promise.all([opened(a), opened(b), opened(gone)]);
  gone.req.destroy(); // a client that went away must not disturb the others
  await sleep(50);

  const first = await post(url, DETAIL);
  assert.equal(first.status, 202);
  await waitFor(() => a.text.includes('event: queued') && b.text.includes('event: queued'), 'the queued event on both streams');
  const [stored] = readRequests(dir).requests;
  assert.equal(stored.id, first.json().id);
  for (const stream of [a, b]) {
    assert.deepEqual(eventsNamed(stream, 'queued'), [{ event: 'queued', data: stored }]); // the Request appendRequest returned
  }
  // A duplicate queues nothing, so there is nothing to tell.
  assert.equal((await post(url, DETAIL)).status, 200);
  await sleep(100);
  assert.equal(eventsNamed(a, 'queued').length, 1);
});

// ---- routes ----

test('/map.json and the page are sent with the documented headers', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const json = await fetch(`${url}/map.json`);
  assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(json.headers.get('cache-control'), 'no-store');
  await json.arrayBuffer();
  const page = await fetch(`${url}/`);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('cache-control'), 'no-store'); // the page embeds the map, so a reload must not show an old one
  // No other site may put the page in a frame: it could lay something over it and get a click on a direction out of the reader.
  assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  await page.arrayBuffer();
});

test('routes by pathname, and answers 404, 405 and 204 where they belong', async t => {
  const { dir, map } = seeded(t);
  const { url } = await start(t, dir);
  // A query string is not part of the path, on a GET or on the POST.
  const withQuery = await send(url, { path: '/map.json?cache=bust&x=1' });
  assert.equal(withQuery.status, 200);
  assert.deepEqual(withQuery.json(), map);
  assert.equal((await send(url, { path: '/?from=somewhere' })).status, 200);
  assert.equal((await send(url, { method: 'POST', path: '/expand?via=query', headers: AS_JSON, body: JSON.stringify(DETAIL) })).status, 202);

  // Unknown paths are 404, whatever the method, and a path is matched whole.
  for (const target of ['/nope', '/index.html', '/map.json/', '//map.json', '/map.json.bak', '/EVENTS', '/expand/']) {
    assertRefused(await send(url, { path: target }), 404);
  }
  assertRefused(await send(url, { method: 'POST', path: '/nope', headers: AS_JSON, body: '{}' }), 404);
  // A known path with the wrong method is 405, and Allow names the right one.
  const wrong = [['POST', '/', 'GET'], ['POST', '/map.json', 'GET'], ['PUT', '/', 'GET'], ['DELETE', '/events', 'GET'], ['GET', '/expand', 'POST'], ['HEAD', '/map.json', 'GET'], ['OPTIONS', '/expand', 'POST']];
  for (const [method, target, allow] of wrong) {
    const res = await send(url, { method, path: target, headers: method === 'POST' ? AS_JSON : {}, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 405, `${method} ${target}`);
    assert.equal(res.headers.allow, allow);
    if (method !== 'HEAD') assertRefused(res, 405); // a HEAD response has no body to check
  }
  // The browser asks for a favicon whatever the page says; 204 keeps an error out of its console.
  const favicon = await send(url, { path: '/favicon.ico' });
  assert.equal(favicon.status, 204);
  assert.equal(favicon.text, '');
});

// ---- guards against other websites and DNS rebinding ----

test('refuses a Host header that is not 127.0.0.1, localhost or [::1] with this port', async t => {
  const { dir } = seeded(t);
  const { url, port } = await start(t, dir);
  const refused = ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `localhost.evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `[::2]:${port}`];
  for (const host of refused) {
    for (const target of ['/map.json', '/', '/events', '/nope']) {
      assertRefused(await send(url, { path: target, headers: { Host: host } }), 403); // for /events too: no stream is opened
    }
    assertRefused(await post(url, DETAIL, { ...AS_JSON, Host: host }), 403);
  }
  assert.deepEqual(readRequests(dir).requests, []); // none of the POSTs queued anything

  // No Host header (an HTTP/1.0 request) and an empty one are refused as well. fetch and http.request would fill them in.
  for (const request of [`GET /map.json HTTP/1.0${CRLF}${CRLF}`, `GET /map.json HTTP/1.1${CRLF}Host:${CRLF}Connection: close${CRLF}${CRLF}`]) {
    const answer = await raw(port, request);
    assert.match(answer, /^HTTP\/1\.1 403 /, answer);
    assert.ok(!answer.includes('schemaVersion'), 'the map was sent');
  }

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LocalHost:${port}`, `[::1]:${port}`]) {
    const res = await send(url, { path: '/map.json', headers: { Host: host } });
    assert.equal(res.status, 200, host);
  }
});

test('refuses an Origin that is not this server, on every request', async t => {
  const { dir } = seeded(t);
  const { url, port } = await start(t, dir);
  const refused = ['https://evil.example', 'http://evil.example', 'null', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, `http://127.0.0.1.evil.example:${port}`, `http://evil.example:${port}`, 'http://localhost'];
  for (const origin of refused) {
    assertRefused(await post(url, DETAIL, { ...AS_JSON, Origin: origin }), 403);
    assertRefused(await send(url, { path: '/map.json', headers: { Origin: origin } }), 403);
  }
  assertRefused(await send(url, { path: '/events', headers: { Origin: 'https://evil.example' } }), 403);
  assertRefused(await send(url, { method: 'OPTIONS', path: '/expand', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }), 403);
  assert.deepEqual(readRequests(dir).requests, []);

  // The page's own origin, however it reached the server, is fine. No Origin at all is fine too: a GET sends none.
  const directions = ['detail', 'examples', 'compare', 'downsides'];
  const accepted = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, `HTTP://LOCALHOST:${port}`];
  for (const [i, origin] of accepted.entries()) {
    const res = await post(url, { ...DETAIL, direction: directions[i] }, { ...AS_JSON, Origin: origin });
    assert.equal(res.status, 202, origin);
  }
  assert.equal(readRequests(dir).requests.length, 4);
});

test('POST /expand needs a JSON content type', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const body = JSON.stringify(DETAIL);
  // The types a web page can send to another site without asking first, and the other ways of not saying it is JSON.
  const refused = [
    { 'Content-Type': 'text/plain' }, { 'Content-Type': 'text/plain;charset=UTF-8' },
    { 'Content-Type': 'application/x-www-form-urlencoded' }, { 'Content-Type': 'multipart/form-data; boundary=x' },
    { 'Content-Type': 'application/jsonp' }, { 'Content-Type': 'application/json-seq' }, { 'Content-Type': '' }, {},
  ];
  for (const headers of refused) assertRefused(await post(url, body, headers), 415);
  assert.deepEqual(readRequests(dir).requests, []);

  // Parameters and capitals do not matter.
  const accepted = ['application/json', 'application/json; charset=utf-8', 'application/json;charset=UTF-8', 'Application/JSON', ' application/json ; charset=utf-8'];
  const directions = ['detail', 'examples', 'compare', 'downsides', 'refresh'];
  for (const [i, type] of accepted.entries()) {
    const res = await post(url, { ...DETAIL, direction: directions[i] }, { 'Content-Type': type });
    assert.equal(res.status, 202, type);
  }
});

test('POST /expand takes a body of 16 KiB and refuses one byte more', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  assert.equal((await post(url, questionBody(16 * KB))).status, 202);
  assertRefused(await post(url, questionBody(16 * KB + 1)), 413);
  assertRefused(await post(url, questionBody(1024 * KB)), 413); // the rest of a big upload is read and dropped, so the answer still arrives
  // The limit counts bytes, not characters: 6000 Thai characters are 18000 bytes.
  assertRefused(await post(url, JSON.stringify({ ...DETAIL, direction: 'question', question: 'ก'.repeat(6000) })), 413);
  assert.equal(inboxLines(dir).length, 1); // only the first one was queued
  assert.equal((await post(url, DETAIL)).status, 202); // and the server is fine afterwards
});

test('POST /expand holds a body with no Content-Length to the same 16 KiB', async t => {
  // A chunked body has no length to look at before it is read, so the limit has to be counted as the bytes arrive.
  const { dir } = seeded(t);
  const { port } = await start(t, dir);
  const inChunks = text => text.match(/[\s\S]{1,3000}/g); // the bodies are ASCII, so this is 3000 bytes at a time
  const small = JSON.stringify(DETAIL);
  assert.equal((await postChunked(port, [small.slice(0, 10), small.slice(10)])).status, 202); // a small body, in two chunks
  assert.equal((await postChunked(port, inChunks(questionBody(16 * KB)))).status, 202); // exactly 16 KiB is taken
  assertRefused(await postChunked(port, inChunks(questionBody(16 * KB + 1))), 413); // and one byte more is not
  assertRefused(await postChunked(port, inChunks(questionBody(1024 * KB))), 413);
  assert.equal(inboxLines(dir).length, 2); // the small one and the one of exactly 16 KiB
  assert.equal((await postChunked(port, [small])).status, 200); // a chunked body is deduped like any other
  assert.equal((await post(`http://127.0.0.1:${port}`, DETAIL)).status, 200); // and the server answers as before
});

test('a request that dies in the middle of its body does not harm the server', async t => {
  const { dir } = seeded(t);
  const { url, port } = await start(t, dir);
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  const head = ['POST /expand HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Content-Type: application/json', 'Content-Length: 500', '', '{"nodeId":"g-kn'].join(CRLF);
  await new Promise(resolve => socket.write(head, resolve));
  await sleep(50);
  socket.destroy();
  await sleep(100);
  assert.equal((await fetch(`${url}/map.json`)).status, 200);
  assert.equal((await post(url, DETAIL)).status, 202);
  assert.equal(inboxLines(dir).length, 1);
});

// ---- POST /expand ----

test('POST /expand turns away everything inbox.cjs would refuse, with a Thai error', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const bad = [
    ['text that is not JSON', 'not json'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"g-know-1"'],
    ['no nodeId', { direction: 'detail' }],
    ['a nodeId that is not text', { nodeId: 5, direction: 'detail' }],
    ['a nodeId that is a list', { nodeId: ['g-know-1'], direction: 'detail' }],
    ['an empty nodeId', { nodeId: '', direction: 'detail' }],
    ['a nodeId the map does not have', { nodeId: 'g-nowhere', direction: 'detail' }],
    ['a nodeId named like an object key', { nodeId: '__proto__', direction: 'detail' }],
    ['no direction', { nodeId: 'g-know-1' }],
    ['a direction that is not text', { nodeId: 'g-know-1', direction: 3 }],
    ['a direction that is a list', { nodeId: 'g-know-1', direction: ['detail'] }],
    ['an empty direction', { nodeId: 'g-know-1', direction: '' }],
    ['a direction in the wrong case', { nodeId: 'g-know-1', direction: 'Detail' }],
    ['an unknown direction', { nodeId: 'g-know-1', direction: 'sideways' }],
    ['a direction named like an object key', { nodeId: 'g-know-1', direction: 'constructor' }],
    ['a question that is a number', { nodeId: 'g-know-1', direction: 'question', question: 7 }],
    ['a question that is an object', { nodeId: 'g-know-1', direction: 'detail', question: {} }],
    ['a question that is a list', { nodeId: 'g-know-1', direction: 'question', question: ['why'] }],
    ['a question that is true', { nodeId: 'g-know-1', direction: 'detail', question: true }],
    ['direction question and no question', { nodeId: 'g-know-1', direction: 'question' }],
    ['direction question and a null question', { nodeId: 'g-know-1', direction: 'question', question: null }],
    ['direction question and an empty question', { nodeId: 'g-know-1', direction: 'question', question: '' }],
    ['direction question and a blank question', { nodeId: 'g-know-1', direction: 'question', question: ' \t\r\n ' }],
    ['direction question and a question of line separators', { nodeId: 'g-know-1', direction: 'question', question: String.fromCharCode(0x2028, 0x2029) }],
    ['direction question and a question that is only a next-line character', { nodeId: 'g-know-1', direction: 'question', question: NEL }],
  ];
  for (const [what, body] of bad) {
    assertRefused(await post(url, body), 400);
    assert.deepEqual(readRequests(dir).requests, [], what);
  }
  assert.equal(fs.existsSync(inboxFile(dir)), false); // nothing was even opened for writing
});

test('POST /expand keeps only nodeId, direction and the cleaned question', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  // A body can carry anything; the request that is queued is made of the three fields and what appendRequest adds.
  const res = await post(url, { ...DETAIL, id: 'r-forged', at: 'yesterday', status: 'done', evil: '<script>' });
  assert.equal(res.status, 202);
  const [stored] = readRequests(dir).requests;
  assert.deepEqual(Object.keys(stored), ['id', 'nodeId', 'direction', 'at']);
  assert.notEqual(stored.id, 'r-forged');
  assert.equal(res.json().id, stored.id);
  assert.deepEqual(Object.keys(res.json()), ['id']);

  // The question is cleaned as the viewer and the --queue text clean it: one line, no double quote, no semicolon.
  const typed = `  ใช้  "React"; ได้ไหม${CRLF}และมือถือ${NEL}ด้วย  `;
  const asked = await post(url, { nodeId: 'g-know-1', direction: 'question', question: typed });
  assert.equal(asked.status, 202);
  assert.equal(readRequests(dir).requests[1].question, "ใช้ 'React', ได้ไหม และมือถือ ด้วย");

  // A blank question on another direction is no question at all: the request has none, and it is the plain request.
  const blank = await post(url, { nodeId: 'g-know-1', direction: 'examples', question: '  ' });
  assert.equal(blank.status, 202);
  assert.equal('question' in readRequests(dir).requests[2], false);
  const plain = await post(url, { nodeId: 'g-know-1', direction: 'examples' });
  assert.equal(plain.status, 200);
  assert.equal(plain.json().id, blank.json().id);

  // A question on another direction is allowed (the validator and --queue allow it) and is a different request.
  const focused = await post(url, { nodeId: 'g-know-1', direction: 'examples', question: 'เน้นเว็บไทย' });
  assert.equal(focused.status, 202);
  assert.equal(readRequests(dir).requests[3].question, 'เน้นเว็บไทย');
});

test('POST /expand dedupes by node, direction and cleaned question', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const ask = question => post(url, { nodeId: 'g-warn-1', direction: 'question', question });
  const first = await ask('ราคา "เท่าไร"; ต่อเดือน');
  assert.equal(first.status, 202);
  for (const same of ["ราคา 'เท่าไร', ต่อเดือน", '  ราคา   "เท่าไร";\tต่อเดือน\n', 'ราคา "เท่าไร"; ต่อเดือน']) {
    const again = await ask(same);
    assert.equal(again.status, 200, same);
    assert.deepEqual(again.json(), { id: first.json().id, duplicate: true });
  }
  // A different question, direction or node is a different request.
  assert.equal((await ask('ราคาเท่าไร')).status, 202);
  assert.equal((await post(url, { nodeId: 'g-warn-1', direction: 'examples' })).status, 202);
  assert.equal((await post(url, { nodeId: 'g-warn-2', direction: 'examples' })).status, 202);
  assert.equal(inboxLines(dir).length, 4);
});

test('POST /expand dedupes against every map.queue item and the inbox after map.inboxOffset', async t => {
  const queued = (id, status, extra) => ({ id, nodeId: 'g-know-1', direction: 'detail', at: T0.toISOString(), status, ...extra });
  const { dir } = seeded(t, map => {
    map.queue = [
      queued('r-q-pending', 'pending', { nodeId: 'g-do-1' }),
      queued('r-q-researching', 'researching', { nodeId: 'g-do-2' }),
      // A question stored as it was typed (this one never went through the cleaning) matches the cleaned one.
      queued('r-q-typed', 'pending', { nodeId: 'g-do-3', direction: 'question', question: 'a "b"; c' }),
    ];
  });
  const { url } = await start(t, dir);
  for (const [nodeId, id] of [['g-do-1', 'r-q-pending'], ['g-do-2', 'r-q-researching']]) {
    const res = await post(url, { nodeId, direction: 'detail' });
    assert.deepEqual([res.status, res.json()], [200, { id, duplicate: true }], nodeId);
  }
  const typed = await post(url, { nodeId: 'g-do-3', direction: 'question', question: "a 'b', c" });
  assert.deepEqual([typed.status, typed.json()], [200, { id: 'r-q-typed', duplicate: true }]);
  assert.equal(fs.existsSync(inboxFile(dir)), false); // all three were found in the queue, so nothing was appended

  // A request that is in the inbox and not yet taken by the map is waiting too.
  const waiting = appendRequest(dir, { nodeId: 'g-see-1', direction: 'compare' });
  const found = await post(url, { nodeId: 'g-see-1', direction: 'compare' });
  assert.deepEqual([found.status, found.json()], [200, { id: waiting.id, duplicate: true }]);
  assert.equal(inboxLines(dir).length, 1);
});

test('POST /expand does not count inbox lines the map has already taken', async t => {
  // Requests before map.inboxOffset were accepted, and finished since: the same click is a new request.
  const dir = tmpDir(t);
  const old = appendRequest(dir, { nodeId: 'g-know-1', direction: 'detail' });
  const map = createMap({ topic: 'ทดสอบ', slug: 'test-topic', brief: BRIEF, now: T0 });
  map.inboxOffset = fs.statSync(inboxFile(dir)).size;
  saveMap(dir, map, { now: T0 });
  const { url } = await start(t, dir);
  const res = await post(url, DETAIL);
  assert.equal(res.status, 202);
  assert.notEqual(res.json().id, old.id);
  assert.equal(inboxLines(dir).length, 2);
  assert.equal((await post(url, DETAIL)).status, 200); // and now that one is waiting
});

test('POST /expand never appends the same request twice, even when they arrive together', async t => {
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const results = await Promise.all(Array.from({ length: 6 }, () => post(url, DETAIL)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 200, 202]);
  assert.equal(new Set(results.map(r => r.json().id)).size, 1);
  assert.equal(inboxLines(dir).length, 1);
});

test('POST /expand answers 500 when the inbox cannot be read, and the server carries on', async t => {
  // The duplicate check reads the inbox first, so a folder in place of the file stops the request there, before any append.
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const stream = openEvents(t, url);
  await opened(stream);
  fs.mkdirSync(inboxFile(dir)); // a folder where the inbox file should be
  const res = await post(url, DETAIL);
  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.match(res.json().error, THAI);
  assert.equal(typeof res.json().detail, 'string'); // what went wrong, for whoever reads the response
  await sleep(100);
  assert.equal(eventsNamed(stream, 'queued').length, 0); // nothing was queued, so nothing is announced
  assert.equal((await fetch(`${url}/map.json`)).status, 200);

  fs.rmSync(inboxFile(dir), { recursive: true });
  assert.equal((await post(url, DETAIL)).status, 202); // and it recovers once the inbox is there again
});

test('POST /expand answers 500 when the request cannot be appended, and the server carries on', async t => {
  // This one gets past the duplicate check and fails in appendRequest, as a read-only inbox or a full disk would.
  const { dir } = seeded(t);
  const { url } = await start(t, dir);
  const stream = openEvents(t, url);
  await opened(stream);
  const inbox = inboxFile(dir);
  const open = fs.openSync;
  const refuse = t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    if (file === inbox && flags === 'a+') throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
    return open(file, flags, ...rest);
  });
  const appends = () => refuse.mock.calls.filter(call => call.arguments[0] === inbox && call.arguments[1] === 'a+').length;

  const res = await post(url, DETAIL);
  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.match(res.json().error, THAI);
  assert.match(res.json().detail, /EACCES/); // it is the append that failed, not the read before it
  assert.equal(appends(), 1);
  await sleep(100);
  assert.equal(eventsNamed(stream, 'queued').length, 0); // nothing was queued, so nothing is announced
  assert.equal((await fetch(`${url}/map.json`)).status, 200);

  refuse.mock.restore();
  assert.equal((await post(url, DETAIL)).status, 202); // and it recovers once the inbox can be opened again
  assert.equal(inboxLines(dir).length, 1); // with nothing left over from the failed try
});
