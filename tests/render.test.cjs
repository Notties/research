const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createMap } = require('../scripts/lib/map.cjs');
const { renderIndexHtml, writeIndexHtml } = require('../scripts/lib/render.cjs');

// The first five tests are the plan's own. The others pin what the plan and the rulings imply: the page's scripts stay whole
// and run in order whatever the map says, the placeholders are filled in one pass, a template or script that could break
// the page is refused, and the markup that the app builds on is there.

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

// Runs the inline scripts of a page in order against a stand-in for the browser's window and document.
function runPage(html, readyState = 'loading') {
  const blocks = scriptBlocks(html);
  const listeners = {};
  const elements = { 'dr-title': { textContent: '' }, 'map-data': { textContent: blocks.find(b => b.attrs.includes('map-data')).body } };
  const document = {
    readyState,
    title: '',
    getElementById: id => elements[id] ?? null,
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };
  const context = { document };
  context.window = context;
  vm.createContext(context);
  for (const block of blocks) if (block.attrs === '') vm.runInContext(block.body, context);
  return { context, document, elements, listeners };
}

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
  const { context, document, elements, listeners } = runPage(renderIndexHtml(m));
  assert.equal(typeof context.d3.select, 'function');
  assert.equal(context.DRShared.ZONES.length, 5);
  assert.equal(typeof context.DRCore.badgeFor, 'function');
  assert.equal(typeof context.DRApp.boot, 'function');
  assert.equal(document.title, ''); // nothing happens before DOMContentLoaded
  assert.deepEqual(Object.keys(listeners), ['DOMContentLoaded']);
  listeners.DOMContentLoaded();
  assert.equal(document.title, TITLE_PREFIX + m.topic);
  assert.equal(elements['dr-title'].textContent, TITLE_PREFIX + m.topic);
});

test('the app boots at once when the page has already loaded', () => {
  const m = newMap();
  const { document, elements, listeners } = runPage(renderIndexHtml(m), 'interactive');
  assert.deepEqual(Object.keys(listeners), []);
  assert.equal(document.title, TITLE_PREFIX + m.topic);
  assert.equal(elements['dr-title'].textContent, TITLE_PREFIX + m.topic);
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
