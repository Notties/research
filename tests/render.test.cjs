const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../assets/shared.js');
const { createMap } = require('../scripts/lib/map.cjs');
const { renderIndexHtml, writeIndexHtml } = require('../scripts/lib/render.cjs');

// The first five tests are the plan's own. The others pin what the plan and the rulings imply: the page's scripts stay whole
// and run in order whatever the map says, the placeholders are filled in one pass, a template or script that could break
// the page is refused, and the markup that the app builds on is there. The app itself runs against a stand-in browser: it
// boots (or says in Thai why it cannot), keeps map text as text, and queues or sends a chosen direction as the rulings say.

const ASSETS = path.join(__dirname, '..', 'assets');
const asset = file => fs.readFileSync(path.join(ASSETS, file), 'utf8');
const SCRIPT_FILES = ['vendor/d3.min.js', 'shared.js', 'viewer-core.js', 'viewer-app.js']; // in the order the page runs them
const TITLE_PREFIX = 'แผนที่ความรู้: ';
const PLACEHOLDERS = ['TITLE', 'MODE', 'D3', 'SHARED', 'CORE', 'APP', 'DATA'];

// U+2028 and U+2029 are built from their code points: typed into a file as escapes, they have landed as the real,
// invisible characters.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const jsonEscape = code => '\\u' + code.toString(16).padStart(4, '0'); // the 6 characters a JSON string uses for a code point

function newMap(topic = 'ทดสอบ') {
  const brief = { goal: 'สร้างงาน', level: 'ไม่รู้เลย', focus: '', exclude: '', depth: 'quick', constraints: '' };
  return createMap({ topic, slug: 'test-topic', brief, now: new Date('2026-11-01T00:00:00.000Z') });
}

// The map of `escapes script-breaking text`, with a U+2029 and a second case of the end tag added.
function hostileMap() {
  const m = newMap();
  m.topic = 'x</script><script>alert(1)</script>';
  m.root.summary = 'a' + LS + 'b<!--c';
  m.brief.focus = 'p' + PS + 'q</SCRIPT';
  return m;
}

// The inline <script> elements of a page, the way the browser cuts them: from the start tag up to the first end tag.
const scriptBlocks = html => [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({ attrs: m[1].trim(), body: m[2] }));
const dataBlock = html => scriptBlocks(html).find(b => b.attrs === 'type="application/json" id="map-data"').body;
const extract = html => JSON.parse(dataBlock(html));

// Makes render.cjs read edited text for the named files (keyed by file name) instead of what is on disk.
function editAssets(t, edits) {
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...rest) => {
    const text = read(target, ...rest);
    const edit = edits[path.basename(String(target))];
    return edit && typeof text === 'string' ? edit(text) : text;
  });
}

// ---- a stand-in for the browser ----
// The boot tests run the page's real scripts in a vm context against this stand-in for the browser's window and document.
// It has just enough DOM for D3 and the app to build the map: elements and text nodes, attributes, classList, style, simple
// selectors and listeners. It does no layout: every box is 1000 x 600 and a text is 7 px per character. It has no HTML
// parser, so innerHTML, outerHTML and insertAdjacentHTML throw: map text is web-sourced, and the app must only ever hand it
// to the page as text.
const NS_HTML = 'http://www.w3.org/1999/xhtml';
const NS_SVG = 'http://www.w3.org/2000/svg';
const noHtml = () => { throw new Error('the app handed text to the HTML parser'); };

