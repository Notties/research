'use strict';
// Map library: create a map, load and save map.json, merge research fragments, move node statuses and run the
// expansion queue. A map is the plain JSON object that validate.cjs describes. These functions check only what they
// need in order to do their job, such as that a fragment is well formed and its cites resolve. The validator checks
// the rest of the content, and the CLI runs it before it saves.
//
// A fragment is what one research subagent writes:
//   Fragment     = { sources: { <localId>: Source }, self?: NodeFields, children?: FragmentNode[] }
//   NodeFields   = { summary, why, points, conflicts, counterpoints, forYou, confidence, confidenceReason, logo, related }
//   FragmentNode = NodeFields & { title, level?: 'group' | 'item' (default 'item'), children?: FragmentNode[] }
// Cites inside a fragment name sources by local id. mergeFragment maps them to the map's global ids (s1, s2, ...).
const fs = require('node:fs');
const path = require('node:path');
const S = require('../../assets/shared.js');

const MAP_FILE = 'map.json';
// The node fields a fragment may set. Anything else it carries (id, status, children of self, ...) is ignored.
const NODE_FIELDS = ['summary', 'why', 'points', 'conflicts', 'counterpoints', 'forYou', 'confidence', 'confidenceReason', 'logo', 'related'];
const CLAIM_FIELDS = ['points', 'conflicts', 'counterpoints']; // lists of { text, cites }
const FRAGMENT_LEVELS = ['group', 'item'];

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasChildren = node => Array.isArray(node.children) && node.children.length > 0;
const need = (ok, message) => { if (!ok) throw new Error(message); };

/**
 * A new map: the root, the 5 zones and the 18 default groups, all planned, with no sources yet.
 * @param {{ topic: string, slug: string, brief: object, now?: Date }} args
 */
function createMap({ topic, slug, brief, now = new Date() }) {
  const at = now.toISOString();
  const zones = S.ZONES.map(zone => ({
    id: `z-${zone.id}`,
    level: 'zone',
    title: zone.label,
    children: S.DEFAULT_GROUPS[zone.id].map((title, i) => ({
      id: `g-${zone.id}-${i + 1}`, level: 'group', title, status: 'planned', children: [],
    })),
  }));
  return {
    schemaVersion: 1,
    topic,
    slug,
    createdAt: at,
    updatedAt: at,
    brief: structuredClone(brief),
    sources: {},
    root: { id: 'root', level: 'root', title: topic, status: 'planned', children: zones },
    readingPath: [],
    summary: { findings: [], startTomorrow: [] },
    queue: [],
    inboxOffset: 0,
  };
}

/** Reads <dir>/map.json. */
function loadMap(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, MAP_FILE), 'utf8'));
}

// Windows refuses to rename over a file that another process has open at that instant (EPERM, EACCES or EBUSY), for
// example the live server reading map.json. The refusal clears within milliseconds, so the rename is retried.
const BUSY_CODES = ['EPERM', 'EACCES', 'EBUSY'];
const RENAME_ATTEMPTS = 8;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // a synchronous sleep
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt === RENAME_ATTEMPTS || !BUSY_CODES.includes(err.code)) throw err;
      pause(10 * attempt);
    }
  }
}

/**
 * Stamps updatedAt on the map and writes it to <dir>/map.json. The new text goes to map.json.tmp first and is then
 * renamed over map.json, so a reader sees the old map or the new one and never half of a write.
 */
function saveMap(dir, map, { now = new Date() } = {}) {
  map.updatedAt = now.toISOString();
  const file = path.join(dir, MAP_FILE);
  const tmp = `${file}.tmp`;
  const json = `${JSON.stringify(map, null, 2)}\n`; // serialize first: a map that cannot be serialized touches no file
  try {
    fs.writeFileSync(tmp, json);
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort: the next save overwrites it */ }
    throw err;
  }
}

// ---- tree ----

// The first node (document order) with this id, and its parent. The root's parent is null.
function locate(map, id) {
  const visit = (node, parent) => {
    if (node.id === id) return { node, parent };
    for (const child of node.children ?? []) {
      const hit = visit(child, node);
      if (hit) return hit;
    }
    return null;
  };
  return visit(map.root, null);
}

