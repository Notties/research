'use strict';
// Inbox: how a click on the map reaches Claude. The live server (and the enqueue command) append one request per line
// to <dir>/inbox.jsonl. The accept and watch commands read the lines back from a byte offset, which the map keeps in
// map.inboxOffset, so a request is read once. A request is { id, nodeId, direction, question?, at }.
//
// The file is only ever appended to, and a request goes out in one write, so a reader sees finished lines and, at the
// very end, perhaps a line that is still being written. readRequests leaves that last line alone until its newline is
// there. Nothing here checks that nodeId names a node or that direction is a known one: the server checks before it
// appends, and accept checks against the map before it queues. What a request looks like is one rule, requestProblem:
// appendRequest enforces it and readRequests applies it to every line it reads.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const INBOX_FILE = 'inbox.jsonl';
const NEWLINE = 0x0a;
const MAX_TIMER_MS = 2 ** 31 - 1; // the longest delay setTimeout takes. It turns a longer one, or one under 1, into 1 ms.

const need = (ok, message) => { if (!ok) throw new Error(message); };
const needInRange = (ok, message) => { if (!ok) throw new RangeError(message); };
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = v => Number.isSafeInteger(v) && v >= 0;

// What is wrong with `request` as a request, or null when nothing is. A request is an object whose nodeId and direction
// are non-empty strings and whose question is absent, null or a string. Extra fields are left alone.
function requestProblem(request) {
  if (!isObj(request)) return 'request must be an object';
  if (typeof request.nodeId !== 'string' || request.nodeId === '') return 'nodeId must be a non-empty string';
  if (typeof request.direction !== 'string' || request.direction === '') return 'direction must be a non-empty string';
  if (request.question != null && typeof request.question !== 'string') return 'question must be a string';
  return null;
}

// r-<time in base 36>-<4 random base 36 characters>. randomInt is uniform, and padStart keeps the suffix at 4 characters.
const newId = now => `r-${now.toString(36)}-${crypto.randomInt(36 ** 4).toString(36).padStart(4, '0')}`;

// True when the open file has content and its last byte is not a newline.
function endsMidLine(fd) {
  const { size } = fs.fstatSync(fd);
  if (size === 0) return false;
  const last = Buffer.alloc(1);
  fs.readSync(fd, last, 0, 1, size - 1);
  return last[0] !== NEWLINE;
}

/**
 * Appends one request, as a single JSON line, to <dir>/inbox.jsonl, and returns it. The file is created if it is
 * missing, but the folder is not. question is left out of the request unless one is given. Anything that is not a
 * request (see requestProblem), including a second argument that is not an object, throws an Error that says what is
 * wrong, and writes nothing.
 * @param {string} dir
 * @param {{ nodeId: string, direction: string, question?: string | null }} request
 * @returns {{ id: string, nodeId: string, direction: string, question?: string, at: string }}
 */
function appendRequest(dir, input) {
  const problem = requestProblem(input);
  need(problem === null, problem);
  const { nodeId, direction, question } = input;
  const now = Date.now();
  const request = { id: newId(now), nodeId, direction };
  if (question != null) request.question = question;
  request.at = new Date(now).toISOString();

  const fd = fs.openSync(path.join(dir, INBOX_FILE), 'a+');
  try {
    // A file that ends mid-line (a writer died part way through it) would swallow this request into the broken line.
    // Starting a new line keeps the request whole, and the broken line is skipped when the file is read.
    const line = `${endsMidLine(fd) ? '\n' : ''}${JSON.stringify(request)}\n`;
    fs.appendFileSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  return request;
}

// The bytes of the open file after `offset`, as the file is now, and the position they start at: `offset` itself, or 0
// when the file is shorter than that. Fewer bytes than there should be if the file shrinks while it is read. A file that
// is not a regular file (a folder, say) is refused here, the same way on every platform: Windows opens a folder fine and
// reports its size as 0, so without the check it would read as an empty inbox for ever.
function readFrom(fd, offset, file) {
  const stat = fs.fstatSync(fd);
  need(stat.isFile(), `${file} is not a regular file`);
  const from = offset > stat.size ? 0 : offset;
  const length = stat.size - from;
  const bytes = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const n = fs.readSync(fd, bytes, filled, length - filled, from + filled);
    if (n === 0) break;
    filled += n;
  }
  return { bytes: bytes.subarray(0, filled), from };
}