// A test for the selectors D3 and the app use: *, tag, .class, tag.class.class, and any of these with one [attribute].
function matcher(selector) {
  const m = /^(\*|[a-z][\w-]*)?((?:\.[\w-]+)*)(?:\[([\w-]+)\])?$/i.exec(selector.trim());
  if (!m) throw new Error(`the stand-in DOM does not support the selector "${selector}"`);
  const [, tag, classes, attribute] = m;
  const names = classes.split('.').filter(Boolean);
  return el => el.nodeType === 1
    && (!tag || tag === '*' || el.localName === tag.toLowerCase())
    && names.every(name => el.classList.contains(name))
    && (!attribute || el.hasAttribute(attribute));
}

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.parentNode = null;
    this.data = String(text);
  }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class FakeElement {
  constructor(ownerDocument, namespaceURI, localName) {
    Object.assign(this, { ownerDocument, namespaceURI, localName, nodeType: 1, parentNode: null, childNodes: [], listeners: [] });
    this.attributes = new Map();
    const props = new Map();
    this.style = { setProperty: (k, v) => props.set(k, String(v)), removeProperty: k => props.delete(k), getPropertyValue: k => props.get(k) ?? '' };
  }
  get tagName() { return this.namespaceURI === NS_HTML ? this.localName.toUpperCase() : this.localName; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get id() { return this.getAttribute('id') ?? ''; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(on) { if (on) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get classList() {
    const read = () => (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const write = names => this.setAttribute('class', [...new Set(names)].join(' '));
    return {
      contains: name => read().includes(name),
      add: (...names) => write([...read(), ...names]),
      remove: (...names) => write(read().filter(name => !names.includes(name))),
      toggle: (name, force) => {
        const on = force ?? !read().includes(name);
        write(on ? [...read(), name] : read().filter(n => n !== name));
        return on;
      },
    };
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  insertBefore(node, ref) {
    node.parentNode?.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at === -1) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at !== -1) this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'object' ? node : new FakeText(node)); }
  replaceChildren(...nodes) {
    for (const node of [...this.childNodes]) this.removeChild(node);
    this.append(...nodes);
  }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) {
    this.replaceChildren();
    if (value != null && value !== '') this.append(String(value));
  }
  querySelectorAll(selector) {
    const match = matcher(selector);
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (match(child)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    const match = matcher(selector);
    for (let node = this; node?.nodeType === 1; node = node.parentNode) if (match(node)) return node;
    return null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type, listener) { this.listeners.push({ type, listener }); }
  removeEventListener(type, listener) { this.listeners = this.listeners.filter(l => l.type !== type || l.listener !== listener); }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 }; }
  getComputedTextLength() { return this.textContent.length * 7; }
  focus() {}
  scrollIntoView() {}
  get innerHTML() { return noHtml(); }
  set innerHTML(_) { noHtml(); }
  get outerHTML() { return noHtml(); }
  set outerHTML(_) { noHtml(); }
  insertAdjacentHTML() { noHtml(); }
}

// The page as a stand-in document: <html> with its attributes, and under <body> every element the page declares with an
// id, each with its tag and attributes (flat: the app finds its elements by id). The map-data element holds the text of the
// page's data block, as the browser would.
function fakeDocument(html, readyState) {
  const listeners = {};
  const document = {
    readyState,
    title: '',
    listeners,
    createElement: name => new FakeElement(document, NS_HTML, name),
    createElementNS: (ns, name) => new FakeElement(document, ns, name),
    createTextNode: text => new FakeText(text),
    getElementById: id => document.body.querySelectorAll('*').find(el => el.id === id) ?? null,
    addEventListener: (type, listener) => { listeners[type] = listener; },
    removeEventListener: () => {},
  };
  document.documentElement = new FakeElement(document, NS_HTML, 'html');
  document.body = document.documentElement.appendChild(new FakeElement(document, NS_HTML, 'body'));
  const attributesOf = text => [...text.matchAll(/([^\s=/]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '']);
  for (const [name, value] of attributesOf(/<html([^>]*)>/.exec(html)[1])) document.documentElement.setAttribute(name, value);
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ''); // what is left is the page's elements
  for (const [, tag, rest] of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (!/\bid="/.test(rest) || tag === 'html') continue;
    const el = document.createElementNS(tag === 'svg' ? NS_SVG : NS_HTML, tag.toLowerCase());
    for (const [name, value] of attributesOf(rest)) el.setAttribute(name, value);
    document.body.appendChild(el);
  }
  const data = scriptBlocks(html).find(b => b.attrs.includes('id="map-data"'));
  if (data) {
    const el = document.body.appendChild(document.createElement('script'));
    el.setAttribute('id', 'map-data');
    el.textContent = data.body;
  }
  return document;
}

// Runs the inline scripts of a page in order against the stand-in browser. `localStorage`, when given, is the property
// descriptor of window.localStorage (a getter that throws stands for a browser that refuses access). `globals` adds
// window properties, such as fetch or EventSource.
function runPage(html, { readyState = 'loading', localStorage, globals = {} } = {}) {
  const document = fakeDocument(html, readyState);
  const context = { document, navigator: {}, addEventListener() {}, removeEventListener() {}, ...globals };
  if (localStorage) Object.defineProperty(context, 'localStorage', localStorage);
  context.window = context;
  vm.createContext(context);
  for (const block of scriptBlocks(html)) if (block.attrs === '') vm.runInContext(block.body, context);
  return { context, document, listeners: document.listeners, byId: id => document.getElementById(id) };
}

const drawn = (document, selector) => document.getElementById('dr-svg').querySelectorAll(selector);
const nodeEl = (document, id) => drawn(document, 'g.km-node').find(g => g.__data__.data.id === id);

// Fires an event at an element the way a click or a keystroke reaches the app's and D3's listeners: at the element, then
// at each ancestor in turn, until a listener stops it.
function fire(el, type) {
  let stopped = false;
  const event = { type, target: el, button: 0, ctrlKey: false, stopPropagation() { stopped = true; }, preventDefault() {} };
  for (let node = el; node && !stopped; node = node.parentNode) {
    event.currentTarget = node;
    for (const { type: t, listener } of [...node.listeners]) if (t === type) listener.call(node, event);
  }
}

// A localStorage that works, kept in a Map.
function fakeStorage() {
  const items = new Map();
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)); } };
}

