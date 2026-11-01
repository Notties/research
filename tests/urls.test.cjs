const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { checkUrls } = require('../scripts/lib/urls.cjs');

// The first test carries the plan's case: a local server where /ok answers 200 and /missing answers 404. The others pin what
// the rulings add: a status for every answer and an error only when none came (timeout, network failure, not a web address),
// redirects followed, at most 5 checks at a time, and a body that is never read. Every server a test starts is closed, with
// its connections, when the test ends, and a test that waits on a server that never answers fails after 30 s instead of
// hanging the run.
const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const answer = (res, status, headers = {}) => { res.writeHead(status, headers); res.end(); };

// The pages most tests ask for.
const PAGES = {
  '/ok': res => answer(res, 200),
  '/missing': res => answer(res, 404),
  '/broken': res => answer(res, 500),
  '/edge-399': res => answer(res, 399), // the last status that counts as ok
  '/edge-400': res => answer(res, 400), // the first that does not
  '/moved': res => answer(res, 302, { Location: '/ok' }),
  '/moved-to-missing': res => answer(res, 301, { Location: '/missing' }),
};

// Starts a local server on a port the system chooses and returns its address, without a slash at the end.
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections(); // the keep-alive connections of the client, or close() would wait for them
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
const pages = (t, routes = PAGES) => serve(t, (req, res) => (routes[req.url] ?? PAGES['/missing'])(res, req));

// A port that nothing listens on: one that was free a moment ago.
async function closedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const source = (id, url) => ({ id, url });

test('checkUrls ok for 200, status for 404', async t => {
  const base = await pages(t);
  const results = await checkUrls([source('s1', `${base}/ok`), source('s2', `${base}/missing`)]);
  assert.deepEqual(results, [
    { id: 's1', url: `${base}/ok`, ok: true, status: 200 },
    { id: 's2', url: `${base}/missing`, ok: false, status: 404 },
  ]);
});

test('checkUrls counts a status below 400 as ok and reports the status of every answer', async t => {
  const base = await pages(t);
  const results = await checkUrls(['/edge-399', '/edge-400', '/broken'].map((p, i) => source(`s${i}`, base + p)));
  assert.deepEqual(results.map(r => [r.ok, r.status, 'error' in r]), [[true, 399, false], [false, 400, false], [false, 500, false]]);
});

test('checkUrls follows redirects and reports the status of the page it ends on', async t => {
  const base = await pages(t);
  const results = await checkUrls([source('s1', `${base}/moved`), source('s2', `${base}/moved-to-missing`)]);
  assert.deepEqual(results.map(r => [r.ok, r.status]), [[true, 200], [false, 404]]);
});

test('checkUrls gives a timeout an error and no status', async t => {
  const base = await serve(t, () => {}); // never answers
  const [result] = await checkUrls([source('s1', `${base}/slow`)], { timeoutMs: 150 });
  assert.deepEqual(Object.keys(result), ['id', 'url', 'ok', 'error']);
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 150 ms/);
});

test('checkUrls gives a refused connection an error and no status', async () => {
  const url = `http://127.0.0.1:${await closedPort()}/`;
  const [result] = await checkUrls([source('s1', url)]);
  assert.deepEqual(Object.keys(result), ['id', 'url', 'ok', 'error']);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.notEqual(result.error, '');
});

test('checkUrls checks only web addresses: data:, ftp:, file:, text that is no address, and a missing url all fail', async () => {
  // fetch itself would answer 200 to a data: address, so it is the guard in checkUrls that fails it.
  const urls = ['data:text/plain,hello', 'ftp://example.com/file', 'file:///c:/windows/win.ini', 'not a url', undefined, 42];
  const results = await checkUrls(urls.map((url, i) => source(`s${i}`, url)));
  assert.deepEqual(results.map(r => r.ok), urls.map(() => false));
  for (const r of results) {
    assert.equal('status' in r, false);
    assert.equal(r.error, 'not an http(s) url');
  }
});

test('checkUrls keeps the order and the ids of its input, whichever answer comes first', async t => {
  const base = await pages(t, {
    '/slow': res => setTimeout(() => answer(res, 200), 250),
    '/fast': res => answer(res, 404),
  });
  const results = await checkUrls([source('first', `${base}/slow`), source('second', `${base}/fast`)]);
  assert.deepEqual(results.map(r => [r.id, r.status]), [['first', 200], ['second', 404]]);
});

test('checkUrls takes the sources of a map, keyed by id, as well as a list', async t => {
  const base = await pages(t);
  const keyed = {
    s1: { id: 's1', url: `${base}/ok`, title: 'หน้าแรก', type: 'official' },
    s2: { url: `${base}/missing` }, // no id of its own: the key names it
  };
  const results = await checkUrls(keyed);
  assert.deepEqual(results, [
    { id: 's1', url: `${base}/ok`, ok: true, status: 200 },
    { id: 's2', url: `${base}/missing`, ok: false, status: 404 },
  ]);
  assert.deepEqual(await checkUrls([]), []);
  assert.deepEqual(await checkUrls({}), []);
});

test('checkUrls checks at most 5 addresses at a time, and does check 5 together', async t => {
  let inFlight = 0;
  let mostInFlight = 0;
  const base = await serve(t, (req, res) => {
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      answer(res, 200);
    }, 150);
  });
  const results = await checkUrls(Array.from({ length: 12 }, (_, i) => source(`s${i}`, `${base}/${i}`)));
  assert.equal(results.length, 12);
  assert.ok(results.every(r => r.ok), 'every page answered 200');
  assert.equal(mostInFlight, 5);
});

test('checkUrls reads only the status: an answer whose body never ends comes back at once, and the connection is dropped', async t => {
  let dropped = false;
  const base = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const timer = setInterval(() => res.write('x'.repeat(1000)), 10);
    res.on('close', () => {
      clearInterval(timer);
      dropped = true;
    });
  });
  const started = Date.now();
  const [result] = await checkUrls([source('s1', `${base}/endless`)], { timeoutMs: 20000 });
  assert.deepEqual(result, { id: 's1', url: `${base}/endless`, ok: true, status: 200 });
  assert.ok(Date.now() - started < 10000, 'did not wait for the body');
  for (let waited = 0; !dropped && waited < 5000; waited += 10) await sleep(10);
  assert.equal(dropped, true, 'the server saw the connection close');
});

test('checkUrls refuses a timeout that is not a number of milliseconds above 0', async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, '10', null]) {
    await assert.rejects(checkUrls([source('s1', 'http://127.0.0.1:1/')], { timeoutMs }), RangeError, `timeoutMs ${String(timeoutMs)}`);
  }
});
