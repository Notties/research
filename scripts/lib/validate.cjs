'use strict';
// map.json validator (schemaVersion 1). It collects every problem instead of stopping at the
// first one. Each error reads "<path>: <message>", e.g. root.children[0].children[0].points[1].cites[0].
const S = require('../../assets/shared.js');

const ZONE_IDS = S.ZONES.map(z => `z-${z.id}`);
const DEPTH_IDS = Object.keys(S.DEPTHS);
const DIRECTION_IDS = S.DIRECTIONS.map(d => d.id);
const NEEDS_CONFIDENCE = ['checking', 'done', 'frontier'];

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const filled = v => typeof v === 'string' && v.trim() !== '';
const isDate = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));
// Strings only, so an array like ['quick'] cannot pass for 'quick'.
const oneOf = (v, allowed) => typeof v === 'string' && allowed.includes(v);
const choices = allowed => `must be one of ${allowed.join(', ')}`;

/**
 * @param {object} map a parsed map.json
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateMap(map) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  if (!isObj(map)) return { ok: false, errors: ['map: must be an object'] };

  // Walks an array field and reports a non-array value. fn receives (item, itemPath).
  const each = (value, path, fn) => {
    if (!Array.isArray(value)) { err(path, 'must be an array'); return; }
    value.forEach((item, i) => fn(item, `${path}[${i}]`));
  };
  const eachOptional = (value, path, fn) => { if (value !== undefined) each(value, path, fn); };
  const atMost = (value, max, path) => {
    if (Array.isArray(value) && value.length > max) err(path, `at most ${max} items (got ${value.length})`);
  };

  // Rules 1-4: file-level fields.
  if (map.schemaVersion !== 1) err('schemaVersion', 'must be 1');
  if (!filled(map.topic)) err('topic', 'must be a non-empty string');
  if (typeof map.slug !== 'string' || !S.SLUG_RE.test(map.slug)) err('slug', `must match ${S.SLUG_RE.source}`);
  for (const k of ['createdAt', 'updatedAt']) if (!isDate(map[k])) err(k, 'must be a date string');
  if (!isObj(map.brief)) err('brief', 'must be an object');
  else if (!oneOf(map.brief.depth, DEPTH_IDS)) err('brief.depth', choices(DEPTH_IDS));

  // Rule 5: sources.
  if (!isObj(map.sources)) err('sources', 'must be an object keyed by source id');
  const sources = isObj(map.sources) ? map.sources : {};
  for (const [k, s] of Object.entries(sources)) {
    const p = `sources.${k}`;
    if (!isObj(s)) { err(p, 'must be an object'); continue; }
    if (s.id !== k) err(`${p}.id`, `must equal its key "${k}"`);
    if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) err(`${p}.url`, 'must start with http:// or https://');
    if (!filled(s.title)) err(`${p}.title`, 'must be a non-empty string');
    if (!oneOf(s.type, S.SOURCE_TYPES)) err(`${p}.type`, choices(S.SOURCE_TYPES));
    if (!isDate(s.accessedAt)) err(`${p}.accessedAt`, 'must be a date string');
  }

  // Citations. Object.hasOwn keeps inherited names such as "constructor" from counting as sources.
  const checkCites = (cites, path) => {
    if (!Array.isArray(cites) || cites.length === 0) { err(`${path}.cites`, 'must list at least 1 source id'); return false; }
    cites.forEach((c, i) => {
      if (typeof c !== 'string' || !Object.hasOwn(sources, c)) err(`${path}.cites[${i}]`, `unknown source "${c}"`);
    });
    return true;
  };
  // A { text, cites } claim. True when it is an object whose cites are a non-empty array.
  const checkClaim = (item, path) => {
    if (!isObj(item)) { err(path, 'must be an object'); return false; }
    if (!filled(item.text)) err(`${path}.text`, 'must be a non-empty string');
    return checkCites(item.cites, path);
  };
  // Counts distinct sources: citing the same source twice is not corroboration.
  const checkCorroborated = (item, path, what) => {
    if (new Set(item.cites).size < 2 && item.singleSource !== true) err(path, `${what} needs 2 sources or singleSource`);
  };
  const checkPoint = (pt, path) => {
    const citesOk = checkClaim(pt, path);
    if (!isObj(pt)) return;
    if (!oneOf(pt.type, S.POINT_TYPES)) err(`${path}.type`, choices(S.POINT_TYPES));
    if (citesOk && pt.key === true) checkCorroborated(pt, path, 'key point');
  };

  // Rule 6: the node tree. Pass 1 collects ids, so references can point anywhere in the tree.
  const ids = new Map(); // node id -> path of its first use
  const nodes = []; // [node, path] in document order
  const visited = new Set(); // stops a cyclic or shared node object from recursing forever
  const collect = (node, path) => {
    if (!isObj(node)) { err(path, 'must be an object'); return; }
    if (visited.has(node)) { err(path, 'node object appears more than once in the tree'); return; }
    visited.add(node);
    nodes.push([node, path]);
    if (!filled(node.id)) err(`${path}.id`, 'must be a non-empty string');
    else if (ids.has(node.id)) err(`${path}.id`, `duplicate id "${node.id}" (first used at ${ids.get(node.id)})`);
    else ids.set(node.id, path);
    eachOptional(node.children, `${path}.children`, collect);
  };
  const checkNodeRef = (id, path) => { if (!ids.has(id)) err(path, `unknown node "${id}"`); };

  if (!isObj(map.root)) err('root', 'must be an object');
  else {
    const root = map.root;
    collect(root, 'root');
    if (root.level !== 'root') err('root.level', 'must be "root"');
    const zones = Array.isArray(root.children) ? root.children : [];
    const got = zones.map(z => (isObj(z) ? z.id : undefined));
    if (got.length !== ZONE_IDS.length || got.some((id, i) => id !== ZONE_IDS[i])) {
      err('zones', `root.children must be exactly ${ZONE_IDS.join(', ')} in that order (got ${got.map(String).join(', ') || 'none'})`);
    }
    zones.forEach((z, i) => { if (isObj(z) && z.level !== 'zone') err(`root.children[${i}].level`, 'must be "zone"'); });
  }

  // Rules 7-11: node content. Status is checked only when present, because zones carry none.
  for (const [node, path] of nodes) {
    if (node.status !== undefined && !oneOf(node.status, S.STATUSES)) err(`${path}.status`, choices(S.STATUSES));
    eachOptional(node.points, `${path}.points`, checkPoint);
    eachOptional(node.conflicts, `${path}.conflicts`, checkClaim);
    eachOptional(node.counterpoints, `${path}.counterpoints`, checkClaim);
    if (Array.isArray(node.points) && node.points.length > 0 && NEEDS_CONFIDENCE.includes(node.status)) {
      if (!oneOf(node.confidence, S.CONFIDENCE)) err(`${path}.confidence`, `${choices(S.CONFIDENCE)} when a ${node.status} node has points`);
      if (!filled(node.confidenceReason)) err(`${path}.confidenceReason`, `must be non-empty when a ${node.status} node has points`);
    }
    eachOptional(node.related, `${path}.related`, checkNodeRef);
  }

  // Rule 12: reading path.
  each(map.readingPath, 'readingPath', checkNodeRef);

  // Rule 13: summary.
  if (!isObj(map.summary)) err('summary', 'must be an object with findings and startTomorrow');
  else {
    const { findings, startTomorrow } = map.summary;
    atMost(findings, 5, 'summary.findings');
    each(findings, 'summary.findings', (f, p) => { if (checkClaim(f, p)) checkCorroborated(f, p, 'finding'); });
    atMost(startTomorrow, 3, 'summary.startTomorrow');
    each(startTomorrow, 'summary.startTomorrow', (s, p) => { if (typeof s !== 'string') err(p, 'must be a string'); });
  }

  // Rule 14: queue.
  each(map.queue, 'queue', (q, p) => {
    if (!isObj(q)) { err(p, 'must be an object'); return; }
    if (!oneOf(q.direction, DIRECTION_IDS)) err(`${p}.direction`, choices(DIRECTION_IDS));
    checkNodeRef(q.nodeId, `${p}.nodeId`);
    if (!oneOf(q.status, S.QUEUE_STATUSES)) err(`${p}.status`, choices(S.QUEUE_STATUSES));
    if (q.direction === 'question' && !filled(q.question)) err(`${p}.question`, 'must be non-empty when direction is "question"');
  });

  return { ok: errors.length === 0, errors };
}

module.exports = { validateMap };