/**
 * Reads the requests that were appended at or after byte `offset` and returns them with the offset to read from next.
 * - Only complete lines count. A last line without its newline yet is left unread, and the returned offset stays in
 *   front of it, so the next read delivers it whole.
 * - The offset is a count of bytes (a Thai character is 3 of them), the same number fs.statSync(file).size reports.
 * - Blank lines, lines that are not JSON, and JSON that is not a request (see requestProblem) are skipped. They are
 *   still passed over, because a bad line that held the offset back would block every line after it.
 * - A missing file (or folder) reads as empty, and the offset comes back unchanged. So it does when the offset is the
 *   size of the file: nothing is new.
 * - An offset beyond the end of the file means the inbox was truncated or replaced, since it is otherwise only appended
 *   to. Reading then restarts at byte 0, like tail -F, and the offset it returns counts from there. (A replacement at
 *   least as long as the old offset cannot be told from growth. And a restart can deliver requests that were read
 *   before, if someone truncated the file by hand.)
 * - Any other read error is thrown, and so is an inbox that is not a regular file, such as a folder named inbox.jsonl.
 * @param {string} dir
 * @param {number} [offset=0]
 * @returns {{ requests: object[], offset: number }}
 */
function readRequests(dir, offset = 0) {
  need(isCount(offset), 'offset must be a non-negative integer');
  const file = path.join(dir, INBOX_FILE);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { requests: [], offset };
    throw err;
  }
  let read;
  try {
    read = readFrom(fd, offset, file);
  } finally {
    fs.closeSync(fd);
  }
  const { bytes, from } = read;

  // The lines are cut out of the bytes, not out of decoded text. A newline byte never occurs inside a multi-byte UTF-8
  // character, so no cut splits one, and the offset stays a count of bytes.
  const end = bytes.lastIndexOf(NEWLINE) + 1; // 0 when there is no newline at all
  const requests = [];
  for (let start = 0; start < end;) {
    const stop = bytes.indexOf(NEWLINE, start);
    const text = bytes.toString('utf8', start, stop).trim(); // trim drops the CR of a CRLF and a BOM at the file start
    start = stop + 1;
    if (text === '') continue;
    let request;
    try { request = JSON.parse(text); } catch { continue; }
    if (requestProblem(request) === null) requests.push(request);
  }
  return { requests, offset: from + end };
}

/**
 * Polls the inbox and calls onRequest(request) for each new request, in the order they were written. When idleMs
 * passes with no new request it calls onIdle() once and stops. The idle window starts when the watch does and starts
 * again after every request. A poll always runs before idle is declared, so a request that is waiting is never lost
 * to it.
 * - The first poll comes right after this call returns, not after pollMs, so requests that are already in the file are
 *   reported at once. No callback runs before watchInbox has returned.
 * - A missing inbox is fine: it reads as empty until the file appears. An inbox that is truncated or replaced by a
 *   shorter file while the watch runs is read again from byte 0 (see readRequests).
 * - pollMs is used as given, anything from 1 to 2**31 - 1. Near the end of the idle window the next poll is brought
 *   forward to the deadline, so an idleMs shorter than pollMs is still met. idleMs is above 0, and Infinity means the
 *   watch never goes idle. Anything else throws a RangeError, before a timer has started.
 * - A read error other than a missing file is thrown from the timer callback, so an unattended watch fails loudly
 *   instead of sitting silent. So is an error thrown by onRequest. Either one ends the process, and onIdle does not run.
 * - The watch keeps its place in memory only. The caller stores the offset (accept does), so a request that was
 *   reported but not accepted is reported again by the next watch.
 * @param {string} dir
 * @param {{ offset?: number, pollMs?: number, idleMs?: number, onRequest: (request: object) => void, onIdle?: () => void }} options
 * @returns {{ stop(): void }} stop() ends the watch. It can be called any time, any number of times, from a callback too.
 *   After it no callback runs, onIdle included.
 */
function watchInbox(dir, { offset = 0, pollMs = 1000, idleMs = 1800000, onRequest, onIdle } = {}) {
  need(isCount(offset), 'offset must be a non-negative integer');
  needInRange(Number.isFinite(pollMs) && pollMs >= 1 && pollMs <= MAX_TIMER_MS, `pollMs must be a number of milliseconds from 1 to ${MAX_TIMER_MS}`);
  needInRange(typeof idleMs === 'number' && idleMs > 0, 'idleMs must be a number of milliseconds above 0 (Infinity: never idle)');
  need(typeof onRequest === 'function', 'onRequest must be a function');
  need(onIdle == null || typeof onIdle === 'function', 'onIdle must be a function');

  let stopped = false;
  let timer;
  let quietSince = performance.now(); // a monotonic clock: an adjusted system clock cannot cut or stretch the idle window
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };

  const poll = () => {
    if (stopped) return;
    const batch = readRequests(dir, offset);
    offset = batch.offset;
    for (const request of batch.requests) {
      if (stopped) return; // an earlier onRequest called stop(), so the rest of the batch is dropped
      onRequest(request);
    }
    if (batch.requests.length > 0) quietSince = performance.now();
    if (stopped) return;
    const left = quietSince + idleMs - performance.now();
    if (left <= 0) {
      stop();
      onIdle?.();
      return;
    }
    timer = setTimeout(poll, Math.min(pollMs, Math.ceil(left)));
  };
  timer = setTimeout(poll, 0);
  return { stop };
}

module.exports = { appendRequest, readRequests, watchInbox };
