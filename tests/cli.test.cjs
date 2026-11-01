const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { validateMap } = require('../scripts/lib/validate.cjs');
const { findNode } = require('../scripts/lib/map.cjs');
const { appendRequest } = require('../scripts/lib/inbox.cjs');

// The seven tests that carry the plan's names come from the plan. The others pin what the rulings and the dispatch notes add:
// the one JSON line every command prints and the exit codes SKILL.md reads, the lock around every write to a topic, what accept,
// enqueue and synthesize refuse, the inbox offset, and how serve and watch start, move on, idle and fail. Every command runs as a child
// process of this one (process.execPath), and every test has its own temp --root under os.tmpdir(), so nothing here touches
// C:\_research. A child that keeps running (serve, watch) is killed when its test ends, whether it passed or not. Every child has
// a time limit and every test waits at most a minute, so a hang fails the run instead of freezing it.
const test = (name, fn) => nodeTest(name, { timeout: 60000 }, fn);

const DR = path.join(__dirname, '..', 'scripts', 'dr.cjs');
const BRIEF = { goal: 'สร้างงาน', level: 'ไม่รู้เลย', focus: '', exclude: '', depth: 'standard', constraints: '' };
const NOW = '2026-11-01T10:00:00.000Z';
const LS = String.fromCharCode(0x2028); // line separator
const PS = String.fromCharCode(0x2029); // paragraph separator
const NEL = String.fromCharCode(0x85); // next line: not white space to String.prototype.trim
const BOM = String.fromCharCode(0xfeff);
const TOPIC_FILES = ['fragments', 'inbox.jsonl', 'index.html', 'map.json']; // what a topic folder holds when no command is running

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waits until check() is truthy and returns what it returned. The limits are generous: only a broken command reaches one.
async function waitFor(check, what, ms = 15000) {
  const deadline = Date.now() + ms;
  for (let value = check(); !value; value = check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(10);
  }
  return check();
}

// ---- running dr.cjs ----

const parseLine = line => { try { return JSON.parse(line); } catch { return { unparsable: line }; } };
// What a finished command left: its exit status, the text on both streams, stdout cut into parsed lines, and `json`, the one
// line that almost every command prints (reading it fails the test when there is not exactly one).
function outcome(status, stdout, stderr) {
  const lines = stdout.split('\n').filter(line => line !== '').map(parseLine);
  return {
    status,
    stdout,
    stderr,
    lines,
    get json() {
      assert.equal(lines.length, 1, `expected one stdout line, got ${lines.length}: ${stdout}${stderr}`);
      return lines[0];
    },
  };
}
// Runs a command to its end. This test process waits meanwhile, so it is for commands that need nothing from it.
function dr(args, { input, cwd } = {}) {
  const run = spawnSync(process.execPath, [DR, ...args], { encoding: 'utf8', input, cwd, timeout: 60000, killSignal: 'SIGKILL' });
  assert.equal(run.error, undefined, `dr.cjs ${args[0]} did not finish: ${run.error}`);
  return outcome(run.status, run.stdout, run.stderr);
}
// The same, without blocking this process: for a command that talks to a server in this process (check-urls) and for commands
// that run side by side. nodeArgs go to node before the script (--require, say), env is added to the environment of the child.
function drAsync(args, { input, nodeArgs = [], env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, DR, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, timeout: 60000, killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      if (status === null) reject(new Error(`dr.cjs ${args[0]} was killed (${signal})`));
      else resolve(outcome(status, stdout, stderr));
    });
    child.stdin.end(input);
  });
}
// Starts a command that keeps running and collects what it prints as it goes: `lines` (parsed), `raw` (the text), `stderr`, and
// `exit`, a promise of { code, signal }. next(match) waits for a line that satisfies `match`. nodeArgs and env as for drAsync.
function spawnDr(t, args, { nodeArgs = [], env } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, DR, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, timeout: 60000, killSignal: 'SIGKILL',
  });
  const run = { raw: '', stderr: '', lines: [], exited: false };
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk;
    for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      run.raw += `${line}\n`;
      run.lines.push(parseLine(line));
    }
  });
  child.stderr.on('data', chunk => { run.stderr += chunk; });
  run.exit = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => {
      run.exited = true;
      resolve({ code, signal });
    });
  });
  // The line that satisfies `match`. A command that ends first fails the wait at once, with what it printed.
  run.next = async (match, what) => {
    await waitFor(() => run.lines.find(match) ?? run.exited, what);
    const line = run.lines.find(match);
    assert.ok(line, `dr.cjs ended before it printed ${what}: ${run.raw}${run.stderr}`);
    return line;
  };
  t.after(async () => {
    child.kill();
    await run.exit;
  });
  return run;
}
const isStarted = line => line.type === 'server-started';

// ---- topics ----

function writeBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
// JSON as a file, with a UTF-8 BOM in front when a Windows editor would have put one there.
const writeJson = (file, value, { bom = false } = {}) => writeBytes(file, `${bom ? BOM : ''}${JSON.stringify(value)}`);

// A temp folder that holds the brief and a --root of its own for one test. Nothing exists under root until init makes it.
function workspace(t, { slug = 'test-topic', topic = 'ทดสอบ', brief = BRIEF } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-cli-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const root = path.join(work, 'root');
  return { work, root, slug, topic, briefFile: writeJson(path.join(work, 'brief.json'), brief), dir: path.join(root, slug) };
}
const initArgs = (w, extra = []) => ['init', '--topic', w.topic, '--slug', w.slug, '--brief', w.briefFile, '--root', w.root, ...extra];
function initialized(t, options) {
  const w = workspace(t, options);
  const run = dr(initArgs(w));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return w;
}
const inFolder = (dir, name) => path.join(dir, name);
const readMap = dir => JSON.parse(fs.readFileSync(inFolder(dir, 'map.json'), 'utf8'));
const writeMap = (dir, map) => fs.writeFileSync(inFolder(dir, 'map.json'), `${JSON.stringify(map, null, 2)}\n`);
const readPage = dir => fs.readFileSync(inFolder(dir, 'index.html'), 'utf8');
const bytesOf = (dir, name) => fs.readFileSync(inFolder(dir, name));
const listing = dir => fs.readdirSync(dir).sort();
const addToInbox = (dir, ...requests) => fs.appendFileSync(inFolder(dir, 'inbox.jsonl'), requests.map(r => `${JSON.stringify(r)}\n`).join(''));
const request = extra => ({ id: 'r-1', nodeId: 'g-know-1', direction: 'detail', at: NOW, ...extra });

// A fragment: two sources, a key point on the parent that both of them back, and two children.
const source = (url, extra) => ({ url, title: `หน้า ${url}`, type: 'official', accessedAt: '2026-11-01', ...extra });
const point = (cites, extra) => ({ text: 'ข้อเท็จจริง', type: 'fact', cites, ...extra });
const item = (title, cites, extra) => ({
  title, summary: `สรุป ${title}`, points: [point(cites)], confidence: 'high', confidenceReason: 'แหล่งตรงกัน', ...extra,
});
const fragment = extra => ({
  sources: { a: source('https://example.com/a'), b: source('https://example.org/b') },
  self: { summary: 'สรุปภาพรวม', points: [point(['a', 'b'], { key: true })], confidence: 'high', confidenceReason: 'สองแหล่งตรงกัน' },
  children: [item('หัวข้อแรก', ['a']), item('หัวข้อที่สอง', ['b'])],
  ...extra,
});
const mergeArgs = (w, file, parent = 'g-know-1') => ['merge', w.dir, '--parent', parent, '--fragment', file];

// ---- init ----

test('init creates files and refuses overwrite', t => {
  const w = workspace(t);
  const first = dr(initArgs(w));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(first.json, { dir: w.dir });
  for (const file of ['map.json', 'index.html']) assert.ok(fs.existsSync(inFolder(w.dir, file)), `${file} exists`);

  const before = bytesOf(w.dir, 'map.json');
  const second = dr(initArgs(w));
  assert.equal(second.status, 1);
  assert.match(second.json.error, /map\.json already exists.*--force/);
  assert.equal(second.stderr, '');
  assert.ok(bytesOf(w.dir, 'map.json').equals(before), 'map.json is untouched');
});