// Lets the app's pending promises (a POST, a map fetch) settle.
const settle = () => new Promise(resolve => setImmediate(resolve));

// Timers that never fire. A click animates the map, and D3 schedules its transitions on these, so they never run: the
// tests look at what a click selects, opens and stores, not at positions, and nothing is left running afterwards.
const noTimers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };

const readDemo = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'demo-map.json'), 'utf8'));

// ---- the plan's tests ----

test('embeds map data that round-trips', () => {
  const m = newMap();
  assert.deepEqual(extract(renderIndexHtml(m)), m);
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-map.json'), 'utf8'));
  assert.deepEqual(extract(renderIndexHtml(fixture)), fixture);
});

test('escapes script-breaking text', () => {
  const m = hostileMap();
  const html = renderIndexHtml(m);
  assert.deepEqual(extract(html), m);
  assert.ok(!html.includes('</script><script>alert(1)'));
  // In the data the dangerous characters are written as escapes, so none is left raw.
  const data = dataBlock(html);
  assert.ok(!data.includes('<') && !data.includes(LS) && !data.includes(PS));
  for (const code of [0x3c, 0x2028, 0x2029]) assert.ok(data.includes(jsonEscape(code)), jsonEscape(code));
});

test('escapes the title', () => {
  const html = renderIndexHtml(hostileMap());
  assert.ok(html.includes(`<title>${TITLE_PREFIX}x&lt;/script&gt;`));
});

test('sets mode', () => {
  const m = newMap();
  assert.ok(renderIndexHtml(m).includes('<html lang="th" data-mode="file">'));
  assert.ok(renderIndexHtml(m, { live: true }).includes('<html lang="th" data-mode="live">'));
  assert.ok(renderIndexHtml(m, { live: false }).includes('data-mode="file"'));
});

test('inlines libraries', () => {
  const html = renderIndexHtml(newMap());
  for (const text of ['7.9.0', 'DRShared', 'DRCore', 'DRApp']) assert.ok(html.includes(text), text);
});

test('the vendored d3 is the 279706-byte build of the global constraint', () => {
  // .gitattributes keeps these bytes on any checkout (assets/vendor/** -text), even with core.autocrlf=true.
  assert.equal(fs.statSync(path.join(ASSETS, 'vendor', 'd3.min.js')).size, 279706);
});

// ---- the page stays whole ----

test('the page keeps its scripts whole and in running order, whatever the map says', () => {
  const html = renderIndexHtml(hostileMap());
  const blocks = scriptBlocks(html);
  assert.equal(blocks.length, 5); // D3, shared, core, the data and the app: nothing the map says adds or ends one
  assert.deepEqual(blocks.map(b => b.attrs), ['', '', '', 'type="application/json" id="map-data"', '']);
  assert.deepEqual(blocks.filter(b => b.attrs === '').map(b => b.body), SCRIPT_FILES.map(asset)); // byte for byte, `$&` and all
  for (const block of blocks) {
    if (block.attrs === '') new vm.Script(block.body); // a script cut short would not compile
    else JSON.parse(block.body);
  }
});