/** The node with this id, or null. */
const findNode = (map, id) => locate(map, id)?.node ?? null;

/** The parent of the node with this id. null for the root and for an unknown id. */
const parentOf = (map, id) => locate(map, id)?.parent ?? null;

/** Calls fn(node, parent) for every node, parents before their children. The root's parent is null. */
function walk(map, fn) {
  const visit = (node, parent) => {
    fn(node, parent);
    for (const child of node.children ?? []) visit(child, node);
  };
  visit(map.root, null);
}

// ---- fragments ----

// The key two urls are compared by: scheme and host in lower case, the default port, the #hash and trailing slashes
// dropped. The query stays. A value that is not a url is compared as written.
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname.replace(/\/+$/, '') + u.search;
  } catch {
    return String(raw);
  }
}

/**
 * Adds a research fragment under the node `parentId`, all or nothing. If anything is wrong, such as an unknown cite,
 * it throws and the map is unchanged.
 * - A source whose normalized url is already in the map reuses that source. A new one takes the next id after the
 *   highest s<N>. Every cite is remapped to a global id, and repeats inside one cites list collapse (first one wins).
 * - New nodes get the id "<parent id>-<n>", counting on from the parent's existing children, and the status checking.
 * - self overwrites the parent's fields. The parent and the new nodes get status checking and researchedAt = now.
 * @returns {{ added: string[], sourceIds: Record<string, string> }} the new node ids (parents before their children)
 *   and the global id of every fragment source, by local id
 */
function mergeFragment(map, parentId, fragment, { now = new Date() } = {}) {
  const parent = findNode(map, parentId);
  need(parent, `unknown node "${parentId}"`);
  need(isObj(fragment), 'fragment must be an object');
  const stamp = now.toISOString();
  // Everything that can throw runs first, on a private copy of the fragment, and only builds new objects. The writes
  // at the end are plain assignments, so an error never leaves the map half merged. The map itself is not cloned, so
  // node objects the caller already holds stay live.
  const frag = structuredClone(fragment);
  need(frag.sources == null || isObj(frag.sources), 'sources must be an object keyed by local id');
  need(frag.self == null || isObj(frag.self), 'self must be an object');

  const idByUrl = new Map(); // normalized url -> global id
  let highest = 0;
  for (const [id, s] of Object.entries(map.sources)) {
    const key = normalizeUrl(s?.url);
    if (!idByUrl.has(key)) idByUrl.set(key, id);
    highest = Math.max(highest, Number(/^s(\d+)$/.exec(id)?.[1] ?? 0));
  }
  const globalId = new Map(); // local id -> global id. A Map, so a local id like "constructor" is only a name.
  const newSources = [];
  for (const [localId, s] of Object.entries(frag.sources ?? {})) {
    need(isObj(s), `source "${localId}" must be an object`);
    const key = normalizeUrl(s.url);
    if (!idByUrl.has(key)) {
      const id = `s${++highest}`;
      idByUrl.set(key, id);
      newSources.push([id, { ...s, id }]);
    }
    globalId.set(localId, idByUrl.get(key));
  }

  const remapCites = cites => [...new Set(cites.map(local => {
    need(globalId.has(local), `unknown cite "${local}"`);
    return globalId.get(local);
  }))];
  // A claim that is malformed (not an object, no cites array) passes through, and validateMap reports it.
  const remapClaims = claims => (Array.isArray(claims)
    ? claims.map(c => (isObj(c) && Array.isArray(c.cites) ? { ...c, cites: remapCites(c.cites) } : c))
    : claims);
  const fieldsOf = spec => {
    const fields = {};
    for (const key of NODE_FIELDS) {
      if (spec[key] == null) continue;
      fields[key] = CLAIM_FIELDS.includes(key) ? remapClaims(spec[key]) : spec[key];
    }
    return fields;
  };

  const taken = new Set(); // every node id in the map, plus the ones handed out below
  walk(map, node => taken.add(node.id));
  const added = [];
  const build = (specs, parentNodeId, existing) => {
    need(Array.isArray(specs), 'children must be an array');
    let n = existing;
    return specs.map(spec => {
      need(isObj(spec) && typeof spec.title === 'string' && spec.title.trim() !== '', 'fragment node needs a title');
      const level = spec.level ?? 'item';
      need(FRAGMENT_LEVELS.includes(level), `invalid level "${level}"`);
      let id;
      do { id = `${parentNodeId}-${++n}`; } while (taken.has(id));
      taken.add(id);
      added.push(id);
      const node = { id, level, title: spec.title, status: 'checking', researchedAt: stamp, ...fieldsOf(spec) };
      node.children = build(spec.children ?? [], id, 0);
      return node;
    });
  };
  const children = build(frag.children ?? [], parent.id, parent.children?.length ?? 0);
  const update = { ...fieldsOf(frag.self ?? {}), status: 'checking', researchedAt: stamp };

  // From here on nothing can throw.
  for (const [id, record] of newSources) map.sources[id] = record;
  Object.assign(parent, update);
  (parent.children ??= []).push(...children);
  return { added, sourceIds: Object.fromEntries(globalId) };
}