test('init writes a valid map, a file-mode page, an empty inbox and fragments/, and leaves nothing else behind', t => {
  const w = initialized(t);
  const map = readMap(w.dir);
  assert.deepEqual(validateMap(map), { ok: true, errors: [] });
  assert.equal(map.topic, 'ทดสอบ');
  assert.equal(map.slug, 'test-topic');
  assert.deepEqual(map.brief, BRIEF);
  assert.equal(map.inboxOffset, 0);
  assert.deepEqual(map.queue, []);
  assert.match(readPage(w.dir), /<html lang="th" data-mode="file">/);
  assert.ok(readPage(w.dir).includes('id="map-data"'));
  assert.equal(bytesOf(w.dir, 'inbox.jsonl').length, 0);
  assert.ok(fs.statSync(inFolder(w.dir, 'fragments')).isDirectory());
  assert.deepEqual(listing(w.dir), TOPIC_FILES); // no lock file and no temp file
});

test('init --force starts the topic over: a new map, an empty inbox, offset 0, and the fragments stay', t => {
  const w = initialized(t);
  writeBytes(inFolder(w.dir, 'fragments/keep.json'), '{}');
  dr(['enqueue', w.dir, '--queue', 'g-know-1:detail']);
  assert.equal(dr(['accept', w.dir]).json.accepted.length, 1);
  assert.ok(readMap(w.dir).inboxOffset > 0);
  dr(['enqueue', w.dir, '--queue', 'g-know-2:examples']); // a line the old map never accepted

  const forced = dr(initArgs(w, ['--force']));
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  const map = readMap(w.dir);
  assert.equal(map.inboxOffset, 0);
  assert.deepEqual(map.queue, []);
  assert.equal(bytesOf(w.dir, 'inbox.jsonl').length, 0);
  assert.ok(fs.existsSync(inFolder(w.dir, 'fragments/keep.json')));
  assert.deepEqual(dr(['accept', w.dir]).json, { accepted: [], skipped: [] }); // the old lines are gone
});

test('init empties an inbox left in the folder even without --force, since a new map makes its lines stale', t => {
  const w = workspace(t);
  writeBytes(inFolder(w.dir, 'inbox.jsonl'), `${JSON.stringify(request())}\n`); // a folder with an inbox, and no map.json
  const run = dr(initArgs(w));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(bytesOf(w.dir, 'inbox.jsonl').length, 0);
  assert.deepEqual(dr(['accept', w.dir]).json, { accepted: [], skipped: [] });
});

test('relative paths are taken from the folder the command runs in, and the tool works from any folder', t => {
  const w = workspace(t);
  const run = dr(['init', '--topic', w.topic, '--slug', w.slug, '--brief', 'brief.json', '--root', 'root'], { cwd: w.work });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(run.json, { dir: w.dir }); // an absolute path, though the root was given relative
  const rel = path.relative(w.work, w.dir);
  assert.equal(dr(['validate', rel], { cwd: w.work }).status, 0);
  assert.deepEqual(dr(['render', rel], { cwd: w.work }).json, { rendered: inFolder(w.dir, 'index.html') }); // absolute, too
  const file = writeJson(path.join(w.work, 'fragment.json'), fragment());
  const merged = dr(['merge', rel, '--parent', 'g-know-1', '--fragment', 'fragment.json'], { cwd: w.work });
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.ok(fs.existsSync(file));
  assert.ok(readPage(w.dir).includes('หัวข้อแรก'), 'the page was rendered, so the assets were found from here');
});

test('init takes the topic from --topic, or from the brief file when --topic is absent', t => {
  const w = workspace(t, { brief: { ...BRIEF, topic: 'หัวข้อจากไฟล์' } });
  const fromBrief = dr(['init', '--slug', w.slug, '--brief', w.briefFile, '--root', w.root]);
  assert.equal(fromBrief.status, 0, fromBrief.stdout + fromBrief.stderr);
  assert.equal(readMap(w.dir).topic, 'หัวข้อจากไฟล์');

  const option = dr(initArgs(w, ['--force'])); // carries --topic ทดสอบ
  assert.equal(option.status, 0, option.stdout + option.stderr);
  assert.equal(readMap(w.dir).topic, 'ทดสอบ');

  const bare = workspace(t);
  const none = dr(['init', '--slug', bare.slug, '--brief', bare.briefFile, '--root', bare.root]);
  assert.equal(none.status, 1);
  assert.match(none.json.error, /no topic.*--topic/);
  assert.equal(none.stderr, '');
  assert.equal(fs.existsSync(bare.root), false, 'nothing was created');
});

test('init refuses a slug that is no safe folder name, and creates nothing', t => {
  const w = workspace(t);
  const bad = ['Bad-Slug', 'has space', 'a_b', '-x', 'x-', 'a--b', '', '../escape', 'con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9', 'a'.repeat(65)];
  for (const slug of bad) {
    const run = dr(['init', '--topic', 't', '--slug', slug, '--brief', w.briefFile, '--root', w.root]);
    assert.equal(run.status, 1, `slug "${slug}" was accepted`);
    assert.match(run.json.error, /slug/);
    assert.equal(run.stderr, '');
  }
  assert.equal(fs.existsSync(w.root), false, 'nothing was created');
  // The edges that are fine: 64 characters, and names that only start like a device name.
  for (const slug of ['a'.repeat(64), 'console', 'com10', 'lpt0', 'nul-1']) {
    const run = dr(['init', '--topic', 't', '--slug', slug, '--brief', w.briefFile, '--root', w.root]);
    assert.equal(run.status, 0, `slug "${slug}": ${run.stdout}`);
  }
});

test('init refuses an empty --root instead of making the topic in the current folder', t => {
  const w = workspace(t);
  for (const root of ['', '   ']) {
    const run = dr(['init', '--topic', 't', '--slug', w.slug, '--brief', w.briefFile, '--root', root], { cwd: w.work });
    assert.equal(run.status, 1, `root "${root}" was accepted`);
    assert.match(run.json.error, /--root must not be empty/);
    assert.equal(run.stderr, '');
  }
  assert.deepEqual(fs.readdirSync(w.work), ['brief.json'], 'nothing was made next to the brief');
});

test('init refuses a brief that does not make a valid map, and names what is wrong', t => {
  const w = workspace(t, { brief: { ...BRIEF, depth: 'huge' } });
  const run = dr(initArgs(w));
  assert.equal(run.status, 1);
  assert.match(run.json.error, /valid map/);
  assert.deepEqual(run.json.errors, ['brief.depth: must be one of quick, standard, deep']);
  assert.equal(run.stderr, '');
  assert.equal(fs.existsSync(w.root), false, 'nothing was created');
});

test('init refuses a brief file that is missing, is not JSON, or is not an object, and reads one with a BOM', t => {
  const w = workspace(t);
  fs.rmSync(w.briefFile);
  const missing = dr(initArgs(w));
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /cannot read brief file .*ENOENT/);

  fs.writeFileSync(w.briefFile, '{not json');
  const broken = dr(initArgs(w));
  assert.equal(broken.status, 1);
  assert.match(broken.json.error, /brief file .* is not valid JSON/);

  for (const text of ['[1, 2]', '"text"', 'null']) {
    fs.writeFileSync(w.briefFile, text);
    const notObject = dr(initArgs(w));
    assert.equal(notObject.status, 1, text);
    assert.match(notObject.json.error, /must hold a JSON object/);
  }
  for (const run of [missing, broken]) assert.equal(run.stderr, '');
  assert.equal(fs.existsSync(w.root), false, 'nothing was created');

  writeJson(w.briefFile, BRIEF, { bom: true });
  const bom = dr(initArgs(w));
  assert.equal(bom.status, 0, bom.stdout + bom.stderr);
  assert.deepEqual(readMap(w.dir).brief, BRIEF);
});

// ---- render and validate ----