test('the scripts run in order and the app boots, whatever the map says', () => {
  const m = hostileMap();
  const { context, document, byId, listeners } = runPage(renderIndexHtml(m));
  assert.equal(typeof context.d3.select, 'function');
  assert.equal(context.DRShared.ZONES.length, 5);
  assert.equal(typeof context.DRCore.badgeFor, 'function');
  assert.equal(typeof context.DRApp.boot, 'function');
  assert.equal(document.title, ''); // nothing happens before DOMContentLoaded
  assert.deepEqual(Object.keys(listeners), ['DOMContentLoaded']);
  listeners.DOMContentLoaded();
  assert.equal(document.title, TITLE_PREFIX + m.topic); // the page title has the prefix, the top bar shows the topic alone
  assert.equal(byId('dr-title').textContent, m.topic);
  // The map is drawn: the root, the 5 zones and the 18 groups of a new map (zones open, groups closed), with a link to
  // every node but the root. The panel shows the root: the topic and its summary, as text.
  assert.equal(drawn(document, 'g.km-node').length, 24);
  assert.equal(drawn(document, 'path.km-link').length, 23);
  assert.ok(byId('dr-panel').textContent.includes(m.topic));
  assert.ok(byId('dr-panel').textContent.includes(m.root.summary));
});

test('the app boots at once when the page has already loaded', () => {
  const m = newMap();
  const { document, byId, listeners } = runPage(renderIndexHtml(m), { readyState: 'interactive' });
  assert.ok(!Object.hasOwn(listeners, 'DOMContentLoaded'));
  assert.equal(document.title, TITLE_PREFIX + m.topic);
  assert.equal(byId('dr-title').textContent, m.topic);
  assert.equal(drawn(document, 'g.km-node').length, 24);
});

test('the app shows a Thai message, not a blank page, when the map data is missing or is not JSON', () => {
  const html = renderIndexHtml(newMap());
  const broken = '{"bad';
  let parseError;
  try { JSON.parse(broken); } catch (error) { parseError = error.message; }
  const pages = {
    missing: [html.replace(/<script type="application\/json" id="map-data">[\s\S]*?<\/script>/, ''), '#map-data'],
    'not JSON': [html.replace(dataBlock(html), () => broken), parseError],
  };
  for (const [name, [page, detail]] of Object.entries(pages)) {
    const { document, byId, listeners } = runPage(page);
    listeners.DOMContentLoaded();
    const shown = byId('dr-canvas').textContent;
    assert.ok(shown.includes('อ่านข้อมูลแผนที่ไม่ได้'), name);
    assert.ok(shown.includes(detail), `${name}: ${shown}`);
    assert.equal(drawn(document, 'g.km-node').length, 0, name);
  }
});

test('map text stays text: a logo is drawn only for a plain Simple Icons name, a source is linked only for an http(s) url', () => {
  const m = newMap();
  const [overview, terms] = m.root.children[0].children; // two groups, which a new map draws
  overview.logo = 'x" onload="alert(1)';
  terms.logo = 'threedotjs';
  const lure = '<img src=x onerror=alert(1)>';
  m.sources = {
    s1: { id: 's1', title: lure, url: 'javascript:alert(1)', publisher: 'P', type: 'official', accessedAt: '2026-11-01' },
    s2: { id: 's2', title: 'Real page', url: 'https://example.com/page', publisher: 'Q', type: 'community', accessedAt: '2026-11-01' },
  };
  m.summary.findings = [{ text: '<b>bold?</b>', cites: ['s1', 's2'] }];
  const { document, byId, listeners } = runPage(renderIndexHtml(m));
  listeners.DOMContentLoaded();
  assert.deepEqual(drawn(document, 'image').map(img => img.getAttribute('href')), ['https://cdn.simpleicons.org/threedotjs']);
  const panel = byId('dr-panel');
  for (const text of [lure, '<b>bold?</b>']) assert.ok(panel.textContent.includes(text), text);
  const links = panel.querySelectorAll('a').map(a => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]);
  assert.deepEqual(links, [
    ['#src-s1', null, null], ['#src-s2', null, null], // the finding's [1][2]
    ['https://example.com/page', '_blank', 'noopener'], // the source list links s2 only
  ]);
});

