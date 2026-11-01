'use strict';
// Live-mode server: serves the map page from the loopback interface, tells an open page when map.json changes, and takes the
// page's "dig deeper" clicks, which it appends to <dir>/inbox.jsonl for Claude (dr.cjs watch reads them there).
//
//   GET  /              the page, with the last good map in it (renderIndexHtml, live)
//   GET  /map.json      the last good map
//   GET  /events        server-sent events: "map" when a newer map has been loaded, "queued" when a click has been accepted,
//                       and a ping comment now and then so the stream is never silent
//   POST /expand        { nodeId, direction, question? }: 202 { id } when it is queued, 200 { id, duplicate: true } when the
//                       same research is already waiting, 400 when the request is not one
//   GET  /favicon.ico   204: the browser asks for it whatever the page says, and a 404 would put an error in its console
//
// Any other path is 404, a known path with the wrong method 405. Every error body is JSON { error }, one short Thai sentence,
// because the page shows it to the reader. (A 500 adds `detail`, the message of what failed, which the page never shows.)
//
// The map is read at start and again whenever map.json is a different file (see stampOf), polled every 500 ms. What cannot be
// read or parsed, or is not a JSON object, leaves the last good map in place: Claude is allowed to be half way through a write.
// The server does not validate maps, since dr.cjs validates before it saves.
//
// The server answers only requests that look like they came from the page itself. Any website open in the same browser can
// send a request to a loopback port, and a rebinding domain can point its own name at it, so a Host that is not this server
// and an Origin that is not this server are both refused (403) for every request, and POST /expand takes application/json
// only (415), which a web page cannot send to another site without asking first. A body is at most 16 KiB (413). The page is
// sent with headers that forbid framing by any other site, so it cannot be covered up to trick a click (see NO_FRAMING).
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const S = require('../../assets/shared.js');
const C = require('../../assets/viewer-core.js');
const { loadMap, findNode } = require('./map.cjs');
const { appendRequest, readRequests } = require('./inbox.cjs');
const { renderIndexHtml } = require('./render.cjs');

const MAP_FILE = 'map.json';
const POLL_MS = 500;
const PING_MS = 15000;
const IDLE_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1; // the longest delay setTimeout takes: it runs a longer one after 1 ms
const DIRECTION_IDS = S.DIRECTIONS.map(d => d.id);
// The addresses startServer may bind to, each with the name that stands for it in a Host header and in a URL. The server
// answers to all three names, whichever it is bound to, since a browser that is sent to "localhost" says so in its Host.
const LOOPBACK = { '127.0.0.1': '127.0.0.1', localhost: 'localhost', '::1': '[::1]' };
// Sent with the page. No other site may put it in a frame: from there it could lay something over the buttons and get a click on
// a direction out of the reader. The two headers say the same thing, the second for browsers that do not know the first.
const NO_FRAMING = { 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' };

const TEXT = {
  badHost: 'เซิร์ฟเวอร์นี้รับคำขอจากเครื่องนี้เท่านั้น',
  badOrigin: 'ไม่รับคำขอที่มาจากเว็บไซต์อื่น',
  notFound: 'ไม่พบหน้านี้',
  badMethod: 'หน้านี้ไม่รับคำขอแบบนี้',
  notJson: 'ต้องส่งคำขอเป็น application/json',
  tooLarge: 'คำขอใหญ่เกินไป',
  unreadable: 'อ่านคำขอไม่ได้ ต้องเป็น JSON ที่มี nodeId และ direction',
  noNode: 'ไม่พบโหนดนี้ในแผนที่',
  noDirection: 'ไม่รู้จักทิศทางนี้',
  questionNotText: 'คำถามต้องเป็นข้อความ',
  questionBlank: 'พิมพ์คำถามก่อน แล้วกดส่ง', // the sentence the page shows itself when the box is empty
  failed: 'เซิร์ฟเวอร์ทำงานผิดพลาด',
};

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDelay = ms => typeof ms === 'number' && ms >= 1 && ms <= MAX_TIMER_MS;

// An answer that is not a success: thrown anywhere in a handler, turned into the response by fail().
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, value, headers) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), headers);

// Answers a request that went wrong: the HttpError's status and text, or 500 for anything else (a full disk, a bug). The page
// treats every 5xx as "no server". When even the answer cannot be written (the response was half sent) the connection is dropped.
function fail(res, err) {
  try {
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message }, err.headers);
    else sendJson(res, 500, { error: TEXT.failed, detail: String(err?.message ?? err) });
  } catch {
    res.destroy();
  }
}

// One server-sent event. JSON.stringify writes no line break, so the data is always the one line the format wants.
const sseEvent = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

// The media type of a request, in lower case and without parameters: "Application/JSON; charset=utf-8" is "application/json".
const mediaType = req => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

// The body as text. A body over the limit is read to its end but not kept, and then refused: answering while the client is
// still sending would show it a reset connection instead of the answer.
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, TEXT.tooLarge);
  return Buffer.concat(chunks).toString('utf8');
}