test('render rewrites the file-mode page from map.json', t => {
  const w = initialized(t);
  fs.rmSync(inFolder(w.dir, 'index.html'));
  const first = dr(['render', w.dir]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(first.json, { rendered: inFolder(w.dir, 'index.html') });
  assert.match(readPage(w.dir), /data-mode="file"/);

  const map = readMap(w.dir);
  map.topic = 'หัวข้อที่แก้ด้วยมือ';
  writeMap(w.dir, map);
  assert.equal(dr(['render', w.dir]).status, 0);
  assert.ok(readPage(w.dir).includes('หัวข้อที่แก้ด้วยมือ'));
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

test('validate exit codes', t => {
  const w = initialized(t);
  const fresh = dr(['validate', w.dir]);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.deepEqual(fresh.json, { ok: true });

  const map = readMap(w.dir);
  findNode(map, 'g-know-1').points = [{ text: 'ข้อเท็จจริง', type: 'fact', cites: ['s9'] }];
  writeMap(w.dir, map);
  const broken = dr(['validate', w.dir]);
  assert.equal(broken.status, 1);
  assert.equal(broken.json.error, 'map.json is invalid');
  assert.deepEqual(broken.json.errors, ['root.children[0].children[0].points[0].cites[0]: unknown source "s9"']);
  assert.equal(broken.stderr, '');
});

test('every command that reads a topic reports a folder with no usable map.json', t => {
  const w = workspace(t);
  const file = writeJson(path.join(w.work, 'fragment.json'), fragment());
  const synthesisFile = writeJson(path.join(w.work, 'synthesis.json'), { rootSummary: 'สรุป' });
  const commands = [
    ['validate'], ['render'], ['mark-checked'], ['accept'], ['check-urls'], ['start', 'r-1'], ['finish', 'r-1'], ['watch'], ['serve'],
    ['enqueue', '--queue', 'g-know-1:detail'], ['merge', '--parent', 'g-know-1', '--fragment', file], ['synthesize', '--file', synthesisFile],
  ];
  const run = (dir, [name, ...rest]) => dr([name, dir, ...rest]);

  const nowhere = path.join(w.work, 'nowhere');
  for (const command of commands) {
    const result = run(nowhere, command);
    assert.equal(result.status, 1, command[0]);
    assert.match(result.json.error, /^no map\.json in /, command[0]);
    assert.equal(result.stderr, '', command[0]);
  }
  assert.equal(fs.existsSync(nowhere), false, 'no command made the folder');

  fs.mkdirSync(w.dir, { recursive: true });
  for (const [text, message] of [['{"topic": ', /not valid JSON/], ['null', /does not hold a map/], ['[]', /does not hold a map/]]) {
    fs.writeFileSync(inFolder(w.dir, 'map.json'), text);
    for (const command of [['validate'], ['render'], ['accept']]) {
      const result = run(w.dir, command);
      assert.equal(result.status, 1, `${command[0]} on ${text}`);
      assert.match(result.json.error, message);
      assert.equal(result.stderr, '');
    }
  }
  assert.deepEqual(listing(w.dir), ['map.json']); // not even a lock file is left behind
});

// ---- merge and mark-checked ----

test('merge happy path', t => {
  const w = initialized(t);
  const file = writeJson(path.join(w.work, 'fragment.json'), fragment());
  const run = dr(mergeArgs(w, file));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.json.added.length, 2);
  assert.deepEqual(run.json, { added: ['g-know-1-1', 'g-know-1-2'] });

  const map = readMap(w.dir);
  assert.deepEqual(validateMap(map), { ok: true, errors: [] });
  assert.deepEqual(Object.keys(map.sources), ['s1', 's2']);
  const parent = findNode(map, 'g-know-1');
  assert.equal(parent.status, 'checking');
  assert.equal(parent.summary, 'สรุปภาพรวม');
  assert.deepEqual(parent.children.map(c => [c.id, c.title, c.status]), [['g-know-1-1', 'หัวข้อแรก', 'checking'], ['g-know-1-2', 'หัวข้อที่สอง', 'checking']]);
  // The page was rendered from the map that was saved.
  assert.ok(readPage(w.dir).includes('หัวข้อที่สอง'));
  assert.ok(readPage(w.dir).includes(map.updatedAt));
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

test('merge with unknown cite', t => {
  const w = initialized(t);
  const file = writeJson(path.join(w.work, 'fragment.json'), fragment({ children: [item('หัวข้อ', ['a']), item('หัวข้อเสีย', ['zzz'])] }));
  const [mapBefore, pageBefore] = [bytesOf(w.dir, 'map.json'), bytesOf(w.dir, 'index.html')];
  const run = dr(mergeArgs(w, file));
  assert.equal(run.status, 1);
  assert.match(run.json.error, /unknown cite "zzz"/);
  assert.equal(run.stderr, '', 'a refusal prints no stack');
  assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore), 'map.json is byte-identical');
  assert.ok(bytesOf(w.dir, 'index.html').equals(pageBefore), 'index.html is byte-identical');
  assert.deepEqual(listing(w.dir), TOPIC_FILES, 'the lock was released and no temp file is left');
});

test('merge refuses a fragment that would make the map invalid, lists the errors, and saves nothing', t => {
  const w = initialized(t);
  // A key point backed by one source: mergeFragment takes it, validateMap does not.
  const weak = item('หัวข้อ', ['a'], { points: [point(['a'], { key: true })] });
  const file = writeJson(path.join(w.work, 'fragment.json'), fragment({ children: [weak] }));
  const mapBefore = bytesOf(w.dir, 'map.json');
  const run = dr(mergeArgs(w, file));
  assert.equal(run.status, 1);
  assert.match(run.json.error, /does not validate.*nothing was saved/);
  assert.deepEqual(run.json.errors, ['root.children[0].children[0].children[0].points[0]: key point needs 2 sources or singleSource']);
  assert.equal(run.stderr, '');
  assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore));
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

test('merge reports an unknown parent, a missing fragment file and a fragment that is not JSON', t => {
  const w = initialized(t);
  const file = writeJson(path.join(w.work, 'fragment.json'), fragment());
  const mapBefore = bytesOf(w.dir, 'map.json');
  const cases = [
    [mergeArgs(w, file, 'nope'), /unknown node "nope"/],
    [mergeArgs(w, path.join(w.work, 'absent.json')), /cannot read fragment file .*ENOENT/],
    [mergeArgs(w, writeBytes(path.join(w.work, 'broken.json'), '{"sources": ')), /fragment file .* is not valid JSON/],
    [mergeArgs(w, writeJson(path.join(w.work, 'array.json'), [1])), /fragment must be an object/],
  ];
  for (const [args, message] of cases) {
    const run = dr(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.json.error, message);
    assert.equal(run.stderr, '');
  }
  assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore));
});

test('merge reads a fragment file that starts with a UTF-8 BOM', t => {
  const w = initialized(t);
  const file = writeJson(path.join(w.work, 'fragment.json'), fragment(), { bom: true });
  const run = dr(mergeArgs(w, file));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.json.added.length, 2);
});

test('merge renders a page that still loads when the research text holds </script>, <!-- and U+2028', t => {
  const w = initialized(t);
  const nasty = `ทดสอบ </script><script>boom()</script> <!-- ไม่ปิด a${LS}b`;
  const self = { summary: nasty, points: [point(['a', 'b'], { key: true, text: nasty })], confidence: 'high', confidenceReason: 'สองแหล่งตรงกัน' };
  const run = dr(mergeArgs(w, writeJson(path.join(w.work, 'fragment.json'), fragment({ self }))));
  assert.equal(run.status, 0, run.stdout + run.stderr);

  const page = readPage(w.dir);
  assert.equal(page.split('id="map-data"').length, 2, 'one data element');
  const data = /<script type="application\/json" id="map-data">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(data, 'the data element is closed by its own end tag, not by one in the text');
  assert.deepEqual(JSON.parse(data[1]), readMap(w.dir), 'the page carries exactly the map that was saved');
  assert.equal(findNode(readMap(w.dir), 'g-know-1').summary, nasty);
});