test('the demo map boots in file mode with its summary and queue, even when the browser refuses localStorage', () => {
  const demo = readDemo();
  const refuse = { get() { throw new Error('SecurityError: access denied'); } };
  const { document, byId, listeners } = runPage(renderIndexHtml(demo), { localStorage: refuse });
  listeners.DOMContentLoaded();
  assert.equal(document.documentElement.getAttribute('data-mode'), 'file');
  const dot = String.fromCharCode(0xb7);
  assert.equal(byId('dr-status').textContent, `กำลังขุด 1 ${dot} รอคิว 1`); // map.queue: one researching, one pending
  assert.equal(byId('dr-queue-chip').hidden, true); // nothing is queued in this browser
  assert.equal(drawn(document, 'g.km-node').length, 24);
  const panel = byId('dr-panel').textContent;
  for (const text of ['สรุป 1 นาที', 'ถ้าจะเริ่มพรุ่งนี้ ทำ 3 อย่างนี้', 'เริ่มอ่านตามลำดับ', 'แหล่งเดียว']) assert.ok(panel.includes(text), text);
  for (const finding of demo.summary.findings) assert.ok(panel.includes(finding.text), finding.text);
  for (const step of demo.summary.startTomorrow) assert.ok(panel.includes(step), step);
});

// ---- the app's behaviour, driven through the stand-in browser ----

test('file mode: a direction is queued once in this browser, and a question only with text, cleaned', () => {
  const store = fakeStorage();
  const { document, byId } = runPage(renderIndexHtml(readDemo()), { readyState: 'interactive', localStorage: { value: store }, globals: noTimers });
  const queued = () => JSON.parse(store.getItem('dr-queue:awwwards-3d-web'));
  fire(nodeEl(document, 'g-do-2'), 'click'); // a closed group: selected and opened
  fire(nodeEl(document, 'g-do-2-1'), 'click'); // a researched leaf: selected, and the direction menu opens
  const menu = byId('dr-canvas').querySelector('div.dr-menu');
  assert.equal(menu.hidden, false);
  const directions = menu.querySelectorAll('button[data-dir]');
  assert.deepEqual(directions.map(b => b.textContent), S.DIRECTIONS.map(d => d.label));
  fire(directions[1], 'click');
  assert.deepEqual(queued(), [{ nodeId: 'g-do-2-1', direction: 'examples' }]);
  assert.equal(menu.hidden, true);
  assert.equal(byId('dr-queue-chip').hidden, false);
  assert.equal(byId('dr-queue-chip').textContent, 'คิวรอขุด 1');

  // The same request again, from the panel's "ขุดต่อ": refused, so nothing is stored twice.
  fire(byId('dr-panel').querySelectorAll('button[data-act]').find(b => b.getAttribute('data-act') === 'dig'), 'click');
  assert.equal(menu.hidden, false);
  fire(directions[1], 'click');
  assert.equal(menu.querySelector('p.dr-menu-msg').textContent, 'คำขอนี้อยู่ในคิวรอขุดแล้ว');
  assert.equal(queued().length, 1);

  // "พิมพ์คำถามเอง" shows a box and "ส่ง", which stays off until the cleaned text is not empty.
  fire(directions[5], 'click');
  const form = menu.querySelector('form');
  const input = form.querySelector('input');
  const send = form.querySelector('button');
  assert.equal(form.hidden, false);
  input.value = ' \t\n ';
  fire(input, 'input');
  assert.equal(send.disabled, true);
  fire(form, 'submit');
  assert.equal(queued().length, 1);
  input.value = '  ใช้ "R3F";\n ดีไหม  ';
  fire(input, 'input');
  assert.equal(send.disabled, false);
  fire(form, 'submit');
  assert.deepEqual(queued()[1], { nodeId: 'g-do-2-1', direction: 'question', question: "ใช้ 'R3F', ดีไหม" });
  assert.equal(byId('dr-queue-chip').textContent, 'คิวรอขุด 2');
});

