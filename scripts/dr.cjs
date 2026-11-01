'use strict';
// dr: the command-line tool a research topic is driven with. SKILL.md has Claude run it as
//   node "<skill_dir>/scripts/dr.cjs" <command> ...
// and every change to a topic's map.json goes through it. Each command ends with one JSON line on stdout, and that line is
// the whole contract:
//   success  exit 0  the result, such as {"dir":"C:\\_research\\my-topic"}
//   failure  exit 1  {"error":"what is wrong"}, with details beside it when there are some: "errors" (what validateMap found)
//                    or "failed" (the sources that did not answer). A usage mistake, a refusal and a crash all end this way.
// Only serve and watch keep running. They print one line per event, each with a "type", and then end like any other command.
//
//   init           {"dir"}                                     render        {"rendered"}: the path of index.html
//   validate       {"ok":true}                                 merge         {"added"}: the new node ids
//   mark-checked   {"changed"}: how many nodes moved on        check-urls    {"ok":true,"checked"}
//   accept         {"accepted":[queue items],"skipped":[{"request","reason"}]}
//   start          {"started": the queue item}                 finish        {"finished": the item id}
//   enqueue        {"appended":[requests],"skipped":[{"request","reason"}]}
//   serve          {"type":"server-started","url"} ... {"type":"server-stopped","reason":"idle"|"closed"}
//   watch          {"type":"expand", ...the request} for each request ... {"type":"idle"}
//
// Writing: the commands that write a topic (init, render, merge, mark-checked, accept, start, finish) take the lock file
// map.json.lock first. Without it two of them could load the map, change it and save it at the same moment, and one would
// lose the other's changes. The others (validate, check-urls, enqueue, serve, watch) only read, or only append to inbox.jsonl.
// Anything else that writes map.json, an edit by hand say, does not take the lock, so it must not overlap one of these commands.
// Failing: a request that cannot be met (usage, validation, a node that is not there) prints only its error line. A bug or an
// I/O failure also writes its stack to stderr, which SKILL.md shows when serve or watch ends with a non-zero exit.
// Ending: nothing here calls process.exit. A command sets process.exitCode and lets the event loop drain, because stdout may be
// a pipe and Monitor, which reads that pipe, must get every line before the process goes.
const fs = require('node:fs');
const path = require('node:path');
const S = require('../assets/shared.js');
const C = require('../assets/viewer-core.js');
const {
  createMap, loadMap, saveMap, findNode, mergeFragment, markChecked, acceptRequests, startItem, finishItem,
} = require('./lib/map.cjs');
const { validateMap } = require('./lib/validate.cjs');
const { appendRequest, readRequests, watchInbox } = require('./lib/inbox.cjs');
const { writeIndexHtml } = require('./lib/render.cjs');
const { startServer } = require('./lib/server.cjs');
const { checkUrls } = require('./lib/urls.cjs');

const MAP_FILE = 'map.json';
const INBOX_FILE = 'inbox.jsonl';
const LOCK_FILE = 'map.json.lock';
const DEFAULT_ROOT = 'C:\\_research';
const DEFAULT_PORT = 7357;
const PORTS_TRIED = 11; // the port asked for, and the 10 after it
const DEFAULT_IDLE_MINUTES = 30;
const MAX_SLUG_LENGTH = 64;
const DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/; // Windows cannot make a folder with one of these names
const DIRECTION_IDS = S.DIRECTIONS.map(d => d.id);
const MS_PER_MINUTE = 60000;

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const stripBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// ---- output and failure ----

// A failure that is the caller's to fix: the message says all there is to say, so no stack is printed. `details` go into the
// error line beside the message.
class CliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}
// Whether a failure is a refusal, which needs no stack: a CliError, or the plain Error that map.cjs and inbox.cjs throw to refuse
// input (an unknown node, an unknown cite, an unknown queue item). A TypeError, a RangeError or an error with a system code
// (ENOENT) is a bug or an I/O failure, and keeps its stack.
const isRefusal = err => err instanceof CliError || (err?.constructor === Error && err.code === undefined);