test('mark-checked turns checking nodes into done (with children) or frontier (without), and re-renders', t => {
  const w = initialized(t);
  assert.equal(dr(mergeArgs(w, writeJson(path.join(w.work, 'fragment.json'), fragment()))).status, 0);
  const run = dr(['mark-checked', w.dir]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(run.json, { changed: 3 });
  const map = readMap(w.dir);
  assert.deepEqual(['g-know-1', 'g-know-1-1', 'g-know-1-2'].map(id => findNode(map, id).status), ['done', 'frontier', 'frontier']);
  assert.ok(readPage(w.dir).includes('"status":"frontier"'), 'the page shows the new statuses');
  assert.deepEqual(dr(['mark-checked', w.dir]).json, { changed: 0 });
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

// ---- synthesize ----

// A topic with research in it: the fragment merged under g-know-1 and then checked, so that g-know-1 is done and its two children
// are frontier. A merge with a `self` would turn them back into checking, and that is what synthesize must not do.
function researched(t) {
  const w = initialized(t);
  assert.equal(dr(mergeArgs(w, writeJson(path.join(w.work, 'fragment.json'), fragment()))).status, 0);
  assert.equal(dr(['mark-checked', w.dir]).status, 0);
  return w;
}
// What Claude writes when the research is done: every key the command takes. Two sources back the first finding, and the second
// says that one is all it has.
const synthesis = extra => ({
  summary: {
    findings: [
      { text: 'ข้อค้นพบแรก สองแหล่งยืนยัน', cites: ['s1', 's2'] },
      { text: 'ข้อค้นพบที่สอง มีแหล่งเดียว', cites: ['s1'], singleSource: true },
    ],
    startTomorrow: ['เริ่มอย่างแรก', 'เริ่มอย่างที่สอง', 'เริ่มอย่างที่สาม'],
  },
  readingPath: ['g-know-1', 'g-know-1-2', 'g-know-1-1'],
  forYou: { 'g-know-1': 'สำหรับคุณ: เริ่มจากภาพรวม', 'g-know-1-2': 'สำหรับคุณ: ข้อนี้ตรงกับเป้าหมาย' },
  rootSummary: 'สรุปทั้งแผนที่ในสองประโยค',
  ...extra,
});
const synthesize = (w, data, options) => dr(['synthesize', w.dir, '--file', writeJson(path.join(w.work, 'synthesis.json'), data, options)]);
const RESEARCHED_NODES = ['g-know-1', 'g-know-1-1', 'g-know-1-2'];

test('synthesize sets the summary, the reading path, forYou and the root summary, and changes nothing else', t => {
  const w = researched(t);
  const before = readMap(w.dir);
  const pageBefore = readPage(w.dir);
  const data = synthesis();
  const run = synthesize(w, data);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(run.json, { updated: ['summary', 'readingPath', 'forYou', 'rootSummary'] });

  const after = readMap(w.dir);
  assert.deepEqual(after.summary, data.summary);
  assert.deepEqual(after.readingPath, data.readingPath);
  assert.equal(after.root.summary, data.rootSummary);
  assert.equal(findNode(after, 'g-know-1').forYou, data.forYou['g-know-1']);
  assert.equal(findNode(after, 'g-know-1-2').forYou, data.forYou['g-know-1-2']);
  assert.equal('forYou' in findNode(after, 'g-know-1-1'), false, 'a node that is not named gets none');

  // The map is the old one with those fields set and updatedAt stamped: no other node and no other field moved.
  const expected = structuredClone(before);
  Object.assign(expected, { summary: data.summary, readingPath: data.readingPath, updatedAt: after.updatedAt });
  expected.root.summary = data.rootSummary;
  for (const [id, text] of Object.entries(data.forYou)) findNode(expected, id).forYou = text;
  assert.deepEqual(after, expected);
  // The two fields a merge with a `self` would have moved on the nodes it names, said out loud.
  assert.deepEqual(RESEARCHED_NODES.map(id => findNode(after, id).status), ['done', 'frontier', 'frontier']);
  assert.deepEqual(
    RESEARCHED_NODES.map(id => findNode(after, id).researchedAt),
    RESEARCHED_NODES.map(id => findNode(before, id).researchedAt),
  );
  assert.ok(findNode(before, 'g-know-1').researchedAt, 'there was a time to keep');
  assert.deepEqual(validateMap(after), { ok: true, errors: [] });

  // The page was written again, from the saved map.
  const page = readPage(w.dir);
  assert.notEqual(page, pageBefore);
  assert.ok(page.includes(data.rootSummary) && page.includes(data.summary.findings[0].text) && page.includes(after.updatedAt));
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

test('synthesize applies only the keys it is given, lists them in a fixed order, and replaces a key as a whole', t => {
  const w = researched(t);
  assert.equal(synthesize(w, synthesis()).status, 0);
  const full = readMap(w.dir);

  // Two keys, written in the other order. The others stay, and what is given replaces what was there.
  const some = synthesize(w, { rootSummary: 'สรุปใหม่', readingPath: ['g-know-1'] });
  assert.deepEqual(some.json, { updated: ['readingPath', 'rootSummary'] });
  let map = readMap(w.dir);
  assert.deepEqual(map.readingPath, ['g-know-1'], 'the old path was replaced, not added to');
  assert.equal(map.root.summary, 'สรุปใหม่');
  assert.deepEqual(map.summary, full.summary);
  assert.equal(findNode(map, 'g-know-1-2').forYou, findNode(full, 'g-know-1-2').forYou);

  // A summary replaces the old one as a whole: no finding of the old one is left.
  const summary = { findings: [], startTomorrow: ['เริ่มพรุ่งนี้'] };
  assert.deepEqual(synthesize(w, { summary }).json, { updated: ['summary'] });
  assert.deepEqual(readMap(w.dir).summary, summary);

  // forYou sets the nodes it names, in place of what they had, and leaves the others' text.
  assert.deepEqual(synthesize(w, { forYou: { 'g-know-1-1': 'ใหม่', 'g-know-1': 'แก้แล้ว' } }).json, { updated: ['forYou'] });
  map = readMap(w.dir);
  assert.deepEqual(
    RESEARCHED_NODES.map(id => findNode(map, id).forYou),
    ['แก้แล้ว', 'ใหม่', synthesis().forYou['g-know-1-2']],
  );

  // A forYou that names no node names nothing and changes nothing, though it is still listed as applied.
  assert.deepEqual(synthesize(w, { forYou: {} }).json, { updated: ['forYou'] });
  const after = readMap(w.dir);
  assert.deepEqual(after, { ...map, updatedAt: after.updatedAt });
});

test('synthesize refuses a file it cannot apply, with one error line, and leaves map.json and index.html byte-identical', t => {
  const w = researched(t);
  const [mapBefore, pageBefore] = [bytesOf(w.dir, 'map.json'), bytesOf(w.dir, 'index.html')];
  const cases = [
    ['a list', ['summary'], /^the synthesis file must hold a JSON object$/],
    ['a string', 'summary', /^the synthesis file must hold a JSON object$/],
    ['null', null, /^the synthesis file must hold a JSON object$/],
    ['an empty object', {}, /^the synthesis file is empty: give at least one of summary, readingPath, forYou, rootSummary$/],
    ['an unknown key', synthesis({ findings: [] }), /^unknown key "findings" in the synthesis file \(use summary, readingPath, forYou, rootSummary\)$/],
    ['two unknown keys', { a: 1, rootSummary: 'x', b: 2 }, /^unknown keys "a", "b" in the synthesis file/],
    ['unknown nodes in forYou', synthesis({ forYou: { 'g-know-1': 'ok', nope: 'x', alsoNope: 'y' } }), /^forYou: unknown node "nope", unknown node "alsoNope"$/],
    ['a forYou that is no object', synthesis({ forYou: ['g-know-1'] }), /^forYou must be an object of node id to text$/],
    ['a forYou text that is no text', synthesis({ forYou: { 'g-know-1': 5 } }), /^forYou "g-know-1" must be non-empty text$/],
    ['a forYou text that is blank', synthesis({ forYou: { 'g-know-1': ' \n ' } }), /^forYou "g-know-1" must be non-empty text$/],
    ['a root summary that is no text', synthesis({ rootSummary: ['x'] }), /^rootSummary must be non-empty text$/],
    ['a root summary that is blank', synthesis({ rootSummary: '   ' }), /^rootSummary must be non-empty text$/],
  ];
  for (const [what, data, message] of cases) {
    const run = synthesize(w, data);
    assert.equal(run.status, 1, `${what} was accepted: ${run.stdout}`);
    assert.deepEqual(Object.keys(run.json), ['error'], what);
    assert.match(run.json.error, message, what);
    assert.equal(run.stderr, '', what);
    assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore), `${what}: map.json changed`);
    assert.ok(bytesOf(w.dir, 'index.html').equals(pageBefore), `${what}: index.html changed`);
  }
  assert.deepEqual(listing(w.dir), TOPIC_FILES, 'the lock was released and no temp file is left');
});

test('synthesize runs the validator on the result: what it finds is listed in errors, and nothing is saved', t => {
  const w = researched(t);
  const [mapBefore, pageBefore] = [bytesOf(w.dir, 'map.json'), bytesOf(w.dir, 'index.html')];
  const finding = cites => ({ text: 'ข้อค้นพบ', cites });
  const cases = [
    [{ readingPath: ['g-know-1', 'zzz'] }, 'readingPath[1]: unknown node "zzz"'],
    [{ readingPath: 'g-know-1' }, 'readingPath: must be an array'],
    [{ summary: 'text' }, 'summary: must be an object with findings and startTomorrow'],
    [{ summary: { findings: [] } }, 'summary.startTomorrow: must be an array'],
    [{ summary: { findings: [finding(['s1'])], startTomorrow: [] } }, 'summary.findings[0]: finding needs 2 sources or singleSource'],
    [{ summary: { findings: [finding(['s9', 's1'])], startTomorrow: [] } }, 'summary.findings[0].cites[0]: unknown source "s9"'],
    [{ summary: { findings: Array.from({ length: 6 }, () => finding(['s1', 's2'])), startTomorrow: [] } }, 'summary.findings: at most 5 items (got 6)'],
    [{ summary: { findings: [], startTomorrow: ['a', 'b', 'c', 'd'] } }, 'summary.startTomorrow: at most 3 items (got 4)'],
  ];
  for (const [data, expected] of cases) {
    const run = synthesize(w, data);
    assert.equal(run.status, 1, `${expected}: ${run.stdout}`);
    assert.match(run.json.error, /does not validate.*nothing was saved/);
    assert.deepEqual(run.json.errors, [expected]);
    assert.equal(run.stderr, '');
    assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore), `${expected}: map.json changed`);
    assert.ok(bytesOf(w.dir, 'index.html').equals(pageBefore), `${expected}: index.html changed`);
  }
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

test('synthesize reads a file that starts with a UTF-8 BOM, and reports a file it cannot read', t => {
  const w = researched(t);
  const bom = synthesize(w, { rootSummary: 'สรุปจากไฟล์ที่มี BOM' }, { bom: true });
  assert.equal(bom.status, 0, bom.stdout + bom.stderr);
  assert.equal(readMap(w.dir).root.summary, 'สรุปจากไฟล์ที่มี BOM');

  const mapBefore = bytesOf(w.dir, 'map.json');
  const absent = dr(['synthesize', w.dir, '--file', path.join(w.work, 'absent.json')]);
  assert.equal(absent.status, 1);
  assert.match(absent.json.error, /cannot read synthesis file .*ENOENT/);
  const broken = dr(['synthesize', w.dir, '--file', writeBytes(path.join(w.work, 'broken.json'), '{"summary": ')]);
  assert.equal(broken.status, 1);
  assert.match(broken.json.error, /synthesis file .* is not valid JSON/);
  for (const run of [absent, broken]) assert.equal(run.stderr, '');
  assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore));
});

// ---- check-urls ----

// A local server that answers 200 on the path /ok and 404 on every other path, closed when the test ends.
async function site(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(new URL(req.url, 'http://localhost').pathname === '/ok' ? 200 : 404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
const withSources = (w, urls) => {
  const map = readMap(w.dir);
  map.sources = Object.fromEntries(urls.map((url, i) => [`s${i + 1}`, { id: `s${i + 1}`, ...source(url) }]));
  writeMap(w.dir, map);
};

test('check-urls fails on dead source', async t => {
  const base = await site(t);
  const w = initialized(t);
  withSources(w, [`${base}/ok`, `${base}/missing`]);
  const run = await drAsync(['check-urls', w.dir]); // async: the server being asked lives in this process
  assert.equal(run.status, 1);
  assert.equal(run.json.error, '1 of 2 sources are not ok');
  assert.equal(run.json.checked, 2);
  assert.deepEqual(run.json.failed, [{ id: 's2', url: `${base}/missing`, ok: false, status: 404 }]);
  assert.equal(run.stderr, '');
});

test('check-urls passes when every source answers, and when the map has none', async t => {
  const base = await site(t);
  const w = initialized(t);
  assert.deepEqual(dr(['check-urls', w.dir]).json, { ok: true, checked: 0 });
  withSources(w, [`${base}/ok`, `${base}/ok?again`]);
  const run = await drAsync(['check-urls', w.dir]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(run.json, { ok: true, checked: 2 });
});

// ---- enqueue and accept ----

test('enqueue then accept', t => {
  const w = initialized(t);
  const queued = dr(['enqueue', w.dir, '--queue', 'g-know-1:detail; g-warn-1:question:ราคา: เท่าไร']);
  assert.equal(queued.status, 0, queued.stdout + queued.stderr);
  assert.equal(queued.json.appended.length, 2);
  assert.deepEqual(queued.json.skipped, []);
  assert.deepEqual(queued.json.appended.map(r => [r.nodeId, r.direction, r.question]), [['g-know-1', 'detail', undefined], ['g-warn-1', 'question', 'ราคา: เท่าไร']]);

  const run = dr(['accept', w.dir]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.json.accepted.length, 2);
  assert.equal(run.json.accepted[1].question, 'ราคา: เท่าไร');
  assert.deepEqual(run.json.skipped, []);
  assert.deepEqual(run.json.accepted.map(q => [q.id, q.status]), queued.json.appended.map(r => [r.id, 'pending']));

  // What was printed is what was saved, along with where the next accept starts reading.
  const map = readMap(w.dir);
  assert.deepEqual(map.queue, run.json.accepted);
  assert.equal(map.inboxOffset, bytesOf(w.dir, 'inbox.jsonl').length);
  assert.deepEqual(validateMap(map), { ok: true, errors: [] });
  assert.ok(readPage(w.dir).includes(run.json.accepted[0].id), 'the page was rendered after the save');

  // Nothing is new now: nothing is accepted, and nothing is saved.
  const [mapBefore, pageBefore] = [bytesOf(w.dir, 'map.json'), bytesOf(w.dir, 'index.html')];
  assert.deepEqual(dr(['accept', w.dir]).json, { accepted: [], skipped: [] });
  assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore));
  assert.ok(bytesOf(w.dir, 'index.html').equals(pageBefore));
});

test('accept reads only what is new after the stored offset, and does not queue the same research twice', t => {
  const w = initialized(t);
  dr(['enqueue', w.dir, '--queue', 'g-know-1:detail']);
  assert.equal(dr(['accept', w.dir]).json.accepted.length, 1);

  dr(['enqueue', w.dir, '--queue', 'g-know-2:examples; g-know-1:detail']);
  const second = dr(['accept', w.dir]);
  assert.deepEqual(second.json.accepted.map(q => [q.nodeId, q.direction]), [['g-know-2', 'examples']]);
  assert.equal(second.json.skipped.length, 1);
  assert.equal(second.json.skipped[0].request.nodeId, 'g-know-1');
  assert.equal(second.json.skipped[0].reason, 'already in the queue');
  assert.equal(readMap(w.dir).queue.length, 2);
  assert.equal(readMap(w.dir).inboxOffset, bytesOf(w.dir, 'inbox.jsonl').length, 'a skipped request is passed over too');
});

test('accept skips and reports what it must not queue, cleans a question, and queues the rest', t => {
  const w = initialized(t);
  const noId = { nodeId: 'g-know-2', direction: 'detail', at: NOW };
  addToInbox(
    w.dir,
    request({ id: 'r-a' }),
    request({ id: 'r-b' }), // the same research as r-a
    request({ id: 'r-c', nodeId: 'nope' }),
    request({ id: 'r-d', direction: 'sideways' }),
    noId,
    request({ id: 'r-e', direction: 'question', question: ` ${NEL} ` }), // blank to DRCore.cleanQuestion, though not to trim
    request({ id: 'r-f', direction: 'question', question: '  ราคา;  "เท่าไร"\n' }), // typed by hand, so not clean yet
    request({ id: 'r-g', nodeId: 'g-know-3', direction: 'examples', question: '   ' }), // a blank question is no question
  );
  const run = dr(['accept', w.dir]);
  assert.equal(run.status, 0, run.stdout + run.stderr);

  assert.deepEqual(run.json.accepted.map(q => q.id), ['r-a', 'r-f', 'r-g']);
  assert.equal(run.json.accepted[1].question, "ราคา, 'เท่าไร'");
  assert.equal('question' in run.json.accepted[2], false);
  assert.deepEqual(run.json.skipped.map(s => [s.request.id, s.reason]), [
    ['r-b', 'already in the queue'],
    ['r-c', 'unknown node "nope"'],
    ['r-d', 'unknown direction "sideways"'],
    [undefined, 'request has no id'],
    ['r-e', 'a "question" request needs question text'],
  ]);
  assert.deepEqual(run.json.skipped[3].request, noId);
  // So no later merge is blocked by a queue item the validator refuses.
  assert.deepEqual(validateMap(readMap(w.dir)), { ok: true, errors: [] });
  assert.equal(readMap(w.dir).inboxOffset, bytesOf(w.dir, 'inbox.jsonl').length);
});

test('accept passes over a request it skips, so the next accept does not report it again', t => {
  const w = initialized(t);
  addToInbox(w.dir, request({ id: 'r-bad', nodeId: 'nope' })); // the only line, and one that cannot be queued
  const first = dr(['accept', w.dir]);
  assert.deepEqual(first.json.accepted, []);
  assert.deepEqual(first.json.skipped.map(s => s.reason), ['unknown node "nope"']);
  assert.equal(readMap(w.dir).inboxOffset, bytesOf(w.dir, 'inbox.jsonl').length, 'the offset moved past it');
  assert.deepEqual(dr(['accept', w.dir]).json, { accepted: [], skipped: [] });
});

test('accept reports an inbox it cannot read as one error line, saves nothing and releases the lock', t => {
  const w = initialized(t);
  fs.rmSync(inFolder(w.dir, 'inbox.jsonl'));
  fs.mkdirSync(inFolder(w.dir, 'inbox.jsonl')); // a folder where the inbox should be
  const mapBefore = bytesOf(w.dir, 'map.json');
  const run = dr(['accept', w.dir]);
  assert.equal(run.status, 1);
  assert.match(run.json.error, /not a regular file/);
  assert.equal(run.stderr, '');
  assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore));
  assert.equal(fs.existsSync(inFolder(w.dir, 'map.json.lock')), false);
});

