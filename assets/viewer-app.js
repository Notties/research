(function () {
  'use strict';
  // The map viewer. It reads the map that the page carries in #map-data and draws it as a D3 tree: the root, the five
  // zones and their branches. A click selects a node and shows its details in the side panel, opens or closes a branch,
  // or, on a researched leaf, opens a menu of six directions in which to dig deeper. A choice becomes an expansion
  // request. In live mode (data-mode="live": the local server serves the page) it is POSTed to /expand, and the map
  // redraws whenever /events says map.json changed. In file mode it waits in this browser's queue (localStorage) until the
  // reader copies the queue to Claude as one command.
  // This file is inlined into index.html after D3, DRShared and DRCore, so none of them may be missing when it runs. Map
  // text is web-sourced, so it only ever reaches the page as text (textContent, D3 .text(), attribute values), never as HTML.

  const TITLE_PREFIX = 'แผนที่ความรู้: '; // the same prefix that scripts/lib/render.cjs puts in <title>

  // ---- look ----
  const ROOT_COLOR = '#111827';
  const PAD = 14; // inside a pill, before its first part and after its last
  const ICON = 18; // a zone icon or a logo
  const MARK = 28; // room for the badge or the spinner at the outer end of a pill
  const GAP = 56; // between columns
  const ROW = 40; // between rows
  const LABEL_MAX = 28; // graphemes in a node's label
  const MOVE_MS = 380;
  const GLOW_MS = 1600; // the length of the kmGlow animation in viewer.html
  const FONT_WAIT_MS = 1500;
  const LOGO_NAME = /^[a-z0-9]+$/; // a Simple Icons name; any other logo value is not drawn
  const LOGO_URL = 'https://cdn.simpleicons.org/';
  const heightOf = depth => (depth === 0 ? 44 : depth === 1 ? 38 : 32);

  // 24 x 24 stroke icons, built element by element: the zone icons that DRShared.ZONES name, and box, which stands in for
  // a logo that does not load.
  const ICONS = {
    book: [['path', { d: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z' }], ['path', { d: 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z' }]],
    tool: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]],
    eye: [['path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    alert: [
      ['path', { d: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }],
      ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }],
      ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }],
    ],
    compass: [['circle', { cx: 12, cy: 12, r: 10 }], ['polygon', { points: '16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76' }]],
    box: [
      ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
      ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }],
      ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }],
    ],
  };

  // ---- words ----
  const SEP = ' · ';
  const BUSY_TEXT = 'กำลังรีเสิร์ช…';
  const CHECK_TEXT = 'กำลังตรวจ';
  const STATUS_TEXT = { planned: 'วางแผนไว้ ยังไม่ได้ขุด', researching: BUSY_TEXT, checking: CHECK_TEXT, done: 'รีเสิร์ชแล้ว', frontier: 'รีเสิร์ชแล้ว ขุดต่อได้' };
  const CONFIDENCE_TEXT = { high: ['สูง', ''], medium: ['กลาง', 'mid'], low: ['ต่ำ', 'low'] }; // the label and the .kp-conf class
  const POINT_TYPE_TEXT = { fact: 'ข้อเท็จจริง', opinion: 'ความเห็น', estimate: 'ค่าประมาณ' };
  const SOURCE_TYPE_TEXT = { official: 'ทางการ', primary: 'ต้นฉบับ', secondary: 'แหล่งรอง', community: 'ชุมชน', video: 'วิดีโอ' };
  const HINT = 'กดโหนดเพื่อกางหรือขุดต่อ · ลากเพื่อเลื่อน · Ctrl + ล้อเมาส์เพื่อซูม';

  // ---- helpers ----
  const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
  const list = v => (Array.isArray(v) ? v.filter(item => item != null) : []);
  const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const kidsOf = node => list(node.children).filter(isObj);
  const hasKids = node => kidsOf(node).length > 0;
  const isWebUrl = url => typeof url === 'string' && /^https?:\/\//i.test(url);
  const byId = id => document.getElementById(id);

  /**
   * A new element. props are attributes, except `text` (the text content) and `style` (custom properties and styles).
   * Children are elements or text: a string child becomes a text node, so map text never reaches the HTML parser. A
   * null, undefined or false prop or child is left out, and arrays of children are flattened.
   */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(props ?? {})) {
      if (value == null || value === false) continue;
      if (name === 'text') el.textContent = value;
      else if (name === 'style') for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
      else el.setAttribute(name, value === true ? '' : value);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid != null && kid !== false) el.append(typeof kid === 'object' ? kid : String(kid));
    }
    return el;
  }

  const DAY = { day: 'numeric', month: 'short', year: 'numeric' };
  const dateText = {
    local: new Intl.DateTimeFormat('th-TH-u-ca-gregory', DAY),
    utc: new Intl.DateTimeFormat('th-TH-u-ca-gregory', { ...DAY, timeZone: 'UTC' }),
  };
  /** A date as "1 พ.ย. 2026": Thai month, Gregorian year. A bare YYYY-MM-DD is read in UTC, so it never shifts a day. */
  function formatDate(value) {
    const s = str(value);
    const time = Date.parse(s);
    if (Number.isNaN(time)) return s;
    return (/^\d{4}-\d{2}-\d{2}$/.test(s) ? dateText.utc : dateText.local).format(time);
  }

  // ---- boot ----

  function boot() {
    let map;
    try {
      map = readMap();
    } catch (err) {
      showProblem('อ่านข้อมูลแผนที่ไม่ได้', err);
      return;
    }
    const topic = str(map.topic);
    document.title = TITLE_PREFIX + topic;
    byId('dr-title').textContent = topic;
    whenFontsReady(() => {
      try {
        startViewer(map);
      } catch (err) {
        showProblem('แสดงแผนที่ไม่ได้', err);
        throw err;
      }
    });
  }

  function readMap() {
    const data = byId('map-data');
    if (!data) throw new Error('หน้านี้ไม่มีข้อมูลแผนที่ (#map-data)');
    const map = JSON.parse(data.textContent);
    if (!isObj(map) || !isObj(map.root)) throw new Error('ข้อมูลแผนที่ไม่มีโหนดราก (root)');
    return map;
  }

  /** A visible message in place of the map, so a page that cannot show its map never stays blank. */
  function showProblem(title, err) {
    const detail = err instanceof Error ? err.message : str(err);
    (byId('dr-canvas') ?? document.body).append(h('div', { class: 'dr-error', role: 'alert' }, h('strong', { text: title }), h('p', { text: detail })));
  }

  // Labels are measured to size the pills, so the first drawing waits for the web fonts, at most FONT_WAIT_MS.
  function whenFontsReady(start) {
    const fonts = document.fonts;
    if (!fonts || !fonts.ready) {
      start();
      return;
    }
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      start();
    };
    fonts.ready.then(go, go);
    setTimeout(go, FONT_WAIT_MS);
  }

  // The browser's localStorage, or null when even reading the property throws (a SecurityError on some file:// setups).
  // DRCore.safeStorage then keeps the queue in memory.
  function browserStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  // ---- the viewer ----

  function startViewer(firstMap) {
    const canvas = byId('dr-canvas');
    const panel = byId('dr-panel');
    const statusEl = byId('dr-status');
    const offlineEl = byId('dr-offline');
    const chipEl = byId('dr-queue-chip');
    const drawerEl = byId('dr-queue');
    const live = document.documentElement.getAttribute('data-mode') === 'live';
    const S = DRShared;
    const C = DRCore;
    const DIRECTION_TEXT = new Map(S.DIRECTIONS.map(d => [d.id, d.label]));
    const ZONE_BY_ID = new Map(S.ZONES.map(z => [z.id, z]));

    let map = firstMap;
    const slug = str(map.slug);
    const storage = C.safeStorage(browserStorage());
    const QUEUE_KEY = `dr-queue:${slug}`;
    const SEEN_KEY = `dr-seen:${slug}`;

    // What the reader has done, kept across live redraws: open and closed branches (by node id; a node not in here is
    // open at depth 0 and 1, closed deeper), the selected node, the layout, focus, and the reading-path stop.
    const collapsed = new Map();
    let selectedId = map.root.id;
    let layoutMode = 'both';
    let focusOn = true;
    let readingId = null;
    let menu = null; // the open direction menu: { nodeId, anchor: 'node' | 'panel' }
    let sending = false;
    let queueOpen = false;
    // id -> { node, parent, depth, zone } for every node of the current map
    let index = new Map();
    // nodes drawn last time (D3 hierarchy nodes) and the centre of each, by id, where branches grow from and fold into
    let lastNodes = [];
    let lastPos = new Map();
    // the ids of nodes that look busy; recomputed on every update
    let busy = new Set();
    // Requests the server accepted that map.queue does not hold yet: id -> { nodeId, direction, question?, at }.
    const accepted = new Map();
    // "Glow once": nodes researched after the previous render glow the first time they are drawn.
    let seenAt = finite(storage.get(SEEN_KEY));
    const pendingGlow = new Set();
    const glowUntil = new Map();
    let glowTimer = null;
    const badLogos = new Set(); // logo names whose image failed; they get the generic icon

    // ---- map, index and state ----

    function finite(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function reindex() {
      const next = new Map();
      const visit = (node, parent, depth, zone) => {
        if (next.has(node.id)) return;
        next.set(node.id, { node, parent, depth, zone });
        kidsOf(node).forEach((child, i) => {
          visit(child, node, depth + 1, depth === 0 ? ZONE_BY_ID.get(str(child.id).replace(/^z-/, '')) ?? S.ZONES[i] ?? null : zone);
        });
      };
      visit(map.root, null, 0, null);
      index = next;
    }

    const nodeOf = id => index.get(id)?.node ?? null;
    const colorOf = id => index.get(id)?.zone?.color ?? ROOT_COLOR;
    const titleOf = node => str(node.title) || (node === map.root ? str(map.topic) : '') || str(node.id);
    const isCollapsed = node => (collapsed.has(node.id) ? collapsed.get(node.id) : (index.get(node.id)?.depth ?? 0) >= 2);

    // A node looks busy (spinner, "กำลังรีเสิร์ช…") while its status is researching, while map.queue holds a request for
    // it, and after the server accepted a POST for it until map.queue holds that request.
    function busyNodeIds() {
      const ids = new Set();
      for (const item of list(map.queue)) if (isObj(item)) ids.add(item.nodeId);
      for (const request of accepted.values()) ids.add(request.nodeId);
      for (const { node } of index.values()) if (node.status === 'researching') ids.add(node.id);
      return ids;
    }
    const isBusy = node => node !== map.root && busy.has(node.id);
    const canDig = node => C.isExpandable(node) && !isBusy(node);

    // Marks for a glow the nodes researched since the previous render (none on the first view ever), then makes now the
    // previous render.
    function markFresh() {
      if (seenAt !== null) {
        for (const { node } of index.values()) if (Date.parse(node.researchedAt) > seenAt) pendingGlow.add(node.id);
      }
      seenAt = Date.now();
      storage.set(SEEN_KEY, seenAt);
    }

    // ---- the offline queue ----

    const isRequest = r => isObj(r) && typeof r.nodeId === 'string' && DIRECTION_TEXT.has(r.direction);
    const keyOf = r => C.queueKey({ ...r, question: C.cleanQuestion(r.question) });

    function localItems() {
      const items = storage.get(QUEUE_KEY);
      return Array.isArray(items) ? items.filter(isRequest) : [];
    }

    /** Adds the request to this browser's queue. false, and nothing stored, when the queue already holds the same one. */
    function addLocal(request) {
      const items = localItems();
      if (items.some(item => keyOf(item) === keyOf(request))) return false;
      storage.set(QUEUE_KEY, [...items, request]);
      return true;
    }

    /** The request a direction asks for; the question is cleaned. null for "question" when the cleaned text is empty. */
    function requestFor(nodeId, direction, typed) {
      if (direction !== 'question') return { nodeId, direction };
      const question = C.cleanQuestion(typed);
      return question === '' ? null : { nodeId, direction, question };
    }

    const directionText = r => (DIRECTION_TEXT.get(r.direction) ?? r.direction) + (r.question ? `: ${r.question}` : '');

    // ---- the canvas ----

    const svgEl = byId('dr-svg');
    const svg = d3.select(svgEl);
    const zoom = d3.zoom()
      .scaleExtent([0.25, 2.2])
      .clickDistance(4)
      .extent(() => {
        const v = viewSize();
        return [[0, 0], [v.w, v.h]];
      })
      .filter(e => (e.type === 'wheel' ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.button))
      .on('zoom', e => {
        gZoom.attr('transform', e.transform);
        placeMenu();
      });
    svg.call(zoom).on('dblclick.zoom', null).on('click', () => closeMenu());
    const gZoom = svg.append('g');
    const gLinks = gZoom.append('g');
    const gNodes = gZoom.append('g');
    const measureEl = svg.append('text').attr('class', 'km-measure').attr('aria-hidden', 'true').style('visibility', 'hidden');
    const tree = d3.tree().nodeSize([ROW, 1]).separation((a, b) => (a.parent === b.parent ? 1 : 1.3));

    function textWidth(text, cls) {
      measureEl.attr('class', `km-measure ${cls}`).text(text);
      return measureEl.node().getComputedTextLength();
    }

    // What a node's pill holds and how wide it is: label, icon, tag ("กำลังตรวจ" or "กำลังรีเสิร์ช…") and the mark at its
    // outer end (the DRCore badge, or 'spin' while it is busy).
    function metricsOf(node, depth) {
      const label = C.shortLabel(titleOf(node), LABEL_MAX);
      const labelW = textWidth(label, `d${Math.min(depth, 2)}`);
      const busyNow = isBusy(node);
      let icon = null; // { shape, cls }: drawn from ICONS (.zi white on a zone, .gi in the zone colour), or { logo }
      if (depth === 1) icon = { shape: index.get(node.id)?.zone?.icon ?? 'box', cls: 'zi' };
      else if (depth > 1 && typeof node.logo === 'string' && LOGO_NAME.test(node.logo)) {
        icon = badLogos.has(node.logo) ? { shape: 'box', cls: 'gi' } : { logo: node.logo };
      }
      let tag = null;
      if (depth > 0 && busyNow) tag = ['busy', BUSY_TEXT];
      else if (depth > 0 && node.status === 'checking') tag = ['check', CHECK_TEXT];
      const tagW = tag ? textWidth(tag[1], 'km-tag') : 0;
      const mark = busyNow ? 'spin' : C.badgeFor(node, { collapsed: isCollapsed(node) });
      const w = Math.ceil(PAD + (icon ? ICON + 8 : 0) + labelW + (tag ? 8 + tagW : 0) + PAD + (mark ? MARK : 0));
      return { label, labelW, icon, tag, mark, w, busy: busyNow, planned: depth > 0 && !busyNow && node.status === 'planned' };
    }

    // Where every visible node goes. In "both" the zones are split over the two sides of the root (DRCore.splitSides)
    // and each side is a tree of its own; in "right" one tree holds them all. On a hierarchy node d: d.x is the vertical
    // centre (the tree's breadth axis), d.px the left edge, d.w the width, d.side 'R' or 'L', d.m the metrics. The root
    // is listed once.
    function layout() {
      const root = map.root;
      const zones = kidsOf(root);
      const ids = zones.map(z => z.id);
      const both = layoutMode === 'both';
      const sides = both ? C.splitSides(ids) : { right: ids, left: [] };
      const rootM = metricsOf(root, 0);
      const nodes = [];
      const links = [];
      for (const [side, picked] of [['R', sides.right], ['L', sides.left]]) {
        if (side === 'L' && picked.length === 0) continue;
        const tops = zones.filter(z => picked.includes(z.id));
        const hier = d3.hierarchy(root, n => (n === root ? tops : isCollapsed(n) ? null : kidsOf(n)));
        tree(hier);
        const widest = [];
        hier.each(d => {
          d.side = side;
          d.m = d.depth ? metricsOf(d.data, d.depth) : rootM;
          d.w = d.m.w;
          widest[d.depth] = Math.max(widest[d.depth] ?? 0, d.w);
        });
        const col = [0, (both ? rootM.w / 2 : rootM.w) + GAP];
        for (let i = 2; i < widest.length; i++) col[i] = col[i - 1] + widest[i - 1] + GAP;
        hier.each(d => {
          if (!d.depth) d.px = both ? -rootM.w / 2 : 0;
          else d.px = side === 'R' ? col[d.depth] : -col[d.depth] - d.w;
        });
        for (const d of hier.descendants()) if (d.depth || nodes.length === 0) nodes.push(d);
        links.push(...hier.links());
      }
      return { nodes, links };
    }

    const centre = d => ({ x: d.px + d.w / 2, y: d.x });
    const translate = p => `translate(${p.x},${p.y})`;
    function diag(sx, sy, tx, ty) {
      const mx = (sx + tx) / 2;
      return `M${sx},${sy}C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
    }
    function linkPath(l) {
      const s = l.source;
      const t = l.target;
      return t.side === 'L' ? diag(s.px, s.x, t.px + t.w, t.x) : diag(s.px + s.w, s.x, t.px, t.x);
    }

    // The ids that stay bright in focus mode: the selected node, its ancestors and all its descendants. null: all bright.
    function focusSet() {
      const selected = nodeOf(selectedId);
      if (!focusOn || !selected || selected === map.root) return null;
      const keep = new Set(C.pathTo(map.root, selectedId).map(n => n.id));
      const walk = node => {
        keep.add(node.id);
        kidsOf(node).forEach(walk);
      };
      walk(selected);
      return keep;
    }

    /** Lays the tree out and draws it. A new node grows from its nearest drawn ancestor, a hidden one folds into it. */
    function update({ animate = true } = {}) {
      busy = busyNodeIds();
      const { nodes, links } = layout();
      const now = Date.now();
      const keep = focusSet();
      const onPath = new Set(C.pathTo(map.root, selectedId).map(n => n.id));
      const at = new Map(nodes.map(d => [d.data.id, d]));
      const rootAt = centre(at.get(map.root.id));
      const startOf = id => {
        for (let p = index.get(id)?.parent; p; p = index.get(p.id)?.parent) if (lastPos.has(p.id)) return lastPos.get(p.id);
        return rootAt;
      };
      const endOf = d => {
        for (let p = d.parent; p; p = p.parent) if (at.has(p.data.id)) return centre(at.get(p.data.id));
        return rootAt;
      };
      const t = animate ? svg.transition('layout').duration(MOVE_MS).ease(d3.easeCubicOut) : null;
      const moving = sel => (t ? sel.transition(t) : sel);

      const nodeSel = gNodes.selectAll('g.km-node').data(nodes, d => d.data.id);
      const entered = nodeSel.enter().append('g').attr('class', 'km-node').on('click', onNodeClick)
        .attr('transform', d => translate(t ? startOf(d.data.id) : { x: d.px, y: d.x }))
        .attr('opacity', t ? 0 : 1);
      const all = entered.merge(nodeSel);
      all.each(function (d) { drawNode(this, d, keep, now); });
      moving(all).attr('transform', d => `translate(${d.px},${d.x})`).attr('opacity', 1);
      if (t) nodeSel.exit().transition(t).attr('transform', d => translate(endOf(d))).attr('opacity', 0).remove();
      else nodeSel.exit().remove();

      const linkSel = gLinks.selectAll('path.km-link').data(links, l => l.target.data.id);
      const linkEntered = linkSel.enter().append('path').attr('class', 'km-link').attr('d', l => {
        if (!t) return linkPath(l);
        const p = startOf(l.target.data.id);
        return diag(p.x, p.y, p.x, p.y);
      });
      const allLinks = linkEntered.merge(linkSel)
        .attr('class', l => {
          const id = l.target.data.id;
          return `km-link l${Math.min(l.target.depth, 3)}${onPath.has(id) ? ' on' : ''}${keep && !keep.has(id) ? ' dim' : ''}`;
        })
        .style('--c', l => colorOf(l.target.data.id));
      moving(allLinks).attr('d', linkPath);
      if (t) {
        linkSel.exit().transition(t).attr('d', l => {
          const p = endOf(l.target);
          return diag(p.x, p.y, p.x, p.y);
        }).remove();
      } else linkSel.exit().remove();

      lastNodes = nodes;
      lastPos = new Map(nodes.map(d => [d.data.id, centre(d)]));
      if (glowUntil.size) endGlowLater();
      placeMenu();
    }

    function drawNode(el, d, keep, now) {
      const node = d.data;
      const id = node.id;
      const m = d.m;
      if (pendingGlow.delete(id)) glowUntil.set(id, now + GLOW_MS);
      const reading = id === readingId;
      const classes = ['km-node', `d${Math.min(d.depth, 2)}`];
      if (m.planned) classes.push('planned');
      if (m.busy) classes.push('loading');
      if (id === selectedId) classes.push('sel');
      if (keep && !keep.has(id)) classes.push('dim');
      if ((glowUntil.get(id) ?? 0) > now) classes.push('fresh');
      if (reading) classes.push('reading');
      const g = d3.select(el).attr('class', classes.join(' ')).style('--c', colorOf(id));
      // The pill is rebuilt only when what it shows changes, so a glow, a spinner or a logo is not restarted.
      const shape = JSON.stringify([m.label, m.icon, m.tag, m.mark, m.w, d.depth, d.side, reading]);
      if (el.__shape === shape) return;
      el.__shape = shape;
      el.replaceChildren();
      const height = heightOf(d.depth);
      const left = d.side === 'L';
      g.append('title').text(titleOf(node));
      if (reading) {
        g.append('rect').attr('class', 'km-halo').attr('x', -6).attr('y', -height / 2 - 6)
          .attr('width', m.w + 12).attr('height', height + 12).attr('rx', height / 2 + 6);
      }
      g.append('rect').attr('class', 'km-pill').attr('x', 0).attr('y', -height / 2).attr('width', m.w).attr('height', height).attr('rx', height / 2);
      let x = PAD + (left && m.mark ? MARK - 4 : 0);
      if (m.icon) {
        drawIcon(g, m.icon, x);
        x += ICON + 8;
      }
      g.append('text').attr('class', 'lbl').attr('x', x).attr('y', 0).text(m.label);
      if (m.tag) g.append('text').attr('class', `km-tag ${m.tag[0]}`).attr('x', x + m.labelW + 8).attr('y', 0).text(m.tag[1]);
      if (m.mark) {
        const cx = left ? 18 : m.w - 18;
        if (m.mark === 'spin') {
          g.append('g').attr('class', 'km-spin').attr('transform', `translate(${cx},0)`).append('circle').attr('r', 7);
        } else {
          const more = m.mark === '+';
          g.append('circle').attr('class', `km-cnt${more ? ' more' : ''}`).attr('cx', cx).attr('cy', 0).attr('r', 10);
          g.append('text').attr('class', `km-cnt-t${more ? ' more' : ''}`).attr('x', cx).attr('y', 0).text(m.mark);
        }
      }
    }

    function drawIcon(g, icon, x) {
      if (!icon.logo) {
        shapeIcon(g, icon.shape, icon.cls, x);
        return;
      }
      const img = g.append('image').attr('href', LOGO_URL + icon.logo)
        .attr('x', x).attr('y', -ICON / 2).attr('width', ICON).attr('height', ICON);
      img.on('error', () => {
        // The CDN is down, or has no such logo: the generic icon takes its place, now and on every later drawing.
        badLogos.add(icon.logo);
        const parent = img.node().parentNode;
        img.remove();
        if (parent) shapeIcon(d3.select(parent), 'box', 'gi', x);
      });
    }

    function shapeIcon(g, name, cls, x) {
      const ig = g.append('g').attr('class', cls).attr('transform', `translate(${x},${-ICON / 2}) scale(${ICON / 24})`);
      for (const [tag, attrs] of ICONS[name] ?? ICONS.box) {
        const shape = ig.append(tag);
        for (const [attr, value] of Object.entries(attrs)) shape.attr(attr, value);
      }
    }

    // A glow lasts GLOW_MS; afterwards the class goes, so a later drawing does not play it again.
    function endGlowLater() {
      if (glowTimer !== null) return;
      glowTimer = setTimeout(() => {
        glowTimer = null;
        const now = Date.now();
        for (const [id, until] of glowUntil) if (until <= now) glowUntil.delete(id);
        gNodes.selectAll('g.km-node').classed('fresh', d => (glowUntil.get(d.data.id) ?? 0) > now);
        if (glowUntil.size) endGlowLater();
      }, GLOW_MS + 50);
    }

    // ---- view ----

    function viewSize() {
      const box = canvas.getBoundingClientRect();
      return { w: box.width, h: box.height };
    }

    function boundsOf(ds) {
      const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (const d of ds) {
        const half = heightOf(d.depth) / 2 + 8;
        b.x0 = Math.min(b.x0, d.px);
        b.x1 = Math.max(b.x1, d.px + d.w);
        b.y0 = Math.min(b.y0, d.x - half);
        b.y1 = Math.max(b.y1, d.x + half);
      }
      return b;
    }

    function moveTo(b, k, animate = true) {
      const v = viewSize();
      const target = d3.zoomIdentity.translate(v.w / 2 - ((b.x0 + b.x1) / 2) * k, v.h / 2 - ((b.y0 + b.y1) / 2) * k).scale(k);
      if (animate) svg.transition().duration(480).call(zoom.transform, target);
      else svg.call(zoom.transform, target);
    }

    function fit(animate = true) {
      const v = viewSize();
      if (!lastNodes.length || !v.w || !v.h) return;
      const b = boundsOf(lastNodes);
      moveTo(b, Math.min(1.1, 0.92 * Math.min(v.w / (b.x1 - b.x0), v.h / (b.y1 - b.y0))), animate);
    }

    // Brings a node and its children into view, unless they are in view already.
    function reveal(id) {
      const me = lastNodes.find(d => d.data.id === id);
      if (!me) return;
      const b = boundsOf([me, ...lastNodes.filter(d => d.parent?.data.id === id)]);
      const v = viewSize();
      const now = d3.zoomTransform(svgEl);
      const k = now.k;
      const margin = 24 / k;
      const vx0 = -now.x / k;
      const vy0 = -now.y / k;
      const vx1 = vx0 + v.w / k;
      const vy1 = vy0 + v.h / k;
      if (b.x0 >= vx0 + margin && b.x1 <= vx1 - margin && b.y0 >= vy0 + margin && b.y1 <= vy1 - margin) return;
      moveTo(b, Math.max(0.35, Math.min(k, 0.9 * Math.min(v.w / (b.x1 - b.x0 + 60), v.h / (b.y1 - b.y0 + 60)))));
    }

    // Opens every branch above a node, selects it and moves the view to it.
    function jumpTo(id) {
      const entry = index.get(id);
      if (!entry) return;
      closeMenu();
      for (let p = entry.parent; p; p = index.get(p.id)?.parent) collapsed.set(p.id, false);
      selectedId = id;
      refresh();
      const me = lastNodes.find(d => d.data.id === id);
      if (me) moveTo(boundsOf([me]), d3.zoomTransform(svgEl).k);
    }

    function refresh() {
      update();
      renderPanel();
      renderBar();
    }

    // ---- clicks on the map ----

    function onNodeClick(event, d) {
      event.stopPropagation();
      const node = nodeOf(d.data.id);
      if (node) clickNode(node);
    }

    // A node with children: the first click selects it and opens it, a click on the selected node opens or closes it
    // (the root is only selected). A leaf that can be dug: select it and open the direction menu. Any other: select it.
    function clickNode(node) {
      closeMenu();
      if (node === map.root || !hasKids(node)) {
        selectedId = node.id;
        refresh();
        if (canDig(node)) openMenu(node.id, 'node');
        return;
      }
      if (selectedId !== node.id) {
        selectedId = node.id;
        collapsed.set(node.id, false);
      } else {
        collapsed.set(node.id, !isCollapsed(node));
      }
      refresh();
      if (!isCollapsed(node)) reveal(node.id);
    }

    // ---- the direction menu ----

    const dirButtons = S.DIRECTIONS.map(dir => h('button', { type: 'button', 'data-dir': dir.id }, dir.label));
    const menuTitle = h('div', { class: 'dr-menu-t' });
    const askInput = h('input', { type: 'text', maxlength: 500, placeholder: 'พิมพ์คำถามของคุณ', 'aria-label': 'คำถามที่อยากให้ขุดต่อ' });
    const askSend = h('button', { type: 'submit', class: 'kp-btn primary', disabled: true }, 'ส่ง');
    const askForm = h('form', { class: 'dr-ask', hidden: true }, askInput, askSend);
    const menuNote = h('p', { class: 'dr-menu-msg', role: 'status' });
    const menuEl = h('div', { class: 'dr-menu', role: 'dialog', 'aria-label': 'เลือกทิศทางที่จะขุดต่อ', hidden: true },
      h('div', { class: 'dr-menu-h' }, menuTitle, h('button', { type: 'button', class: 'dr-menu-x', 'data-menu': 'close' }, 'ปิด')),
      h('div', { class: 'dr-menu-list' }, dirButtons),
      askForm,
      menuNote);

    function openMenu(nodeId, anchor) {
      const node = nodeOf(nodeId);
      if (!node || !canDig(node)) return;
      menu = { nodeId, anchor };
      menuTitle.textContent = `ขุดต่อ: ${C.shortLabel(titleOf(node), 40)}`;
      askForm.hidden = true;
      askInput.value = '';
      askSend.disabled = true;
      menuNote.textContent = '';
      for (const b of dirButtons) {
        b.classList.remove('on');
        b.disabled = false;
      }
      menuEl.classList.toggle('in-panel', anchor === 'panel');
      menuEl.hidden = false;
      if (anchor === 'node') {
        canvas.append(menuEl);
        placeMenu();
        return;
      }
      renderPanel(); // the panel puts the menu under its buttons
      menuEl.scrollIntoView({ block: 'nearest' });
      dirButtons[0].focus({ preventScroll: true }); // opened from the "ขุดต่อ" button, so the keyboard carries on in the menu
    }

    function closeMenu() {
      if (!menu) return;
      menu = null;
      menuEl.hidden = true;
      menuEl.classList.remove('in-panel');
      canvas.append(menuEl);
    }

    // Puts the menu beside its node, on the side the branch grows to, or under the node when there is no room beside it.
    function placeMenu() {
      if (!menu || menu.anchor !== 'node') return;
      const d = lastNodes.find(n => n.data.id === menu.nodeId);
      if (!d) {
        closeMenu();
        return;
      }
      const t = d3.zoomTransform(svgEl);
      const v = viewSize();
      const [x0, y] = t.apply([d.px, d.x]);
      const x1 = x0 + d.w * t.k;
      const mw = menuEl.offsetWidth;
      const mh = menuEl.offsetHeight;
      const gap = 10;
      let left = d.side === 'L' ? x0 - gap - mw : x1 + gap;
      let top = y - mh / 2;
      if (left < 8 || left + mw > v.w - 8) {
        left = (x0 + x1) / 2 - mw / 2;
        top = y + (heightOf(d.depth) / 2) * t.k + gap;
      }
      menuEl.style.left = `${Math.round(Math.max(8, Math.min(left, v.w - mw - 8)))}px`;
      menuEl.style.top = `${Math.round(Math.max(8, Math.min(top, v.h - mh - 8)))}px`;
    }

    function setSending(on) {
      sending = on;
      for (const b of dirButtons) b.disabled = on;
      askSend.disabled = on || C.cleanQuestion(askInput.value) === '';
      menuNote.textContent = on ? 'กำลังส่ง…' : '';
    }

    menuEl.addEventListener('click', e => {
      if (e.target.closest('[data-menu]')) {
        closeMenu();
        return;
      }
      const btn = e.target.closest('button[data-dir]');
      if (!btn || btn.disabled) return;
      const direction = btn.getAttribute('data-dir');
      if (direction === 'question') {
        for (const b of dirButtons) b.classList.toggle('on', b === btn);
        askForm.hidden = false;
        askInput.focus();
        return;
      }
      choose(direction);
    });
    askInput.addEventListener('input', () => {
      askSend.disabled = sending || C.cleanQuestion(askInput.value) === '';
    });
    askForm.addEventListener('submit', e => {
      e.preventDefault();
      choose('question', askInput.value);
    });

    // Turns a choice into a request: queued in this browser in file mode, POSTed in live mode. A POST that cannot reach
    // the server (network error, 5xx) falls back to this browser's queue, so a click is never lost.
    async function choose(direction, typed) {
      if (!menu || sending) return;
      const nodeId = menu.nodeId;
      const request = requestFor(nodeId, direction, typed);
      if (!request) {
        menuNote.textContent = 'พิมพ์คำถามก่อน แล้วกดส่ง';
        return;
      }
      if (!live) {
        if (!addLocal(request)) {
          menuNote.textContent = 'คำขอนี้อยู่ในคิวรอขุดแล้ว';
          return;
        }
        closeMenu();
        renderPanel();
        renderBar();
        return;
      }
      setSending(true);
      const result = await post(request);
      setSending(false);
      const stillOpen = menu && menu.nodeId === nodeId;
      if (result.kind === 'accepted') {
        accepted.set(result.id, { ...request, at: result.sentAt });
        if (stillOpen) closeMenu();
        refresh();
      } else if (result.kind === 'unsent') {
        addLocal(request);
        if (stillOpen) closeMenu();
        renderPanel();
        renderBar();
      } else if (stillOpen) {
        menuNote.textContent = `ส่งคำขอไม่ได้: ${result.message}`;
      }
    }

    async function post(request) {
      const sentAt = Date.now();
      let res;
      try {
        res = await fetch('/expand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      } catch {
        return { kind: 'unsent' };
      }
      if (res.status >= 500) return { kind: 'unsent' };
      let body = null;
      try {
        body = await res.json();
      } catch {
        // no JSON body: the status still says what happened
      }
      if (res.status === 202 || res.status === 200) {
        return { kind: 'accepted', id: typeof body?.id === 'string' ? body.id : `unnamed-${sentAt}`, sentAt };
      }
      return { kind: 'refused', message: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}` };
    }

    // ---- the panel ----

    const section = (title, ...extra) => h('div', { class: 'kp-sec' }, title, ...extra);

    function citeLinks(ids, cites) {
      const links = [];
      for (const id of new Set(list(ids))) {
        if (Object.hasOwn(cites.index, id)) links.push(h('a', { class: 'kp-cite', href: `#src-${id}` }, `[${cites.index[id]}]`));
      }
      return links.length ? [' ', ...links] : null;
    }

    // Claims ({ text, cites }) as a list, each with its citation numbers; a point also with its type and, when it has one
    // source by design, "แหล่งเดียว".
    function claimList(claims, cites, { types = false } = {}) {
      return h('ul', { class: 'kp-ul' }, list(claims).filter(isObj).map(claim => h('li', { class: claim.key === true ? 'key' : null },
        str(claim.text),
        types && POINT_TYPE_TEXT[claim.type] ? [' ', h('span', { class: `kp-tag t-${claim.type}`, text: POINT_TYPE_TEXT[claim.type] })] : null,
        claim.singleSource === true ? [' ', h('span', { class: 'kp-tag single', text: 'แหล่งเดียว' })] : null,
        citeLinks(claim.cites, cites))));
    }

    // The sources a node cites, numbered as DRCore.numberCites numbers them. A link only for an http(s) url, and it opens
    // in a new tab.
    function sourceList(cites) {
      if (!cites.order.length) return [];
      const sources = isObj(map.sources) ? map.sources : {};
      return [section('แหล่งที่มา'), h('div', { class: 'kp-src' }, cites.order.map((id, i) => {
        const s = Object.hasOwn(sources, id) && isObj(sources[id]) ? sources[id] : null;
        const title = (s && (str(s.title) || str(s.url))) || str(id);
        const name = s && isWebUrl(s.url) ? h('a', { href: s.url, target: '_blank', rel: 'noopener' }, title) : h('span', { text: title });
        const meta = s
          ? [str(s.publisher), SOURCE_TYPE_TEXT[s.type], s.publishedAt && `เผยแพร่ ${formatDate(s.publishedAt)}`, s.accessedAt && `เข้าถึง ${formatDate(s.accessedAt)}`]
          : ['ไม่พบแหล่งนี้ในแผนที่'];
        return h('div', { id: `src-${id}` }, h('span', { class: 'kp-n', text: `[${i + 1}]` }), ' ', name, h('small', { text: meta.filter(Boolean).join(SEP) }));
      }))];
    }

    const chipFor = node => h('button', { type: 'button', class: 'kp-chip', 'data-act': 'jump', 'data-id': node.id, style: { '--c': colorOf(node.id) } }, C.shortLabel(titleOf(node), 40));

    function childChips(node, title) {
      const kids = kidsOf(node).filter(child => index.has(child.id));
      return kids.length ? [section(`${title} (${kids.length})`), h('div', { class: 'kp-chips' }, kids.map(chipFor))] : [];
    }

    function readingBar() {
      if (readingId === null) return null;
      const stops = list(map.readingPath);
      const at = stops.indexOf(readingId);
      const prev = C.readingNav(map, readingId, -1);
      const next = C.readingNav(map, readingId, 1);
      return h('div', { class: 'kp-read', role: 'group', 'aria-label': 'อ่านตามลำดับ' },
        h('span', { class: 'kp-read-n', text: at === -1 ? 'อ่านตามลำดับ' : `อ่านตามลำดับ ${at + 1}/${stops.length}` }),
        h('button', { type: 'button', class: 'kp-btn', 'data-act': 'read-prev', disabled: prev === null }, 'ก่อนหน้า'),
        h('button', { type: 'button', class: 'kp-btn', 'data-act': 'read-next', disabled: next === null }, 'ถัดไป'),
        h('button', { type: 'button', class: 'kp-btn', 'data-act': 'read-exit' }, 'ออกจากโหมดอ่าน'));
    }

    // The root: the one-minute summary, the first three steps, the reading path, the zones and the cited sources.
    function rootParts() {
      const root = map.root;
      const parts = [h('div', { class: 'kp-kind', style: { '--c': ROOT_COLOR }, text: 'หัวข้อที่รีเสิร์ช' }), h('h3', { text: str(map.topic) || titleOf(root) })];
      const count = isObj(map.sources) ? Object.keys(map.sources).length : 0;
      const meta = [count ? `รีเสิร์ชจาก ${count} แหล่ง` : '', map.updatedAt ? `อัปเดต ${formatDate(map.updatedAt)}` : ''].filter(Boolean);
      if (meta.length) parts.push(h('div', { class: 'kp-meta', text: meta.join(SEP) }));
      if (root.summary) parts.push(h('p', { class: 'kp-sum', text: str(root.summary) }));
      const findings = list(map.summary?.findings).filter(isObj);
      const cites = C.numberCites({ points: findings });
      if (findings.length) parts.push(section('สรุป 1 นาที'), claimList(findings, cites));
      const steps = list(map.summary?.startTomorrow).map(str).filter(Boolean);
      if (steps.length) parts.push(section(`ถ้าจะเริ่มพรุ่งนี้ ทำ ${steps.length} อย่างนี้`), h('ol', { class: 'kp-ul' }, steps.map(step => h('li', { text: step }))));
      if (list(map.readingPath).length) {
        parts.push(h('div', { class: 'kp-actions' }, h('button', { type: 'button', class: 'kp-btn primary', 'data-act': 'read-start' }, 'เริ่มอ่านตามลำดับ')));
      }
      parts.push(...childChips(root, 'โซน'), ...sourceList(cites));
      return parts;
    }

    // Any other node, in the order of spec section 9: zone and path, summary, for you, points, confidence, conflicts,
    // counterpoints, related, sources, then the buttons.
    function nodeParts(node) {
      const zone = index.get(node.id)?.zone;
      const parts = [h('div', { class: 'kp-kind', style: { '--c': zone?.color ?? ROOT_COLOR }, text: zone?.label ?? '' }), h('h3', { text: titleOf(node) })];
      const trail = C.pathTo(map.root, node.id).slice(1, -1).map(titleOf);
      if (trail.length) parts.push(h('div', { class: 'kp-path', text: trail.join(' › ') }));
      const status = isBusy(node) ? BUSY_TEXT : STATUS_TEXT[node.status];
      const meta = [status, node.researchedAt ? `รีเสิร์ชเมื่อ ${formatDate(node.researchedAt)}` : ''].filter(Boolean);
      if (meta.length) parts.push(h('div', { class: 'kp-meta', text: meta.join(SEP) }));
      if (node.summary) parts.push(h('p', { class: 'kp-sum', text: str(node.summary) }));
      if (node.why) parts.push(section('ทำไมสำคัญ'), h('p', { class: 'kp-sum', text: str(node.why) }));
      if (node.forYou) parts.push(h('div', { class: 'kp-foryou' }, h('div', { class: 'kp-foryou-h', text: 'สำหรับคุณ' }), h('p', { text: str(node.forYou) })));
      const cites = C.numberCites(node);
      if (list(node.points).length) parts.push(section('สิ่งที่ควรรู้'), claimList(node.points, cites, { types: true }));
      const confidence = CONFIDENCE_TEXT[node.confidence];
      if (confidence) {
        parts.push(section('ความมั่นใจ', h('span', { class: `kp-conf ${confidence[1]}`.trim(), text: confidence[0] })));
        if (node.confidenceReason) parts.push(h('p', { class: 'kp-reason', text: str(node.confidenceReason) }));
      }
      if (list(node.conflicts).length) parts.push(section('แหล่งขัดกัน'), claimList(node.conflicts, cites));
      if (list(node.counterpoints).length) parts.push(section('ข้อโต้แย้ง'), claimList(node.counterpoints, cites));
      const related = [...new Set(list(node.related))].filter(id => id !== node.id && index.has(id)).map(nodeOf);
      if (related.length) parts.push(section('เรื่องที่เกี่ยวข้อง'), h('div', { class: 'kp-chips' }, related.map(chipFor)));
      parts.push(...childChips(node, 'หัวข้อย่อย'), ...sourceList(cites), actionRow(node));
      return parts;
    }

    function actionRow(node) {
      const row = h('div', { class: 'kp-actions' });
      if (hasKids(node)) row.append(h('button', { type: 'button', class: 'kp-btn', 'data-act': 'toggle' }, isCollapsed(node) ? 'กางกิ่งนี้' : 'หุบกิ่งนี้'));
      if (isBusy(node)) row.append(h('div', { class: 'kp-loading', text: 'กำลังรีเสิร์ชหัวข้อนี้ลึกลงไปอีกชั้น…' }));
      else if (canDig(node)) row.append(h('button', { type: 'button', class: 'kp-btn primary', 'data-act': 'dig' }, 'ขุดต่อ'));
      const waiting = localItems().filter(item => item.nodeId === node.id);
      if (waiting.length) {
        row.append(h('p', { class: 'kp-note' }, `อยู่ในคิวรอขุด: ${waiting.map(directionText).join(', ')}`,
          h('br'), 'กด "คิวรอขุด" ที่แถบด้านบน แล้วคัดลอกคำสั่งไปวางในแชทกับ Claude'));
      }
      if (menu && menu.anchor === 'panel' && menu.nodeId === node.id) row.append(menuEl);
      return row.childNodes.length ? row : null;
    }

    function renderPanel() {
      const node = nodeOf(selectedId) ?? map.root;
      const same = panel.getAttribute('data-node') === node.id;
      const scroll = same ? panel.scrollTop : 0;
      const parts = node === map.root ? rootParts() : nodeParts(node);
      panel.replaceChildren(...[readingBar(), ...parts].filter(Boolean));
      panel.setAttribute('data-node', node.id);
      panel.scrollTop = scroll;
    }

    panel.addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.getAttribute('data-act');
      const node = nodeOf(selectedId);
      if (act === 'jump') jumpTo(btn.getAttribute('data-id'));
      else if (act === 'toggle' && node) {
        collapsed.set(node.id, !isCollapsed(node));
        refresh();
        if (!isCollapsed(node)) reveal(node.id);
      } else if (act === 'dig' && node) openMenu(node.id, 'panel');
      else if (act === 'read-start') goRead(C.readingNav(map, null, 1));
      else if (act === 'read-prev') goRead(C.readingNav(map, readingId, -1));
      else if (act === 'read-next') goRead(C.readingNav(map, readingId, 1));
      else if (act === 'read-exit') {
        readingId = null;
        refresh();
      }
    });

    // Reading mode: each stop is selected, revealed and highlighted.
    function goRead(id) {
      if (id === null || !index.has(id)) return;
      readingId = id;
      jumpTo(id);
    }

    // ---- the top bar ----

    function renderBar() {
      const items = localItems();
      const counts = C.queueCounts(map, [...items, ...accepted.values()]);
      statusEl.textContent = `กำลังขุด ${counts.researching}${SEP}รอคิว ${counts.pending}`;
      statusEl.classList.toggle('busy', counts.researching + counts.pending > 0);
      chipEl.textContent = `คิวรอขุด ${items.length}`;
      chipEl.hidden = items.length === 0;
      if (items.length === 0) queueOpen = false;
      chipEl.setAttribute('aria-expanded', String(queueOpen));
      drawerEl.hidden = !queueOpen;
      if (queueOpen) renderDrawer(items);
    }

    const copyNote = h('p', { class: 'dr-queue-msg', role: 'status' });
    let drawnItems = '';

    function renderDrawer(items) {
      const key = JSON.stringify(items);
      if (key === drawnItems && drawerEl.childNodes.length) return; // keep a shown command and its note
      drawnItems = key;
      copyNote.textContent = '';
      drawerEl.replaceChildren(
        h('div', { class: 'dr-queue-h' }, h('b', { text: `คิวรอขุด ${items.length} รายการ` }), h('span', { text: 'คำขอที่ยังไม่ได้ส่งให้ Claude' })),
        h('ul', null, items.map(item => h('li', null, h('b', { text: nodeOf(item.nodeId) ? titleOf(nodeOf(item.nodeId)) : item.nodeId }), ' ', h('span', { text: directionText(item) })))),
        h('div', { class: 'dr-queue-acts' },
          h('button', { type: 'button', class: 'kp-btn primary', 'data-q': 'copy' }, 'คัดลอกคำสั่ง'),
          h('button', { type: 'button', class: 'kp-btn', 'data-q': 'clear' }, 'ล้างคิว')),
        copyNote);
    }

    async function copyCommand() {
      const command = C.buildQueueCommand(slug, localItems());
      try {
        await navigator.clipboard.writeText(command);
        copyNote.textContent = 'คัดลอกแล้ว วางคำสั่งนี้ในแชทกับ Claude';
      } catch {
        // No clipboard here (or it refused): the command in a selected text box, ready for Ctrl+C.
        const area = h('textarea', { class: 'dr-copy', rows: 3, readonly: true, 'aria-label': 'คำสั่งสำหรับวางในแชทกับ Claude' });
        area.value = command;
        drawerEl.querySelector('textarea')?.remove();
        drawerEl.insertBefore(area, copyNote);
        copyNote.textContent = 'กด Ctrl+C เพื่อคัดลอก แล้ววางในแชทกับ Claude';
        area.focus();
        area.select();
      }
    }

    chipEl.addEventListener('click', () => {
      queueOpen = !queueOpen;
      renderBar();
    });
    drawerEl.addEventListener('click', e => {
      const btn = e.target.closest('button[data-q]');
      if (!btn) return;
      if (btn.getAttribute('data-q') === 'copy') {
        copyCommand();
        return;
      }
      storage.set(QUEUE_KEY, []);
      queueOpen = false;
      renderBar();
      renderPanel();
    });

    const layoutSeg = byId('dr-layout');
    layoutSeg.addEventListener('click', e => {
      const btn = e.target.closest('button[data-layout]');
      if (!btn) return;
      layoutMode = btn.getAttribute('data-layout') === 'right' ? 'right' : 'both';
      for (const b of layoutSeg.querySelectorAll('button')) {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      }
      update();
      fit();
    });
    const focusBtn = byId('dr-focus');
    focusBtn.addEventListener('click', () => {
      focusOn = !focusOn;
      focusBtn.classList.toggle('on', focusOn);
      focusBtn.setAttribute('aria-pressed', String(focusOn));
      update();
    });
    byId('dr-fit').addEventListener('click', () => fit());
    byId('dr-zoom-in').addEventListener('click', () => svg.transition().duration(250).call(zoom.scaleBy, 1.25));
    byId('dr-zoom-out').addEventListener('click', () => svg.transition().duration(250).call(zoom.scaleBy, 0.8));

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      closeMenu();
      if (queueOpen) {
        queueOpen = false;
        renderBar();
      }
    });
    window.addEventListener('resize', () => placeMenu());

    // ---- live mode ----

    // Takes in a newer map, keeping what the reader opened, selected and zoomed. A node that has just grown its first
    // children opens, so the new branches show.
    function applyMap(next) {
      const hadKids = new Map([...index].map(([id, entry]) => [id, hasKids(entry.node)]));
      map = next;
      reindex();
      for (const [id, { node }] of index) if (hadKids.get(id) === false && hasKids(node)) collapsed.set(id, false);
      const queued = new Set(list(map.queue).filter(isObj).map(item => item.id));
      for (const [id, request] of accepted) {
        const node = nodeOf(request.nodeId);
        const doneSince = node && (Date.parse(node.researchedAt) >= request.at
          || list(node.expansions).some(x => isObj(x) && Date.parse(x.at) >= request.at));
        if (queued.has(id) || !node || doneSince) accepted.delete(id);
      }
      if (!index.has(selectedId)) selectedId = map.root.id;
      if (readingId !== null && !index.has(readingId)) readingId = null;
      markFresh();
      busy = busyNodeIds();
      if (menu && !(nodeOf(menu.nodeId) && canDig(nodeOf(menu.nodeId)))) closeMenu();
      refresh();
    }

    let fetching = false;
    let fetchAgain = false;
    async function reload() {
      if (fetching) {
        fetchAgain = true;
        return;
      }
      fetching = true;
      try {
        const res = await fetch('/map.json', { cache: 'no-store' });
        if (res.ok) {
          const next = await res.json();
          if (isObj(next) && isObj(next.root)) applyMap(next);
        }
      } catch {
        // keep the map we have; the event stream shows when the server is gone
      } finally {
        fetching = false;
      }
      if (fetchAgain) {
        fetchAgain = false;
        reload();
      }
    }

    function listen() {
      if (typeof EventSource !== 'function') return;
      const events = new EventSource('/events');
      let lost = false;
      events.addEventListener('open', () => {
        offlineEl.hidden = true;
        if (lost) {
          lost = false;
          reload(); // map changes may have been missed while the stream was down
        }
      });
      events.addEventListener('error', () => {
        lost = true;
        offlineEl.hidden = false;
      });
      events.addEventListener('map', () => reload());
      events.addEventListener('queued', e => {
        let request = null;
        try {
          request = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!isObj(request) || typeof request.id !== 'string' || !isRequest(request)) return;
        if (list(map.queue).some(item => isObj(item) && item.id === request.id) || accepted.has(request.id)) return;
        accepted.set(request.id, { nodeId: request.nodeId, direction: request.direction, question: request.question, at: Date.now() });
        refresh();
      });
    }

    // ---- start ----

    byId('dr-legend').replaceChildren(
      ...S.ZONES.map(zone => h('span', { style: { '--c': zone.color }, text: zone.label })),
      h('span', { class: 'more', text: 'วงประ + = กดแล้วขุดลึกต่อได้' }),
      h('span', { class: 'plan', text: 'เส้นประ = วางแผนไว้ ยังไม่ได้ขุด' }));
    canvas.append(h('div', { class: 'dr-hint', text: HINT }), menuEl);
    reindex();
    markFresh();
    update({ animate: false });
    renderPanel();
    renderBar();
    fit(false);
    if (document.fonts && typeof document.fonts.addEventListener === 'function') {
      document.fonts.addEventListener('loadingdone', () => update()); // a font that came late changes the label widths
    }
    if (live) listen();
  }

  window.DRApp = { boot };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