// U+2028 and U+2029 are legal inside a JSON string, but some readers cut a line at them. They are written as escapes, so that one
// result is one line whatever reads it. Built from code points, so that this file holds no invisible character.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/** Every line dr.cjs writes to stdout goes through here. */
function emit(value) {
  const line = JSON.stringify(value).replace(LINE_SEPARATORS, ch => `\\u${ch.charCodeAt(0).toString(16)}`);
  process.stdout.write(`${line}\n`);
}

let reported = false;
function fail(err) {
  process.exitCode = 1;
  if (reported) return; // one error line per run, even if a second failure follows the first
  reported = true;
  emit({ error: String(err?.message ?? err), ...(err instanceof CliError ? err.details : {}) });
  if (!isRefusal(err)) process.stderr.write(`${err?.stack ?? err}\n`);
}

// ---- arguments ----

// The words after the command name, as { args, options }. An option is "--name value", "--name=value" or, for a flag, "--name".
// A value is the next word whatever it looks like ("-" stands for stdin), unless that word is another option of this command,
// in which case the value is missing.
function parseArgs(words, command) {
  const problem = text => new CliError(`${text} (usage: ${command.usage})`);
  const known = name => command.values.includes(name) || command.flags.includes(name);
  const args = [];
  const options = {};
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.startsWith('--')) {
      args.push(word);
      continue;
    }
    const eq = word.indexOf('=');
    const name = word.slice(2, eq === -1 ? undefined : eq);
    if (!known(name)) throw problem(`unknown option --${name}`);
    if (Object.hasOwn(options, name)) throw problem(`--${name} given twice`);
    if (command.flags.includes(name)) {
      if (eq !== -1) throw problem(`--${name} takes no value`);
      options[name] = true;
      continue;
    }
    const value = eq === -1 ? words[++i] : word.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--') && known(value.slice(2).split('=')[0]))) {
      throw problem(`--${name} needs a value`);
    }
    options[name] = value;
  }
  if (args.length < command.args.length) throw problem(`missing <${command.args[args.length]}>`);
  if (args.length > command.args.length) throw problem(`unexpected argument "${args[command.args.length]}"`);
  for (const name of command.required) if (!Object.hasOwn(options, name)) throw problem(`--${name} is required`);
  return { args, options };
}

// "30", "0.5" and ".5" are minutes. The fractions are what lets a test wait a few seconds.
function idleMinutes(options) {
  const text = options['idle-minutes'];
  if (text === undefined) return DEFAULT_IDLE_MINUTES;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || Number(text) === 0) {
    throw new CliError('--idle-minutes must be a number above 0, such as 30 or 0.5');
  }
  return Number(text);
}

// ---- files, the lock and the map ----

