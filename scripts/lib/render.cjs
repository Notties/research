'use strict';
// Page renderer: fills assets/viewer.html with a map and returns the finished page as one string, and writes it as a
// folder's index.html. The page carries everything it runs on (D3, the shared constants, the viewer logic and the app) and
// the map itself, so it opens from file:// with no network except the fonts and the logos.
//
// The template has seven holes, each a comment of the form <!--DR:NAME-->:
//   TITLE                  the page title, as HTML-escaped text
//   MODE                   "live" when the local server serves the page, otherwise "file"
//   D3, SHARED, CORE, APP  a <script> element that holds that file, in the order the page runs them
//   DATA                   a <script type="application/json" id="map-data"> element that holds the map
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const TEMPLATE = 'viewer.html';
// The scripts the page runs, by the hole that takes them. DRCore needs DRShared, and the app needs all three before it, so
// the order here is the order of the holes in the template.
const SCRIPTS = { D3: 'vendor/d3.min.js', SHARED: 'shared.js', CORE: 'viewer-core.js', APP: 'viewer-app.js' };
const HOLE = /<!--DR:(TITLE|MODE|D3|SHARED|CORE|APP|DATA)-->/g;
const TITLE_PREFIX = 'แผนที่ความรู้: '; // viewer-app.js puts the same prefix on document.title

const readAsset = file => fs.readFileSync(path.join(ASSETS, file), 'utf8');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

/**
 * A <script> element that holds `source`. An end tag inside the source is written as <\/script, which means the same inside
 * a string, a regular expression or a comment. Nothing else is rewritten, so a "<!--" is refused instead: it opens an escaped
 * section in which a later "<script" would make the browser read straight past the closing tag.
 * @param {string} file where the source came from, named in the error
 */
function scriptElement(file, source) {
  if (source.includes('<!--')) {
    throw new Error(`${file} contains "<!--", which could make the browser swallow the closing script tag of the page`);
  }
  return `<script>${source.replace(/<\/(script)/gi, (_, tag) => `<\\/${tag}`)}</script>`;
}

// In the map's JSON, "<" and the line separators U+2028 and U+2029 are written as escapes: "<" so that no text in the map
// can close the script or open a comment, the separators because some parsers and tools read them as line ends. None of the
// three can stand outside a string in JSON, so the escapes are always valid.
const JSON_UNSAFE = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const jsonEscape = ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');

/** The <script> element that carries the map, which viewer-app.js reads back with JSON.parse. */
function dataElement(map) {
  return `<script type="application/json" id="map-data">${JSON.stringify(map).replace(JSON_UNSAFE, jsonEscape)}</script>`;
}

/**
 * The template with every hole filled, in one pass, so what goes in is never searched again. The replacement is a function,
 * so no "$" pattern in the text that goes in (`$&`, `$'`, `$1`) is read as an instruction. Throws when the template lacks a hole.
 * @param {Record<string, string>} parts the text for each hole
 */
function fill(template, parts) {
  const filled = new Set();
  const html = template.replace(HOLE, (_, name) => {
    filled.add(name);
    return parts[name];
  });
  const missing = Object.keys(parts).filter(name => !filled.has(name));
  if (missing.length) throw new Error(`${TEMPLATE} lacks ${missing.map(name => `<!--DR:${name}-->`).join(', ')}`);
  return html;
}

/**
 * The page for a map, as one self-contained HTML string.
 * @param {object} map a map.json object
 * @param {{ live?: boolean }} options live: true when the local server serves the page, so it can reach the server
 */
function renderIndexHtml(map, { live = false } = {}) {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) throw new TypeError('renderIndexHtml needs a map object');
  const parts = {
    TITLE: escapeHtml(TITLE_PREFIX + (map.topic ?? '')),
    MODE: live ? 'live' : 'file',
    DATA: dataElement(map),
  };
  for (const [hole, file] of Object.entries(SCRIPTS)) parts[hole] = scriptElement(file, readAsset(file));
  return fill(readAsset(TEMPLATE), parts);
}

/**
 * Writes the page for a map to <dir>/index.html, with a plain write, and returns that path. The folder must exist.
 * @param {string} dir
 * @param {object} map
 * @param {{ live?: boolean }} [opts] as for renderIndexHtml
 */
function writeIndexHtml(dir, map, opts) {
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, renderIndexHtml(map, opts));
  return file;
}

module.exports = { renderIndexHtml, writeIndexHtml };