test('live mode: an accepted request looks busy at once and until map.queue holds it; one the server cannot take stays in this browser', async () => {
  const demo = readDemo();
  const store = fakeStorage();
  const posts = [];
  let reply = { status: 202, body: { id: 'r-test-1' } }; // 'down': the server is gone
  let served = demo;
  const fetch = async (url, options = {}) => {
    if (url === '/map.json') return { ok: true, status: 200, json: async () => structuredClone(served) };
    posts.push(JSON.parse(options.body));
    if (reply === 'down') throw new TypeError('Failed to fetch');
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  const streams = [];
  class EventSource {
    constructor(url) {
      this.url = url;
      this.listeners = [];
      streams.push(this);
    }
    addEventListener(type, listener) { this.listeners.push({ type, listener }); }
    emit(type, data) { for (const l of this.listeners) if (l.type === type) l.listener({ type, data }); }
  }
  const { document, byId } = runPage(renderIndexHtml(demo, { live: true }), {
    readyState: 'interactive', localStorage: { value: store }, globals: { fetch, EventSource, ...noTimers },
  });
  const dot = String.fromCharCode(0xb7);
  const busy = id => nodeEl(document, id).classList.contains('loading');
  const choose = (id, label) => {
    fire(nodeEl(document, id), 'click');
    fire(byId('dr-canvas').querySelector('div.dr-menu').querySelectorAll('button[data-dir]').find(b => b.textContent === label), 'click');
  };
  assert.deepEqual(streams.map(s => s.url), ['/events']);

  fire(nodeEl(document, 'g-do-2'), 'click');
  choose('g-do-2-1', 'ลงรายละเอียด');
  await settle();
  assert.deepEqual(posts, [{ nodeId: 'g-do-2-1', direction: 'detail' }]);
  assert.equal(busy('g-do-2-1'), true); // at once: map.json does not hold the request yet
  assert.equal(byId('dr-status').textContent, `กำลังขุด 1 ${dot} รอคิว 2`);

  // map.queue catches up with the request: still busy, and counted once.
  served = structuredClone(demo);
  served.queue.push({ id: 'r-test-1', nodeId: 'g-do-2-1', direction: 'detail', at: '2026-11-01T11:00:00.000Z', status: 'pending' });
  streams[0].emit('map', '{"updatedAt":"2026-11-01T11:00:01.000Z"}');
  await settle();
  assert.equal(busy('g-do-2-1'), true);
  assert.equal(byId('dr-status').textContent, `กำลังขุด 1 ${dot} รอคิว 2`);

  // A 5xx, then no server at all: each request stays in this browser's queue, and the chip offers the command.
  reply = { status: 503, body: { error: 'unavailable' } };
  choose('g-do-2-3', 'เทียบทางเลือก');
  await settle();
  reply = 'down';
  choose('g-do-2-2', 'ลงรายละเอียด');
  await settle();
  assert.deepEqual(JSON.parse(store.getItem('dr-queue:awwwards-3d-web')), [
    { nodeId: 'g-do-2-3', direction: 'compare' },
    { nodeId: 'g-do-2-2', direction: 'detail' },
  ]);
  assert.equal(busy('g-do-2-3'), false);
  assert.equal(byId('dr-queue-chip').hidden, false);
  assert.equal(byId('dr-queue-chip').textContent, 'คิวรอขุด 2');

  // A broken event stream shows the offline mark.
  assert.equal(byId('dr-offline').hidden, true);
  streams[0].emit('error');
  assert.equal(byId('dr-offline').hidden, false);
});

test('the shipped scripts hold no "<!--", which would let the browser swallow the closing tag', () => {
  for (const file of SCRIPT_FILES) assert.ok(!asset(file).includes('<!--'), file);
});

// ---- placeholders ----

test('fills every placeholder in one pass, so "$" patterns and placeholder text in the map stay inert', () => {
  const topic = "$& $' $1 $$ $` <!--DR:APP--> <!--DR:DATA-->";
  const m = newMap(topic);
  const html = renderIndexHtml(m);
  assert.deepEqual(extract(html), m);
  assert.ok(html.includes(`<title>${TITLE_PREFIX}$&amp; $&#39; $1 $$ $\` &lt;!--DR:APP--&gt; &lt;!--DR:DATA--&gt;</title>`));
  assert.ok(!html.includes('<!--DR:'));
  assert.equal(scriptBlocks(html).length, 5);
  assert.deepEqual(scriptBlocks(html).filter(b => b.attrs === '').map(b => b.body), SCRIPT_FILES.map(asset));
});

test('refuses a template that lacks a placeholder, naming it', t => {
  const edits = {};
  editAssets(t, edits);
  assert.ok(renderIndexHtml(newMap()).length > 0); // the unedited template is fine
  for (const name of PLACEHOLDERS) {
    edits['viewer.html'] = text => text.replaceAll(`<!--DR:${name}-->`, '');
    assert.throws(() => renderIndexHtml(newMap()), error => {
      assert.match(error.message, new RegExp(`<!--DR:${name}-->`));
      return true;
    }, name);
  }
});

test('fills a placeholder everywhere it stands', t => {
  editAssets(t, { 'viewer.html': text => text.replace('<body>', '<body data-title="<!--DR:TITLE-->">') });
  const html = renderIndexHtml(newMap('a&b'));
  assert.ok(html.includes(`<body data-title="${TITLE_PREFIX}a&amp;b">`));
  assert.ok(html.includes(`<title>${TITLE_PREFIX}a&amp;b</title>`));
});

// ---- inlined scripts ----

test('writes an end tag inside a script as <\\/script and changes nothing else', t => {
  const source = ['var a = "</script><script>alert(1)</script>";', 'var b = "</SCRIPT>";', 'var c = "x<y>z -->", d = "$&", e = "<!-";'].join('\n');
  editAssets(t, { 'viewer-app.js': () => source });
  const html = renderIndexHtml(newMap());
  const expected = source.replaceAll('</script', '<\\/script').replaceAll('</SCRIPT', '<\\/SCRIPT');
  assert.ok(expected.includes('<\\/script><script>alert(1)<\\/script>') && expected.includes('"<\\/SCRIPT>"'));
  assert.ok(html.includes(`<script>${expected}</script>`));
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.equal(scriptBlocks(html).length, 5);
});

test('refuses a script that holds "<!--", naming the file', t => {
  const edits = {};
  editAssets(t, edits);
  for (const file of SCRIPT_FILES) {
    const name = path.basename(file);
    edits[name] = text => `${text}\n// <!-- then <script> would hide the end tag\n`;
    assert.throws(() => renderIndexHtml(newMap()), error => {
      assert.ok(error.message.includes(name), error.message);
      assert.ok(error.message.includes('<!--'), error.message);
      return true;
    }, name);
    delete edits[name];
  }
});

// ---- the page the app builds on ----

test('the page has the elements the app builds on', () => {
  const html = renderIndexHtml(newMap());
  for (const markup of [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<header class="dr-bar">',
    'id="dr-title"',
    '<main class="dr-body">',
    '<div id="dr-canvas"><svg id="dr-svg"></svg></div>',
    '<aside id="dr-panel"></aside>',
  ]) assert.ok(html.includes(markup), markup);
  assert.match(html, /<header class="dr-bar">[\s\S]*id="dr-title"[\s\S]*<\/header>\s*<main class="dr-body">/);
});

test('the page is light only and has dropped the prototype dark and analysis rules', () => {
  const template = asset('viewer.html');
  assert.doesNotMatch(template, /prefers-color-scheme|\bdark\b/i);
  assert.doesNotMatch(template, /\.an-sec|\.st-|\.why-grid|\.pc-/);
  assert.match(template, /color-scheme: light/);
});

test('the page loads Inter and IBM Plex Sans Thai, with a system font behind them', () => {
  const template = asset('viewer.html');
  assert.match(template, /fonts\.googleapis\.com\/css2\?family=IBM\+Plex\+Sans\+Thai[^"]*&family=Inter[^"]*&display=swap/);
  assert.match(template, /--font:[^;]*Inter[^;]*IBM Plex Sans Thai[^;]*system-ui[^;]*sans-serif;/);
});

// ---- writeIndexHtml and bad input ----
// writeIndexHtml writes with a plain fs.writeFileSync into a folder that must already exist.

test('writeIndexHtml writes index.html into the folder and returns its path', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-render-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = newMap();
  const file = writeIndexHtml(dir, m);
  assert.equal(file, path.join(dir, 'index.html'));
  assert.deepEqual(fs.readdirSync(dir), ['index.html']);
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(written, renderIndexHtml(m));
  assert.ok(written.startsWith('<!doctype html>'));
  assert.deepEqual(extract(written), m);
  writeIndexHtml(dir, m, { live: true }); // overwrites, and passes the options on
  assert.ok(fs.readFileSync(file, 'utf8').includes('data-mode="live"'));
  assert.deepEqual(fs.readdirSync(dir), ['index.html']);
});

test('renderIndexHtml needs a map object', () => {
  for (const bad of [undefined, null, 'map', 42, ['a']]) {
    assert.throws(() => renderIndexHtml(bad), /needs a map object/, String(bad));
  }
});