// The request that a POST /expand body asks for: { nodeId, direction } and, when there is text, the question as DRCore cleans it.
// Whatever else the body carries is left behind. Everything inbox.cjs would refuse (its requestProblem) is turned away here with
// a 400, so appendRequest can only fail on the file system. A question is blank by cleanQuestion, not by trim: trim keeps U+0085.
function requestFrom(text, map) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, TEXT.unreadable);
  }
  if (!isObj(body)) throw new HttpError(400, TEXT.unreadable);
  const { nodeId, direction, question } = body;
  if (typeof nodeId !== 'string' || findNode(map, nodeId) === null) throw new HttpError(400, TEXT.noNode);
  if (typeof direction !== 'string' || !DIRECTION_IDS.includes(direction)) throw new HttpError(400, TEXT.noDirection);
  if (question != null && typeof question !== 'string') throw new HttpError(400, TEXT.questionNotText);
  const clean = C.cleanQuestion(question);
  if (direction === 'question' && clean === '') throw new HttpError(400, TEXT.questionBlank);
  return clean === '' ? { nodeId, direction } : { nodeId, direction, question: clean };
}

// Which version of a file is on disk: its modification time, size and file id. A save is a rename over the file (saveMap), so
// the id changes with it even on a file system whose clock is too coarse to tell two saves apart. BigInt, since an NTFS file
// id is more than 53 bits.
function stampOf(file) {
  const { mtimeNs, size, ino } = fs.statSync(file, { bigint: true });
  return `${mtimeNs}:${size}:${ino}`;
}

function checkOptions({ dir, host, port, idleMs, pingMs }) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('dir must be the path of the folder that holds map.json');
  if (!Object.hasOwn(LOOPBACK, host)) {
    throw new RangeError(`host must be one of ${Object.keys(LOOPBACK).join(', ')}: the server listens on the loopback interface only`);
  }
  // Not just any value listen takes: a string that is not a number would make it listen on a pipe or a socket file instead.
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be a whole number from 0 to 65535');
  if (port === 80) {
    // A browser leaves the default port out of Host and Origin, and the checks need it there: every request would be refused.
    throw new RangeError('port 80 is not supported: browsers leave the default port out of the Host header, and this server needs to see it');
  }
  if (idleMs !== Infinity && !isDelay(idleMs)) {
    throw new RangeError(`idleMs must be a number of milliseconds from 1 to ${MAX_TIMER_MS}, or Infinity for never`);
  }
  if (!isDelay(pingMs)) throw new RangeError(`pingMs must be a number of milliseconds from 1 to ${MAX_TIMER_MS}`);
}

/**
 * Starts the live-mode server for the folder `dir`, which holds map.json (and receives inbox.jsonl), and resolves once it is
 * listening. It rejects, and never throws or crashes, when an option is wrong, when map.json cannot be loaded as a map, and
 * when the server cannot listen (EADDRINUSE, say). Nothing is left running then.
 * @param {object} options
 * @param {string} options.dir
 * @param {string} [options.host='127.0.0.1'] 127.0.0.1, localhost or ::1: the server listens on the loopback interface only
 * @param {number} [options.port=0] 0 lets the system choose one. Not 80: browsers leave that port out of Host and Origin.
 * @param {number} [options.idleMs=1800000] the server stops itself after this many milliseconds with no POST /expand (that
 *   passes the Host and Origin checks). Infinity never stops it.
 * @param {number} [options.pingMs=15000] how often an open stream is sent a ping comment. A test shortens it.
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, closed: Promise<'idle' | 'closed'> }>}
 *   url is http://127.0.0.1:<port> (with the host as given: localhost, or [::1]), with no slash at the end. close() ends every
 *   open stream and the server and resolves when it has stopped; closing twice is fine. closed resolves, once the server has
 *   stopped, with 'idle' when the idle timer stopped it and 'closed' when close() did, and never rejects.
 */