test('enqueue reads the queue from stdin with --queue -, strips a BOM, and keeps $, backticks and backslashes as typed', t => {
  const w = initialized(t);
  const text = `${BOM}g-know-1:question:ราคา $HOME \`date\` C:\\temp "quoted"\n; g-do-1:detail\n`;
  const run = dr(['enqueue', w.dir, '--queue', '-'], { input: text });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(run.json.appended.map(r => [r.nodeId, r.direction, r.question]), [
    ['g-know-1', 'question', "ราคา $HOME `date` C:\\temp 'quoted'"], // the question as cleanQuestion writes it: quotes made single
    ['g-do-1', 'detail', undefined],
  ]);
});

test('enqueue skips a node the map does not have, reports it, and appends the rest', t => {
  const w = initialized(t);
  const run = dr(['enqueue', w.dir, '--queue', 'nope-1:detail; g-know-1:examples; g-warn-9:question:ทำไม']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(run.json.appended.map(r => r.nodeId), ['g-know-1']);
  assert.deepEqual(run.json.skipped, [
    { request: { nodeId: 'nope-1', direction: 'detail' }, reason: 'unknown node "nope-1"' },
    { request: { nodeId: 'g-warn-9', direction: 'question', question: 'ทำไม' }, reason: 'unknown node "g-warn-9"' },
  ]);
  assert.equal(fs.readFileSync(inFolder(w.dir, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
});

test('enqueue refuses a queue string that does not parse, and appends nothing', t => {
  const w = initialized(t);
  const cases = [
    ['g-know-1:detail; g-know-2:sideways', /unknown direction "sideways"/],
    ['g-know-1:detail; g-know-2:question', /no question text/],
    ['g-know-1:detail; :detail', /no node id/],
    ['', /queue is empty/],
    [' ; ;  ', /queue is empty/],
  ];
  for (const [queue, message] of cases) {
    const run = dr(['enqueue', w.dir, '--queue', queue]);
    assert.equal(run.status, 1, `"${queue}" was accepted: ${run.stdout}`);
    assert.match(run.json.error, message);
    assert.equal(run.stderr, '');
  }
  assert.equal(bytesOf(w.dir, 'inbox.jsonl').length, 0, 'the valid first item was not appended either');
  assert.equal(dr(['enqueue', w.dir, '--queue', '-'], { input: '' }).status, 1);
});

// ---- start and finish ----

test('start and finish run the queue lifecycle, save and re-render', t => {
  const w = initialized(t);
  dr(['enqueue', w.dir, '--queue', 'g-know-1:detail']);
  const [queued] = dr(['accept', w.dir]).json.accepted;

  const started = dr(['start', w.dir, queued.id]);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.deepEqual(started.json, { started: { ...queued, status: 'researching' } });
  let map = readMap(w.dir);
  assert.equal(map.queue[0].status, 'researching');
  assert.equal(findNode(map, 'g-know-1').status, 'researching');
  assert.ok(readPage(w.dir).includes('"status":"researching"'), 'the page shows the node as researching');

  const finished = dr(['finish', w.dir, queued.id]);
  assert.equal(finished.status, 0, finished.stdout + finished.stderr);
  assert.deepEqual(finished.json, { finished: queued.id });
  map = readMap(w.dir);
  assert.deepEqual(map.queue, []);
  const node = findNode(map, 'g-know-1');
  assert.equal(node.status, 'frontier'); // nothing was merged under it
  assert.deepEqual(node.expansions.map(e => e.direction), ['detail']);
  assert.deepEqual(validateMap(map), { ok: true, errors: [] });
  assert.deepEqual(listing(w.dir), TOPIC_FILES);

  for (const command of ['start', 'finish']) {
    const unknown = dr([command, w.dir, 'r-nope']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.json.error, /unknown queue item "r-nope"/);
    assert.equal(unknown.stderr, '');
  }
});

// ---- serve ----

const listen = port => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});
const close = server => new Promise(resolve => server.close(resolve));
async function freePort() {
  const server = await listen(0);
  const { port } = server.address();
  await close(server);
  return port;
}
// Finds a port no test has to assume anything about and holds `held` ports in a row from it, for as long as the test runs. The
// `free` ports after those are checked to be free. It starts over when a port cannot be had (in use, or one Windows reserves).
async function findPorts(t, { held, free = 0 }) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const first = await freePort();
    if (first + held + free > 65000) continue;
    const open = [];
    try {
      for (let port = first; port < first + held; port++) open.push(await listen(port));
      for (let port = first + held; port < first + held + free; port++) await close(await listen(port));
    } catch {
      await Promise.all(open.map(close));
      continue;
    }
    t.after(() => Promise.all(open.map(close)));
    return first;
  }
  return assert.fail('found no free run of ports');
}
const portOf = url => Number(new URL(url).port);