// ---- statuses ----

/** Sets the status of every node in ids (an id or an array of ids). Throws, changing nothing, on an unknown id or status. */
function setStatus(map, ids, status) {
  need(S.STATUSES.includes(status), `unknown status "${status}"`);
  const nodes = [].concat(ids).map(id => {
    const node = findNode(map, id);
    need(node, `unknown node "${id}"`);
    return node;
  });
  for (const node of nodes) node.status = status;
}

/** Turns every checking node into frontier (no children) or done (has children). Returns how many it changed. */
function markChecked(map) {
  let changed = 0;
  walk(map, node => {
    if (node.status !== 'checking') return;
    node.status = hasChildren(node) ? 'done' : 'frontier';
    changed += 1;
  });
  return changed;
}

// ---- queue ----

// Two requests are the same when they ask for the same direction on the same node with the same question.
const requestKey = r => JSON.stringify([r.nodeId, r.direction, r.question ?? '']);

/**
 * Queues each request as a pending item, skipping any that matches an item already in the queue (or one queued a
 * moment ago in the same call). Returns the items it added.
 * @param {Array<{ id: string, nodeId: string, direction: string, question?: string, at: string }>} requests
 */
function acceptRequests(map, requests) {
  const seen = new Set(map.queue.map(requestKey));
  const accepted = [];
  for (const request of requests) {
    const key = requestKey(request);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { ...request, status: 'pending' };
    map.queue.push(item);
    accepted.push(item);
  }
  return accepted;
}

// The queue item, its position and the node it targets. Throws, before anything changes, if either is missing.
function lookup(map, itemId) {
  const index = map.queue.findIndex(q => q.id === itemId);
  need(index !== -1, `unknown queue item "${itemId}"`);
  const item = map.queue[index];
  const node = findNode(map, item.nodeId);
  need(node, `unknown node "${item.nodeId}"`);
  return { item, index, node };
}

/** Marks the queue item and its node as researching. Returns the item. */
function startItem(map, itemId) {
  const { item, node } = lookup(map, itemId);
  item.status = 'researching';
  node.status = 'researching';
  return item;
}

/**
 * Removes the item from the queue and records it in the node's expansions. A node that is still researching (no merge
 * moved it on) becomes frontier when it has no children and checking when it has some.
 */
function finishItem(map, itemId, { now = new Date() } = {}) {
  const { item, index, node } = lookup(map, itemId);
  map.queue.splice(index, 1);
  const expansion = { direction: item.direction };
  if (item.question != null) expansion.question = item.question;
  expansion.at = now.toISOString();
  (node.expansions ??= []).push(expansion);
  if (node.status === 'researching') node.status = hasChildren(node) ? 'checking' : 'frontier';
}

module.exports = {
  createMap, loadMap, saveMap, findNode, parentOf, walk, mergeFragment,
  setStatus, markChecked, acceptRequests, startItem, finishItem,
};