// A JSON file the caller names, a brief or a fragment. A UTF-8 BOM, which a Windows editor may put in front, is dropped.
function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${what} ${file}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(stripBom(text));
  } catch (err) {
    throw new CliError(`${what} ${file} is not valid JSON: ${err.message}`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** The map in <dir>/map.json. A missing folder or file, and a file that is not a map, are failures with a message to match. */
function loadTopic(dir) {
  let map;
  try {
    map = loadMap(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new CliError(`no map.json in ${dir}`);
    if (err instanceof SyntaxError) throw new CliError(`map.json in ${dir} is not valid JSON: ${err.message}`);
    throw err;
  }
  if (!isObj(map)) throw new CliError(`map.json in ${dir} does not hold a map (a JSON object)`);
  return map;
}

const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;
// Why a lock cannot be taken right now: it exists (EEXIST), or Windows is in the middle of deleting it (EPERM, EACCES, EBUSY).
const LOCK_BUSY = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'];
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // a synchronous sleep

// How old the lock file is. A lock that is gone counts as new: the next try finds out.
function lockAgeMs(lock) {
  try {
    return Date.now() - fs.statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Runs `work` while this process holds <dir>/map.json.lock. The lock is a file made with the flag "wx", which fails when the
 * file exists, so only one process at a time can make it. A process that finds it taken tries again every 50 ms for up to 10 s,
 * and a lock older than 30 s is one a crashed command left behind: it is broken. The lock is released when `work` ends, however
 * it ends. All of this is synchronous, so nothing else in this process runs while the lock is held.
 */
function withLock(dir, work) {
  const lock = path.join(dir, LOCK_FILE);
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new CliError(`no map.json in ${dir}`);
      if (!LOCK_BUSY.includes(err.code)) throw err;
      if (lockAgeMs(lock) > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() >= giveUp) {
        if (!fs.existsSync(lock)) throw err; // nobody holds a lock: the folder is the problem (a permission, say), and err says how
        let holder = '';
        try { holder = ` (pid ${fs.readFileSync(lock, 'utf8').trim()})`; } catch { /* it was released at this moment */ }
        throw new CliError(
          `${LOCK_FILE} in ${dir} is held by another dr.cjs command${holder} and did not come free in ${LOCK_WAIT_MS / 1000} s; `
          + `try again shortly: a lock that a crashed command left behind is broken after ${LOCK_STALE_MS / 1000} s`,
        );
      }
      pause(LOCK_RETRY_MS);
    }
  }
  try {
    return work();
  } finally {
    fs.rmSync(lock, { force: true, maxRetries: 5, retryDelay: 20 });
  }
}

/** Saves the map, which stamps updatedAt, and writes the file-mode page from it. */
function saveAndRender(dir, map) {
  saveMap(dir, map);
  writeIndexHtml(dir, map, { live: false });
}

/** Loads the map under the lock, lets `change` edit it and return the result, then saves and renders. Nothing is saved when `change` throws. */
const update = (dir, change) => withLock(dir, () => {
  const map = loadTopic(dir);
  const result = change(map);
  saveAndRender(dir, map);
  return result;
});

// ---- the commands ----

const COMMANDS = {};
// usage is the line shown with a usage error. spec lists the positional args by name, the options that take a value (values) or
// none (flags), and the options that must be given (required).
function define(name, usage, spec, run) {
  COMMANDS[name] = { usage, args: [], values: [], flags: [], required: [], ...spec, run };
}

// init

function checkSlug(slug) {
  if (!S.SLUG_RE.test(slug)) throw new CliError('slug must be lowercase letters and digits joined by single hyphens, like my-topic');
  if (slug.length > MAX_SLUG_LENGTH) throw new CliError(`slug "${slug}" is longer than ${MAX_SLUG_LENGTH} characters`);
  if (DEVICE_NAMES.test(slug)) throw new CliError(`slug "${slug}" is a Windows device name, which cannot be a folder name`);
}

define(
  'init',
  'init --slug <slug> --brief <file.json> [--topic <topic>] [--root <dir>] [--force]',
  { values: ['topic', 'slug', 'brief', 'root'], flags: ['force'], required: ['slug', 'brief'] },
  (_, { slug, brief: briefFile, topic: topicOption, root = DEFAULT_ROOT, force = false }) => {
    if (root.trim() === '') throw new CliError('--root must not be empty (an empty path would put the topic in the current folder)');
    checkSlug(slug);
    const brief = readJson(briefFile, 'brief file');
    if (!isObj(brief)) throw new CliError('the brief file must hold a JSON object');
    const topic = topicOption ?? brief.topic;
    if (typeof topic !== 'string') throw new CliError('no topic: pass --topic, or put "topic" in the brief file');
    const map = createMap({ topic: topic.trim(), slug, brief });
    const check = validateMap(map);
    if (!check.ok) throw new CliError('the topic and brief do not make a valid map', { errors: check.errors });

    // Nothing is made on disk before this point, so a refused init leaves nothing behind.
    const dir = path.join(path.resolve(root), slug);
    fs.mkdirSync(path.join(dir, 'fragments'), { recursive: true });
    withLock(dir, () => {
      if (!force && fs.existsSync(path.join(dir, MAP_FILE))) {
        throw new CliError(`map.json already exists in ${dir}; pass --force to start the topic over (that also empties inbox.jsonl)`);
      }
      saveMap(dir, map);
      writeIndexHtml(dir, map, { live: false });
      fs.writeFileSync(path.join(dir, INBOX_FILE), ''); // a new map at offset 0 would take every old inbox line for new
    });
    return { dir };
  },
);

// render, validate, merge, mark-checked, check-urls

define('render', 'render <dir>', { args: ['dir'] }, ([dir]) => withLock(dir, () => ({
  rendered: writeIndexHtml(dir, loadTopic(dir), { live: false }),
})));

define('validate', 'validate <dir>', { args: ['dir'] }, ([dir]) => {
  const { ok, errors } = validateMap(loadTopic(dir));
  if (!ok) throw new CliError('map.json is invalid', { errors });
  return { ok: true };
});

define(
  'merge',
  'merge <dir> --parent <id> --fragment <file.json>',
  { args: ['dir'], values: ['parent', 'fragment'], required: ['parent', 'fragment'] },
  ([dir], { parent, fragment }) => {
    const data = readJson(fragment, 'fragment file');
    return update(dir, map => {
      const { added } = mergeFragment(map, parent, data);
      const { ok, errors } = validateMap(map);
      if (!ok) throw new CliError('the merged map does not validate, so nothing was saved', { errors });
      return { added };
    });
  },
);

define('mark-checked', 'mark-checked <dir>', { args: ['dir'] }, ([dir]) => update(dir, map => ({ changed: markChecked(map) })));

define('check-urls', 'check-urls <dir>', { args: ['dir'] }, async ([dir]) => {
  const results = await checkUrls(loadTopic(dir).sources ?? {});
  const failed = results.filter(result => !result.ok);
  if (failed.length > 0) throw new CliError(`${failed.length} of ${results.length} sources are not ok`, { checked: results.length, failed });
  return { ok: true, checked: results.length };
});

// accept

const unknownNode = id => `unknown node "${id}"`;

// Why a request from the inbox must not be queued, or null. map.cjs finds a queue item by its id, and validate.cjs rejects a
// queue item for a node that is not there, an unknown direction, or a "question" with no text, so a request like that would
// block every later merge. A question is blank by C.cleanQuestion, not by trim, which keeps U+0085.
function refusalFor(map, request) {
  if (typeof request.id !== 'string' || request.id === '') return 'request has no id';
  if (findNode(map, request.nodeId) === null) return unknownNode(request.nodeId);
  if (!DIRECTION_IDS.includes(request.direction)) return `unknown direction "${request.direction}"`;
  if (request.direction === 'question' && C.cleanQuestion(request.question) === '') return 'a "question" request needs question text';
  return null;
}

// The request with its question in the one canonical text (C.cleanQuestion), and without a blank one. The server and enqueue
// write it clean already, so this only changes a line typed by hand.
function canonical(request) {
  const question = C.cleanQuestion(request.question);
  if (question === '') {
    const { question: blank, ...rest } = request;
    return rest;
  }
  return { ...request, question }; // in place, so the key keeps its position
}

define('accept', 'accept <dir>', { args: ['dir'] }, ([dir]) => withLock(dir, () => {
  const map = loadTopic(dir);
  const from = map.inboxOffset ?? 0;
  const { requests, offset } = readRequests(dir, from);
  const accepted = [];
  const skipped = [];
  for (const request of requests) {
    const reason = refusalFor(map, request);
    if (reason !== null) {
      skipped.push({ request, reason });
      continue;
    }
    const [item] = acceptRequests(map, [canonical(request)]); // one at a time, so a duplicate is known by name
    if (item) accepted.push(item);
    else skipped.push({ request, reason: 'already in the queue' });
  }
  // Skipped requests are passed over too: left behind the offset, they would be read again by every accept.
  if (offset !== from) {
    map.inboxOffset = offset;
    saveAndRender(dir, map);
  }
  return { accepted, skipped };
}));

// start, finish, enqueue

define('start', 'start <dir> <itemId>', { args: ['dir', 'itemId'] }, ([dir, itemId]) => update(dir, map => ({ started: startItem(map, itemId) })));

define('finish', 'finish <dir> <itemId>', { args: ['dir', 'itemId'] }, ([dir, itemId]) => update(dir, map => {
  finishItem(map, itemId);
  return { finished: itemId };
}));

define(
  'enqueue',
  'enqueue <dir> --queue <"nodeId:direction[:question]; ..." | ->',
  { args: ['dir'], values: ['queue'], required: ['queue'] },
  async ([dir], { queue }) => {
    const map = loadTopic(dir);
    // parseQueue rejects the whole string before anything is appended. "-" reads the string from stdin, so that a question never
    // has to pass through a double-quoted shell argument, where $ and backticks would be expanded.
    const items = C.parseQueue(stripBom(queue === '-' ? await readStdin() : queue));
    if (items.length === 0) throw new CliError('the queue is empty: give items like "g-know-1:detail; g-warn-1:question:How much?"');
    const appended = [];
    const skipped = [];
    for (const item of items) {
      if (findNode(map, item.nodeId) === null) skipped.push({ request: item, reason: unknownNode(item.nodeId) });
      else appended.push(appendRequest(dir, item));
    }
    return { appended, skipped };
  },
);

// serve and watch

let shutdown = () => {}; // what a command that keeps running must undo for the process to end after a failure

// Starts the live server on the first free port from `port` on: that port and the 10 after it, moving on only when one is in use.
// An option the server refuses (port 80, an idle time out of range) is a failure of its own, not a reason to try the next port.
async function startOnFreePort(dir, port, idleMs) {
  const ports = [port];
  if (port !== 0) for (let next = port + 1; next < port + PORTS_TRIED && next <= 65535; next++) ports.push(next);
  for (const candidate of ports) {
    try {
      return await startServer({ dir, port: candidate, idleMs });
    } catch (err) {
      if (err.code === 'EADDRINUSE') continue;
      if (err instanceof RangeError) throw new CliError(err.message);
      throw err;
    }
  }
  throw new CliError(ports.length === 1 ? `port ${ports[0]} is in use` : `ports ${ports[0]}-${ports.at(-1)} are all in use`);
}

define(
  'serve',
  `serve <dir> [--port ${DEFAULT_PORT}] [--idle-minutes ${DEFAULT_IDLE_MINUTES}]`,
  { args: ['dir'], values: ['port', 'idle-minutes'] },
  async ([dir], options) => {
    if (options.port !== undefined && !/^\d+$/.test(options.port)) throw new CliError(`--port must be a whole number, such as ${DEFAULT_PORT}`);
    const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
    const idleMs = idleMinutes(options) * MS_PER_MINUTE;
    loadTopic(dir); // a clear message for a missing or broken map.json, before any port is tried
    const server = await startOnFreePort(dir, port, idleMs);
    shutdown = () => server.close();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    emit({ type: 'server-started', url: server.url });
    emit({ type: 'server-stopped', reason: await server.closed });
  },
);

define('watch', `watch <dir> [--idle-minutes ${DEFAULT_IDLE_MINUTES}]`, { args: ['dir'], values: ['idle-minutes'] }, ([dir], options) => {
  const idleMs = idleMinutes(options) * MS_PER_MINUTE;
  const map = loadTopic(dir);
  // A fifth of the idle window, between 20 ms and the 1 s default, so that a short window (a test's) is polled several times.
  const pollMs = Math.min(1000, Math.max(20, idleMs / 5));
  const watcher = watchInbox(dir, {
    offset: map.inboxOffset ?? 0,
    pollMs,
    idleMs,
    onRequest: request => {
      const { type, ...fields } = request; // a line typed by hand may have a "type" of its own, which must not pass for the event's
      emit({ type: 'expand', ...fields });
    },
    onIdle: () => emit({ type: 'idle' }),
  });
  // watchInbox throws from its timer when the inbox cannot be read, so that an unattended watch fails loudly. That reaches the
  // uncaughtException handler below, which stops the watch and prints the error line.
  shutdown = watcher.stop;
});

// ---- main ----

async function main(words) {
  const [name, ...rest] = words;
  if (name === undefined || !Object.hasOwn(COMMANDS, name)) {
    const names = Object.keys(COMMANDS).join(', ');
    throw new CliError(name === undefined ? `no command given (use one of: ${names})` : `unknown command "${name}" (use one of: ${names})`);
  }
  const command = COMMANDS[name];
  const { args, options } = parseArgs(rest, command);
  if (command.args[0] === 'dir') args[0] = path.resolve(args[0]);
  const result = await command.run(args, options);
  if (result !== undefined) emit(result);
}

process.stdout.on('error', () => {}); // a reader that went away (EPIPE) is nobody to report to
process.on('uncaughtException', err => {
  try {
    shutdown();
  } catch { /* the failure being reported is the one that matters */ }
  fail(err);
});
main(process.argv.slice(2)).catch(fail);