test('serve prints server-started, serves the page, and stops by itself when idle', async t => {
  const w = initialized(t);
  const port = await freePort();
  // 6 s of idle time: the page is asked for within milliseconds of the first line, so a loaded machine has seconds to spare.
  const run = spawnDr(t, ['serve', w.dir, '--port', String(port), '--idle-minutes', '0.1']);
  const started = await run.next(isStarted, 'server-started');
  assert.deepEqual(Object.keys(started), ['type', 'url']);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const page = await fetch(`${started.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-mode="live"/);

  const stopped = await run.next(line => line.type === 'server-stopped', 'server-stopped');
  assert.deepEqual(stopped, { type: 'server-stopped', reason: 'idle' });
  assert.deepEqual(await run.exit, { code: 0, signal: null });
  assert.equal(run.lines.length, 2);
  assert.equal(run.stderr, '');
});

test('serve moves on to the next port when the one asked for is taken', async t => {
  const w = initialized(t);
  const port = await findPorts(t, { held: 1, free: 1 });
  const run = spawnDr(t, ['serve', w.dir, '--port', String(port), '--idle-minutes', '0.05']);
  const started = await run.next(isStarted, 'server-started');
  assert.ok(portOf(started.url) > port && portOf(started.url) <= port + 10, `${started.url} is not one of the 10 ports after ${port}`);
  assert.equal((await fetch(`${started.url}/map.json`)).status, 200, 'it serves on the port it printed');
});

test('serve fails, with one error line, when none of the 11 ports is free', async t => {
  const w = initialized(t);
  const port = await findPorts(t, { held: 11 });
  const run = await drAsync(['serve', w.dir, '--port', String(port)]);
  assert.equal(run.status, 1);
  assert.equal(run.json.error, `ports ${port}-${port + 10} are all in use or reserved by the system`);
  assert.equal(run.stderr, '');
});

// Windows answers EACCES, not EADDRINUSE, for a port in an excluded range (Hyper-V keeps such ranges), and a test cannot make it do
// so: an excluded range is a system setting, and this machine's only one (50000-50059, put there by an administrator) can still be
// bound. So these tests give the child a stub to preload (node --require). It makes net.Server#listen fail on the ports named in
// DR_TEST_REFUSE, a JSON object of port to error code, the way Node itself fails: asynchronously, with an error that has the code. The
// rest, dr.cjs, startServer and every real socket, runs as it does for real. The function is the stub's source and runs in the child.
function refusePorts() {
  const net = require('node:net');
  const refused = JSON.parse(process.env.DR_TEST_REFUSE);
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function refusingListen(...args) {
    const code = refused[args[0]];
    if (code === undefined) return listen.apply(this, args);
    const address = '127.0.0.1';
    const err = Object.assign(new Error(`listen ${code} ${address}:${args[0]}`), { code, syscall: 'listen', address, port: args[0] });
    process.nextTick(() => this.emit('error', err));
    return this;
  };
}
// The options that give a child the stub: `refuse` maps a port to the code listening on it fails with.
function refusing(w, refuse) {
  const stub = writeBytes(path.join(w.work, 'refuse-ports.cjs'), `(${refusePorts})();`);
  return { nodeArgs: ['--require', stub], env: { DR_TEST_REFUSE: JSON.stringify(refuse) } };
}

test('serve moves on past a port the system keeps for itself (EACCES) as well as past one that is in use', async t => {
  const w = initialized(t);
  const port = await findPorts(t, { held: 1, free: 3 }); // port is in use for real, and the next 3 are free
  const run = spawnDr(t, ['serve', w.dir, '--port', String(port), '--idle-minutes', '0.05'], refusing(w, { [port + 1]: 'EACCES' }));
  const started = await run.next(isStarted, 'server-started');
  assert.ok(portOf(started.url) > port + 1 && portOf(started.url) <= port + 10, `${started.url} is not past ${port} and ${port + 1}`);
  assert.equal((await fetch(`${started.url}/map.json`)).status, 200, 'it serves on the port it printed');
  assert.equal(run.stderr, '');
});

test('serve fails, with one error line, when every one of the 11 ports is in use or reserved', async t => {
  const w = initialized(t);
  const port = await findPorts(t, { held: 6 }); // the first 6 are in use for real, the other 5 are refused with EACCES
  const refuse = Object.fromEntries([6, 7, 8, 9, 10].map(n => [port + n, 'EACCES']));
  const run = await drAsync(['serve', w.dir, '--port', String(port)], refusing(w, refuse));
  assert.equal(run.status, 1);
  assert.equal(run.json.error, `ports ${port}-${port + 10} are all in use or reserved by the system`);
  assert.equal(run.stderr, '');
});

test('serve moves on for EADDRINUSE and EACCES only: any other error of the system is the failure', async t => {
  const w = initialized(t);
  const port = await findPorts(t, { held: 0, free: 2 }); // both free, so only the refusal can stop the first
  const run = spawnDr(t, ['serve', w.dir, '--port', String(port)], refusing(w, { [port]: 'EMFILE' }));
  // The first thing it prints is the answer. A serve that went on to the next port would print server-started and then keep running,
  // so this does not wait for it to end.
  await waitFor(() => run.lines.length > 0 || run.exited, 'its first line');
  assert.match(run.lines[0].error ?? JSON.stringify(run.lines[0]), /EMFILE/, 'the first line is the error of the system');
  assert.deepEqual(await run.exit, { code: 1, signal: null });
  assert.equal(run.lines.length, 1, 'it did not go on to the next port');
  assert.match(run.stderr, /EMFILE/, 'a failure that is no refusal keeps its stack');
});

test('serve with no --port starts on one of the ports 7357 to 7367', async t => {
  const w = initialized(t);
  const run = spawnDr(t, ['serve', w.dir, '--idle-minutes', '0.05']);
  const started = await run.next(isStarted, 'server-started');
  assert.ok(portOf(started.url) >= 7357 && portOf(started.url) <= 7367, started.url); // whichever of them is free on this machine
});

test('serve prints the port startServer refuses as an error line, and does not try the next one', t => {
  const w = initialized(t);
  const run = dr(['serve', w.dir, '--port', '80']);
  assert.equal(run.status, 1);
  assert.match(run.json.error, /port 80 is not supported/);
  assert.equal(run.stderr, '', 'a refused option prints no stack');
});

// ---- watch ----

test('watch prints requests then idles', async t => {
  const w = initialized(t);
  const sent = appendRequest(w.dir, { nodeId: 'g-know-1', direction: 'detail' });
  const run = spawnDr(t, ['watch', w.dir, '--idle-minutes', '0.01']);
  assert.deepEqual(await run.exit, { code: 0, signal: null });
  const rawLines = run.raw.split('\n').filter(Boolean);
  assert.equal(rawLines.length, 2);
  assert.match(rawLines[0], /"type":"expand"/);
  assert.match(rawLines[1], /"type":"idle"/);
  assert.deepEqual(run.lines, [{ type: 'expand', ...sent }, { type: 'idle' }]);
  assert.equal(run.stderr, '');
});

test('watch reports a request that arrives while it runs', async t => {
  const w = initialized(t);
  const run = spawnDr(t, ['watch', w.dir, '--idle-minutes', '0.5']);
  await sleep(400);
  const sent = appendRequest(w.dir, { nodeId: 'g-know-1', direction: 'question', question: 'ราคา: เท่าไร' });
  const line = await run.next(l => l.type === 'expand', 'expand');
  assert.deepEqual(line, { type: 'expand', ...sent });
  assert.equal(run.lines.length, 1, 'no idle line yet');
});

test('watch starts from map.inboxOffset: what accept took is not reported again', async t => {
  const w = initialized(t);
  dr(['enqueue', w.dir, '--queue', 'g-know-1:detail']);
  assert.equal(dr(['accept', w.dir]).json.accepted.length, 1);
  const sent = appendRequest(w.dir, { nodeId: 'g-know-2', direction: 'examples' });
  const run = spawnDr(t, ['watch', w.dir, '--idle-minutes', '0.01']);
  assert.deepEqual(await run.exit, { code: 0, signal: null });
  assert.deepEqual(run.lines, [{ type: 'expand', ...sent }, { type: 'idle' }]);
});

test('watch keeps one line per request even when a question holds U+2028 or U+2029', async t => {
  const w = initialized(t);
  const question = `a${LS}b${PS}c`;
  addToInbox(w.dir, request({ id: 'r-ls', direction: 'question', question }));
  const run = spawnDr(t, ['watch', w.dir, '--idle-minutes', '0.01']);
  assert.deepEqual(await run.exit, { code: 0, signal: null });
  assert.equal(run.raw.includes(LS) || run.raw.includes(PS), false, 'no raw separator was printed');
  assert.ok(run.raw.includes('\\u2028') && run.raw.includes('\\u2029'), 'they are written as escapes');
  assert.equal(run.raw.split(new RegExp(`[\\n\\r${LS}${PS}]`)).filter(Boolean).length, 2, 'two lines in whatever way a reader cuts them');
  assert.equal(run.lines[0].question, question, 'the escapes read back as the original text');
});

test('watch does not let a request pass for an event of another type', async t => {
  const w = initialized(t);
  addToInbox(w.dir, request({ id: 'r-x', type: 'idle' }));
  const run = spawnDr(t, ['watch', w.dir, '--idle-minutes', '0.01']);
  assert.deepEqual(await run.exit, { code: 0, signal: null });
  assert.deepEqual(run.lines.map(l => l.type), ['expand', 'idle']);
  assert.equal(run.lines[0].id, 'r-x');
});

test('watch fails loudly, with one error line and exit 1, when the inbox cannot be read', async t => {
  const w = initialized(t);
  fs.rmSync(inFolder(w.dir, 'inbox.jsonl'));
  fs.mkdirSync(inFolder(w.dir, 'inbox.jsonl')); // a folder where the inbox should be
  const run = spawnDr(t, ['watch', w.dir, '--idle-minutes', '0.5']);
  assert.deepEqual(await run.exit, { code: 1, signal: null });
  assert.equal(run.lines.length, 1);
  assert.match(run.lines[0].error, /not a regular file/);
  assert.equal(run.stderr, '');
});

// ---- the lock ----

test('a command waits for a held lock, and runs once it is released', async t => {
  const w = initialized(t);
  const lock = inFolder(w.dir, 'map.json.lock');
  fs.writeFileSync(lock, 'someone else\n');
  let settled = false;
  const run = drAsync(['mark-checked', w.dir]).finally(() => { settled = true; });
  await sleep(700); // far more than a child needs to start: it is retrying now
  assert.equal(settled, false, 'the command ran while the lock was held');
  fs.rmSync(lock);
  const result = await run;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json, { changed: 0 });
  assert.deepEqual(listing(w.dir), TOPIC_FILES, 'its own lock is gone too');
});

test('the commands that write a topic take the lock, and the others do not', async t => {
  const w = initialized(t);
  dr(['enqueue', w.dir, '--queue', 'g-know-1:detail']);
  const [queued] = dr(['accept', w.dir]).json.accepted;
  const file = writeJson(path.join(w.work, 'fragment.json'), fragment());
  const synthesisFile = writeJson(path.join(w.work, 'synthesis.json'), { rootSummary: 'สรุป' });
  const lock = inFolder(w.dir, 'map.json.lock');
  fs.writeFileSync(lock, 'held\n');

  // validate and enqueue, like check-urls, serve and watch, read or append only: they do not wait.
  assert.equal(dr(['validate', w.dir]).status, 0);
  assert.equal(dr(['enqueue', w.dir, '--queue', 'g-know-2:detail']).status, 0);

  const writers = {
    init: initArgs(w, ['--force']),
    render: ['render', w.dir],
    merge: mergeArgs(w, file),
    synthesize: ['synthesize', w.dir, '--file', synthesisFile],
    'mark-checked': ['mark-checked', w.dir],
    accept: ['accept', w.dir],
    start: ['start', w.dir, queued.id],
    finish: ['finish', w.dir, queued.id],
  };
  const settled = new Set();
  const runs = Object.entries(writers).map(([name, args]) => drAsync(args).finally(() => settled.add(name)));
  await sleep(800);
  assert.deepEqual([...settled], [], 'a command ran while the lock was held');
  fs.rmSync(lock);

  // They go one after the other now, in no set order, so one may find the map the other left (init --force wipes the queue and
  // start then has no item). Each still ends with its one line, and the map is whole and valid at the end.
  const results = await Promise.all(runs);
  for (const run of results) assert.ok(run.status === 0 || run.status === 1, `${run.stdout}${run.stderr}`);
  for (const run of results) assert.equal(run.lines.length, 1, run.stdout);
  assert.deepEqual(validateMap(readMap(w.dir)), { ok: true, errors: [] });
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

test('a lock older than 30 seconds is broken', t => {
  const w = initialized(t);
  const lock = inFolder(w.dir, 'map.json.lock');
  fs.writeFileSync(lock, '4242\n');
  const old = new Date(Date.now() - 31000);
  fs.utimesSync(lock, old, old);
  const run = dr(['mark-checked', w.dir]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

test('a command gives up on a lock that stays held for 10 seconds, names its holder, and leaves the lock alone', async t => {
  const w = initialized(t);
  const lock = inFolder(w.dir, 'map.json.lock');
  fs.writeFileSync(lock, '12345\n');
  const mapBefore = bytesOf(w.dir, 'map.json');
  const started = Date.now();
  const run = await drAsync(['mark-checked', w.dir]);
  // The child gives up 10 s after it starts, and it starts after this clock was read: it cannot be sooner than 10 s, so this
  // lower bound cannot fail on a slow machine, only on a command that gives up early.
  assert.ok(Date.now() - started >= 9500, `gave up after ${Date.now() - started} ms`);
  assert.equal(run.status, 1);
  assert.match(run.json.error, /map\.json\.lock .* held by another dr\.cjs command \(pid 12345\)/);
  assert.equal(run.stderr, '');
  assert.equal(fs.readFileSync(lock, 'utf8'), '12345\n', 'a lock that is not its own is not removed');
  assert.ok(bytesOf(w.dir, 'map.json').equals(mapBefore));
});

test('parallel merges lose no update', async t => {
  const w = initialized(t);
  const parents = ['g-know-1', 'g-know-2', 'g-know-3', 'g-do-1', 'g-do-2', 'g-do-3'];
  const files = parents.map(p => writeJson(path.join(w.work, `${p}.json`), fragment({ children: [item(`หัวข้อ ${p} หนึ่ง`, ['a']), item(`หัวข้อ ${p} สอง`, ['b'])] })));
  const runs = await Promise.all(parents.map((p, i) => drAsync(mergeArgs(w, files[i], p))));
  for (const run of runs) assert.equal(run.status, 0, run.stdout + run.stderr);

  const map = readMap(w.dir);
  assert.deepEqual(parents.map(p => findNode(map, p).children.length), parents.map(() => 2), 'every merge is in the map');
  assert.deepEqual(Object.keys(map.sources), ['s1', 's2']);
  assert.deepEqual(validateMap(map), { ok: true, errors: [] });
  assert.deepEqual(listing(w.dir), TOPIC_FILES);
});

// ---- the contract of every command ----

test('every failure is one {"error"} line on stdout and exit 1, with no stack trace', t => {
  const nowhere = path.join(os.tmpdir(), 'dr-cli-nowhere');
  const cases = [
    [[], /^no command given \(use one of: init, /],
    [['bogus'], /^unknown command "bogus" \(use one of: init, /],
    [['render'], /^missing <dir> \(usage: render <dir>\)$/],
    [['render', nowhere, 'extra'], /^unexpected argument "extra" \(usage: /],
    [['start', nowhere], /^missing <itemId> \(usage: start <dir> <itemId>\)$/],
    [['init', '--slug'], /^--slug needs a value \(usage: init /],
    [['init', '--slug', '--brief', 'b.json'], /^--slug needs a value/],
    [['init', '--bogus', 'x'], /^unknown option --bogus \(usage: init /],
    [['init', '--force=yes'], /^--force takes no value/],
    [['init', '--slug', 'a', '--slug', 'b'], /^--slug given twice/],
    [['init', '--brief', 'b.json'], /^--slug is required/],
    [['merge', nowhere, '--parent', 'g-know-1'], /^--fragment is required/],
    [['enqueue', nowhere], /^--queue is required/],
    [['synthesize', nowhere], /^--file is required \(usage: synthesize <dir> --file <synthesis\.json>\)$/],
    [['synthesize', '--file', 'x'], /^missing <dir> \(usage: synthesize /],
    [['serve', nowhere, '--port', 'abc'], /^--port must be a whole number/],
    [['serve', nowhere, '--port', '-1'], /^--port must be a whole number/],
    [['watch', nowhere, '--idle-minutes', '0'], /^--idle-minutes must be a number above 0/],
    [['watch', nowhere, '--idle-minutes', 'soon'], /^--idle-minutes must be a number above 0/],
    [['serve', nowhere, '--idle-minutes', '-5'], /^--idle-minutes must be a number above 0/],
  ];
  for (const [args, message] of cases) {
    const run = dr(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.deepEqual(Object.keys(run.json), ['error'], args.join(' '));
    assert.match(run.json.error, message);
    assert.equal(run.stderr, '', `${args.join(' ')} printed a stack`);
  }
  assert.equal(fs.existsSync(nowhere), false, 'a usage error touches no folder');
});

test('options may be written --name=value, and a value may look like an option or a dash', t => {
  const w = workspace(t);
  const run = dr(['init', `--topic=${w.topic}`, `--slug=${w.slug}`, `--brief=${w.briefFile}`, `--root=${w.root}`]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const odd = dr(['enqueue', w.dir, '--queue', '-'], { input: 'g-know-1:question:--force -x' });
  assert.equal(odd.json.appended[0].question, '--force -x');
});

test('an unexpected exception is still one {"error"} line and exit 1, with the stack on stderr, and the lock is released', t => {
  const w = initialized(t);
  fs.rmSync(inFolder(w.dir, 'index.html'));
  fs.mkdirSync(inFolder(w.dir, 'index.html')); // a folder where the page should be, so writing it fails
  const run = dr(['render', w.dir]);
  assert.equal(run.status, 1);
  assert.match(run.json.error, /EISDIR/);
  assert.match(run.stderr, /EISDIR[\s\S]*\n\s+at /);
  assert.equal(fs.existsSync(inFolder(w.dir, 'map.json.lock')), false);
});

test('accept escapes U+2028 and U+2029 in the line it prints', t => {
  const w = initialized(t);
  addToInbox(w.dir, request({ id: 'r-ls', nodeId: 'nope', direction: 'question', question: `a${LS}b${PS}c` }));
  const run = dr(['accept', w.dir]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout.includes(LS) || run.stdout.includes(PS), false);
  assert.ok(run.stdout.includes('\\u2028') && run.stdout.includes('\\u2029'));
  assert.equal(run.json.skipped[0].request.question, `a${LS}b${PS}c`);
});