async function startServer({ dir, host = '127.0.0.1', port = 0, idleMs = IDLE_MS, pingMs = PING_MS } = {}) {
  checkOptions({ dir, host, port, idleMs, pingMs });
  const mapFile = path.join(dir, MAP_FILE);

  // ---- streams ----

  const streams = new Set(); // the responses of the open GET /events requests
  const broadcast = text => {
    for (const res of streams) res.write(text);
  };

  function events(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n'); // at once, so the page's EventSource opens now and not at the first event
    streams.add(res);
    res.on('close', () => streams.delete(res));
  }

  // ---- the map ----

  // The map as loaded, the JSON text /map.json sends, and the stamp of the file it came from. A file that cannot be loaded as a
  // map throws. The stamp is taken before the read, so a save that lands in between is seen again by the next poll.
  function load(stamp) {
    const map = loadMap(dir);
    if (!isObj(map)) throw new Error(`${mapFile} does not hold a map (a JSON object)`);
    return { map, json: JSON.stringify(map), stamp };
  }
  let current = load(stampOf(mapFile));

  // Looks at map.json, and when it is a new file that loads, keeps it and tells the open streams. A file that is missing, that
  // Windows will not let us read this instant (EPERM, EBUSY while Claude renames over it), that is half written or that is not
  // a map changes nothing, and its stamp is not remembered, so the next poll tries it again. It never throws.
  function pollMap() {
    let next;
    try {
      const stamp = stampOf(mapFile);
      if (stamp === current.stamp) return;
      next = load(stamp);
    } catch {
      return;
    }
    current = next;
    broadcast(sseEvent('map', { updatedAt: current.map.updatedAt }));
  }

  // ---- the routes ----

  const page = (req, res) => send(res, 200, 'text/html; charset=utf-8', renderIndexHtml(current.map, { live: true }), NO_FRAMING);
  const mapJson = (req, res) => send(res, 200, 'application/json; charset=utf-8', current.json);
  const favicon = (req, res) => {
    res.writeHead(204);
    res.end();
  };

  // The queue item or the inbox request that already asks for this research. map.queue counts in every status, the inbox only
  // from map.inboxOffset on (what comes before was accepted already). Both sides are compared by DRCore.cleanKey, so a
  // question typed with quotes or extra spaces matches its cleaned copy.
  function findWaiting(request) {
    const key = C.cleanKey(request);
    const same = other => isObj(other) && C.cleanKey(other) === key;
    const { queue, inboxOffset } = current.map;
    return (Array.isArray(queue) ? queue : []).find(same) ?? readRequests(dir, inboxOffset ?? 0).requests.find(same);
  }

  let idleTimer = null; // started once the server is listening; only a POST /expand sets it back
  async function expand(req, res) {
    idleTimer?.refresh(); // a click is what keeps the server open
    if (mediaType(req) !== 'application/json') throw new HttpError(415, TEXT.notJson);
    const text = await readBody(req);
    const request = requestFrom(text, current.map);
    // Nothing waits between the check and the append, so two identical clicks that arrive together cannot both pass it.
    const waiting = findWaiting(request);
    if (waiting) {
      sendJson(res, 200, { id: waiting.id, duplicate: true });
      return;
    }
    const queued = appendRequest(dir, request);
    broadcast(sseEvent('queued', queued));
    sendJson(res, 202, { id: queued.id });
  }

  const routes = [
    { method: 'GET', path: '/', run: page },
    { method: 'GET', path: '/map.json', run: mapJson },
    { method: 'GET', path: '/events', run: events },
    { method: 'GET', path: '/favicon.ico', run: favicon },
    { method: 'POST', path: '/expand', run: expand },
  ];
  const hosts = new Set(); // the Host and Origin headers that name this server: filled in once the port is known
  const origins = new Set();

  async function dispatch(req, res) {
    if (!hosts.has(String(req.headers.host).toLowerCase())) throw new HttpError(403, TEXT.badHost);
    if (req.headers.origin !== undefined && !origins.has(req.headers.origin.toLowerCase())) throw new HttpError(403, TEXT.badOrigin);
    const pathname = req.url.split('?')[0];
    const here = routes.filter(route => route.path === pathname);
    if (here.length === 0) throw new HttpError(404, TEXT.notFound);
    const route = here.find(r => r.method === req.method);
    if (!route) throw new HttpError(405, TEXT.badMethod, { Allow: here.map(r => r.method).join(', ') });
    await route.run(req, res);
  }

  const server = http.createServer((req, res) => {
    dispatch(req, res).catch(err => fail(res, err));
  });

  // ---- stopping ----

  let pollTimer;
  let pingTimer;
  let stopping = null;
  let settle;
  const closed = new Promise(resolve => { settle = resolve; });

  // Stops everything the server started, once: the first reason is the one `closed` gets. Resolves when the port is free.
  function stop(reason) {
    stopping ??= new Promise(resolve => {
      clearInterval(pollTimer);
      clearInterval(pingTimer);
      clearTimeout(idleTimer);
      for (const res of streams) res.end();
      streams.clear();
      server.close(() => { // it can only complain that the server is not running, which is what we want
        settle(reason);
        resolve();
      });
      server.closeAllConnections(); // also the idle keep-alive ones and a request still being sent, or close() would wait for them
    });
    return stopping;
  }

  // ---- listening ----

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // From here on the only 'error' the server emits is a failed accept (EMFILE: too many open files, say). With nothing listening it
  // is thrown out of the event loop and ends the process, and the page goes offline; this way one connection is lost and the rest
  // are served.
  server.on('error', err => process.stderr.write(`live server: ${err.code ?? err.name}: ${err.message}\n`));
  const bound = server.address().port;
  for (const name of Object.values(LOOPBACK)) {
    hosts.add(`${name}:${bound}`);
    origins.add(`http://${name}:${bound}`);
  }
  // The timers start only now, so a server that could not listen leaves none behind.
  pollTimer = setInterval(pollMap, POLL_MS);
  pingTimer = setInterval(() => broadcast(': ping\n\n'), pingMs);
  if (idleMs !== Infinity) idleTimer = setTimeout(() => stop('idle'), idleMs);

  return { url: `http://${LOOPBACK[host]}:${bound}`, port: bound, close: () => stop('closed'), closed };
}

module.exports = { startServer };
