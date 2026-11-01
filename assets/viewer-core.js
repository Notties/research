(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f(require('./shared.js'));
  else root.DRCore = f(root.DRShared);
})(this, function (S) {
  'use strict';
  // Pure logic of the map viewer: badges, labels, citation numbers, reading-path steps, the offline expansion queue and
  // storage. It touches no DOM and no file, so the browser (the global DRCore, inlined into index.html) and the Node
  // command-line tool (require) share one copy. All it takes from DRShared is the list of expansion directions.
  if (!S) throw new Error('viewer-core.js needs DRShared (shared.js) loaded before it');

  const DIRECTION_IDS = S.DIRECTIONS.map(d => d.id);
  const EXPANDABLE_STATUSES = ['frontier', 'done', 'checking'];
  const CLAIM_FIELDS = ['points', 'conflicts', 'counterpoints']; // lists of { text, cites }

  const hasChildren = node => Array.isArray(node.children) && node.children.length > 0;

  // ---- nodes ----

  /**
   * Whether new research can be asked for under this node: it is not the root, it has no children (a node with no
   * children field has none), and its status is frontier, done or checking.
   */
  function isExpandable(node) {
    return node.level !== 'root' && !hasChildren(node) && EXPANDABLE_STATUSES.includes(node.status);
  }

  /**
   * The badge drawn on a node: "+N" when it is collapsed and has N children, "+" when it can be expanded, otherwise
   * null. The root never has one.
   * @param {{ collapsed?: boolean }} view
   * @returns {string | null}
   */
  function badgeFor(node, { collapsed } = {}) {
    if (node.level === 'root') return null;
    if (collapsed && hasChildren(node)) return `+${node.children.length}`;
    return isExpandable(node) ? '+' : null;
  }

  // The tone marks and the vowels above and below a Thai letter, and Sara Am, belong to the grapheme of the letter before
  // them, so cutting by grapheme never leaves one stranded at the start of the rest.
  const segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' });

  /**
   * The text cut to at most `max` graphemes: a longer text keeps its first `max` graphemes and gets an ellipsis (U+2026).
   */
  function shortLabel(text, max = 28) {
    const whole = String(text ?? '');
    const graphemes = Array.from(segmenter.segment(whole), part => part.segment);
    return graphemes.length > max ? `${graphemes.slice(0, max).join('')}…` : whole;
  }

  /**
   * The sources a node cites, numbered the way a reader sees them: in order of first appearance across its points,
   * conflicts and counterpoints (in that order), from 1.
   * @returns {{ order: string[], index: Record<string, number> }} the source ids in order, and each id's number
   */
  function numberCites(node) {
    const seen = new Set(); // keeps the order of first insertion. A Set, so an id such as "constructor" is only a name
    for (const field of CLAIM_FIELDS) {
      for (const claim of node[field] ?? []) {
        for (const id of claim?.cites ?? []) seen.add(id);
      }
    }
    const order = [...seen];
    // fromEntries defines own properties, so even the id "__proto__" gets its number.
    return { order, index: Object.fromEntries(order.map((id, i) => [id, i + 1])) };
  }

  // ---- navigation ----

  /**
   * The nodes from the root down to the node with this id, both included: [root, ..., node]. [] when no node has it.
   */
  function pathTo(root, id) {
    const trail = [];
    const visit = node => {
      trail.push(node);
      if (node.id === id) return true;
      for (const child of node.children ?? []) if (visit(child)) return true;
      trail.pop();
      return false;
    };
    return visit(root) ? trail : [];
  }

  /**
   * The id one step along map.readingPath from currentId: step 1 is the next stop, -1 the one before it. null past either
   * end, and when there is no reading path. A currentId that is null or not on the path counts as "before the start", so
   * 1 gives the first stop and -1 gives null.
   * @param {number} step 1 or -1
   * @returns {string | null}
   */
  function readingNav(map, currentId, step) {
    const stops = map.readingPath ?? [];
    const at = currentId == null ? -1 : stops.indexOf(currentId); // -1: before the start
    return stops[at + step] ?? null; // plain indexing, not .at(): an index of -1 is past the start, not the last stop
  }

  // ---- offline expansion queue ----

  /**
   * The key two expansion requests are compared by: node, direction and question. A missing, null and empty question are
   * the same question, and the id, the time and the status are not part of the key. This is the rule of queueKey in
   * scripts/lib/map.cjs, which the live server and the command-line tool dedupe by. The browser cannot require that file
   * (it reads files), so the rule is repeated here and a test keeps the two equal.
   */
  const queueKey = r => JSON.stringify([r.nodeId, r.direction, r.question ?? '']);

  /**
   * The counts for the top bar. `researching` is the items of map.queue that are being researched. `pending` is the
   * items of map.queue that are waiting, plus each distinct request in localItems (chosen in this browser, not sent yet)
   * that map.queue does not already hold under the same queueKey, whatever that item's status. A map with no queue has
   * an empty one, and null localItems (what safeStorage gives for a missing key) is none.
   * @param {Array<{ nodeId: string, direction: string, question?: string | null }> | null} [localItems]
   * @returns {{ researching: number, pending: number }}
   */
  function queueCounts(map, localItems) {
    const queued = map.queue ?? [];
    const known = new Set(queued.map(queueKey));
    const local = new Set((localItems ?? []).map(queueKey)); // the same request twice is one request
    const unsent = [...local].filter(key => !known.has(key)).length;
    return {
      researching: queued.filter(item => item.status === 'researching').length,
      pending: queued.filter(item => item.status === 'pending').length + unsent,
    };
  }

  // A question as it goes into the command: one line, and nothing that could end the --queue "..." text or an item.
  const cleanQuestion = question => String(question ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/;/g, ',')
    .trim();

  /**
   * The queue as the text of the --queue option: items joined with "; ", each one nodeId:direction[:question]. In a
   * question a run of line breaks or tabs becomes one space, a double quote becomes a single quote, ";" becomes ",", and
   * the ends are trimmed. An item with no question (absent, null or blank) has no third part.
   * @param {Array<{ nodeId: string, direction: string, question?: string | null }> | null} items
   * @returns {string}
   */
  function formatQueue(items) {
    return (items ?? []).map(({ nodeId, direction, question }) => {
      const text = cleanQuestion(question);
      return text === '' ? `${nodeId}:${direction}` : `${nodeId}:${direction}:${text}`;
    }).join('; ');
  }

  /**
   * The inverse of formatQueue. The text is split at ";" and each item trimmed, and empty items are skipped, so a
   * trailing "; " is fine. An item is cut at its first two colons only (a question may hold colons) and its parts are
   * trimmed. An item without a question has no question key at all.
   * @throws {Error} for an item with no node id, or whose direction is not one of the directions in DRShared
   * @returns {Array<{ nodeId: string, direction: string, question?: string }>}
   */
  function parseQueue(text) {
    const items = [];
    for (const piece of String(text ?? '').split(';')) {
      const item = piece.trim();
      if (item === '') continue;
      const [id, dir = '', ...rest] = item.split(':'); // rest, put back together, is all that follows the second colon
      const nodeId = id.trim();
      const direction = dir.trim();
      const question = rest.join(':').trim();
      if (nodeId === '') throw new Error(`queue item "${item}" has no node id`);
      if (!DIRECTION_IDS.includes(direction)) {
        throw new Error(`queue item "${item}" has unknown direction "${direction}" (use one of ${DIRECTION_IDS.join(', ')})`);
      }
      items.push(question === '' ? { nodeId, direction } : { nodeId, direction, question });
    }
    return items;
  }

  /** The slash command that hands the offline queue to Claude: /deep-research ต่อ <slug> --queue "<items>". */
  const buildQueueCommand = (slug, items) => `/deep-research ต่อ ${slug} --queue "${formatQueue(items)}"`;

  // ---- layout ----

  /** Divides ids over the two sides of the root: the right side gets the first ceil(n/2) ids, the left side the rest. */
  function splitSides(ids) {
    const cut = Math.ceil(ids.length / 2);
    return { right: ids.slice(0, cut), left: ids.slice(cut) };
  }

  // ---- storage ----

  /**
   * JSON storage that keeps working when the browser's storage does not (blocked for a page opened from a file, full, or
   * in private mode). Each value is also kept in memory as its JSON text, and that copy wins on get, so a value whose
   * setItem threw is still read back. A key never set here is read from the storage. A missing key, JSON that does not
   * parse and a getItem that throws all give null. A null or undefined storage works from memory alone. A value with no
   * JSON text of its own (undefined) is stored as null.
   * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void } | null} [storage]
   * @returns {{ get(key: string): any, set(key: string, value: any): void }}
   */
  function safeStorage(storage) {
    const memory = new Map(); // key -> JSON text
    return {
      get(key) {
        let text;
        if (memory.has(key)) text = memory.get(key);
        else {
          try { text = storage?.getItem(key); } catch { return null; }
        }
        if (typeof text !== 'string') return null;
        try { return JSON.parse(text); } catch { return null; }
      },
      set(key, value) {
        const text = JSON.stringify(value) ?? 'null';
        memory.set(key, text);
        try { storage?.setItem(key, text); } catch { /* full, blocked or gone: the memory copy still has it */ }
      },
    };
  }

  return {
    isExpandable, badgeFor, shortLabel, numberCites, pathTo, readingNav,
    queueKey, queueCounts, formatQueue, parseQueue, buildQueueCommand, splitSides, safeStorage,
  };
});
