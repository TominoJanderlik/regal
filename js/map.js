// Mapa pracoviska: fotka (alebo schéma), zóny a sektory, body zásielok.
// Súradnice bodov sú 0..1 voči fotke → po zmene veľkosti okna, otočení mobilu
// alebo zoome sa vždy prepočítajú cez aktuálny getBoundingClientRect().
import { allSectors, centroid, displayPoint, AREA_LABELS, SCHEMATIC_SIZE, clamp01, pointInPoly } from './geometry.js';
import { SHELF_GROUPS } from './config.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TAP_SLOP = 7;
const MIN_S = 1, MAX_S = 8;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
}

export class MapView {
  constructor(root, handlers = {}) {
    this.root = root;
    this.h = handlers;
    this.s = 1; this.tx = 0; this.ty = 0;
    this.baseW = 1; this.baseH = 1;
    this.aspect = SCHEMATIC_SIZE.width / SCHEMATIC_SIZE.height;
    this.mode = 'view';
    this.data = { parcels: [], zones: null, photoUrl: null, selected: null, found: null };
    this.preview = null;
    this.calib = null; this.activeGroup = null;
    this.pointers = new Map();
    this.build();
    new ResizeObserver(() => this.layout()).observe(this.viewport);
  }

  build() {
    this.viewport = el('div', { class: 'map-viewport', tabindex: '0', 'aria-label': 'Mapa pracoviska. Kolieskom alebo dvoma prstami priblížiš.' });
    this.stage = el('div', { class: 'map-stage' });
    this.bg = el('img', { class: 'map-photo', alt: 'Fotka pracoviska', draggable: 'false' });
    this.bg.hidden = true;
    this.schematic = svg('svg', { class: 'map-schematic', viewBox: `0 0 ${SCHEMATIC_SIZE.width} ${SCHEMATIC_SIZE.height}`, preserveAspectRatio: 'none' });
    this.overlay = svg('svg', { class: 'map-overlay', preserveAspectRatio: 'none' });
    this.markers = el('div', { class: 'map-markers' });
    this.stage.append(this.schematic, this.bg, this.overlay, this.markers);
    this.viewport.append(this.stage);
    this.root.append(this.viewport);
    this.bg.addEventListener('load', () => {
      this.aspect = this.bg.naturalWidth / this.bg.naturalHeight || this.aspect;
      this.layout(true);
    });

    const v = this.viewport;
    v.addEventListener('pointerdown', (e) => this.onDown(e));
    v.addEventListener('pointermove', (e) => this.onMove(e));
    v.addEventListener('pointerup', (e) => this.onUp(e));
    v.addEventListener('pointercancel', (e) => this.onUp(e, true));
    v.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    v.addEventListener('dblclick', (e) => { if (this.mode === 'view') this.zoomAt(e.clientX, e.clientY, this.s * 1.8, true); });
    v.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this.zoomBy(1.4);
      else if (e.key === '-') this.zoomBy(1 / 1.4);
      else if (e.key === '0') this.fit();
      else if (e.key.startsWith('Arrow')) {
        const d = 40; this.tx += e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0;
        this.ty += e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0; this.apply(); e.preventDefault();
      }
    });
  }

  // ---------------------------------------------------------------- dáta
  setData(patch) {
    const photoChanged = 'photoUrl' in patch && patch.photoUrl !== this.data.photoUrl;
    Object.assign(this.data, patch);
    if (photoChanged) {
      if (this.data.photoUrl) { this.bg.src = this.data.photoUrl; this.bg.hidden = false; this.schematic.style.display = 'none'; }
      else { this.bg.removeAttribute('src'); this.bg.hidden = true; this.schematic.style.display = ''; this.aspect = SCHEMATIC_SIZE.width / SCHEMATIC_SIZE.height; this.layout(true); }
    }
    this.render();
  }

  setMode(mode, opts = {}) {
    this.mode = mode;
    this.viewport.dataset.mode = mode;
    this.preview = null;
    if (mode === 'calibrate') { this.calib = structuredClone(opts.zones); this.activeGroup = opts.active || 'A'; }
    else { this.calib = null; }
    this.render();
  }

  setPreview(p) { this.preview = p; this.renderMarkers(); }
  setActiveGroup(g) { this.activeGroup = g; this.renderOverlay(); }
  getCalibration() { return this.calib; }

  // ---------------------------------------------------------------- rozloženie a transformácia
  layout(resetView = false) {
    const r = this.viewport.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const prev = { w: this.baseW, h: this.baseH };
    this.vw = r.width; this.vh = r.height;
    this.baseW = Math.min(r.width, r.height * this.aspect);
    this.baseH = this.baseW / this.aspect;
    this.stage.style.width = `${this.baseW}px`;
    this.stage.style.height = `${this.baseH}px`;
    this.overlay.setAttribute('viewBox', `0 0 ${this.baseW} ${this.baseH}`);
    if (resetView || !this.laidOut) { this.fit(false); this.laidOut = true; }
    else {
      // zachováme rovnaký výrez po zmene veľkosti
      const k = this.baseW / prev.w || 1;
      this.tx *= k; this.ty *= k; this.clamp(); this.apply();
    }
    this.render();
  }

  fit(animate = true) {
    this.s = 1;
    this.tx = (this.vw - this.baseW) / 2;
    this.ty = (this.vh - this.baseH) / 2;
    this.apply(animate);
  }

  clamp() {
    const w = this.baseW * this.s, h = this.baseH * this.s;
    const minVisible = 0.35;
    if (w <= this.vw) this.tx = Math.min(Math.max(this.tx, -w * (1 - minVisible)), this.vw - w * minVisible);
    else this.tx = Math.min(Math.max(this.tx, this.vw - w), 0);
    if (h <= this.vh) this.ty = Math.min(Math.max(this.ty, -h * (1 - minVisible)), this.vh - h * minVisible);
    else this.ty = Math.min(Math.max(this.ty, this.vh - h - (this.padBottom || 0)), 0);   // rezerva pod kartou výsledku
  }

  apply(animate = false) {
    this.stage.classList.toggle('animate', Boolean(animate));
    this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`;
    this.stage.style.setProperty('--inv', String(1 / this.s));
    this.overlay.style.setProperty('--inv', String(1 / this.s));
    if (this.h.onZoom) this.h.onZoom(this.s);
    if (animate) { clearTimeout(this.animT); this.animT = setTimeout(() => this.stage.classList.remove('animate'), 480); }
  }

  zoomAt(cx, cy, newS, animate = false) {
    const r = this.viewport.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const s2 = Math.min(MAX_S, Math.max(MIN_S, newS));
    const wx = (px - this.tx) / this.s, wy = (py - this.ty) / this.s;
    this.tx = px - wx * s2; this.ty = py - wy * s2; this.s = s2;
    if (s2 === 1) { this.fit(animate); return; }
    this.clamp(); this.apply(animate);
  }
  zoomBy(f) { const r = this.viewport.getBoundingClientRect(); this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, this.s * f, true); }

  /** Priblíži a vycentruje bod (0..1). */
  focusOn([x, y], scale = 2.6, { padBottom = 0 } = {}) {
    this.padBottom = padBottom;
    this.s = Math.min(MAX_S, Math.max(MIN_S, scale));
    this.tx = this.vw / 2 - x * this.baseW * this.s;
    this.ty = (this.vh - padBottom) / 2 - y * this.baseH * this.s;
    this.clamp(); this.apply(true);
  }

  /** Klient (px) → súradnice 0..1 voči fotke. Spoľahlivé pri akomkoľvek zoome/veľkosti. */
  toNorm(cx, cy) {
    const r = this.stage.getBoundingClientRect();
    return [clamp01((cx - r.left) / r.width), clamp01((cy - r.top) / r.height)];
  }
  insideStage(cx, cy) {
    const r = this.stage.getBoundingClientRect();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  }

  // ---------------------------------------------------------------- ovládanie ukazovateľom
  onDown(e) {
    if (e.button !== undefined && e.button > 0) return;
    this.viewport.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), target: e.target });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      this.drag = null; this.panning = false; this.tapCancelled = true;
      return;
    }
    this.tapCancelled = false;
    this.panning = false;
    this.drag = null;
    const target = e.target.closest?.('[data-drag]');
    // presúvať sa dá IBA vybraná zásielka na stole / pred stolom → iná sa nechtiac nevyberie
    if (this.mode === 'view' && target?.dataset.drag === 'parcel') {
      this.drag = { kind: 'parcel', number: target.dataset.number, el: target, moved: false };
    } else if (this.mode === 'place' && target?.dataset.drag === 'preview') {
      this.drag = { kind: 'preview', el: target, moved: false };
    } else if (this.mode === 'calibrate' && target?.dataset.drag) {
      this.drag = { kind: target.dataset.drag, group: target.dataset.group, corner: Number(target.dataset.corner), start: this.toNorm(e.clientX, e.clientY), orig: structuredClone(this.calib.groups[target.dataset.group].quad), moved: false };
      this.activeGroup = target.dataset.group;
      this.h.onActiveGroup?.(this.activeGroup);
    }
  }

  onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > TAP_SLOP) this.tapCancelled = true;

    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      this.tx += cx - this.pinch.cx; this.ty += cy - this.pinch.cy;
      this.pinch.cx = cx; this.pinch.cy = cy;
      this.zoomAt(cx, cy, this.pinch.s * (d / this.pinch.d));
      return;
    }
    if (this.drag && this.tapCancelled) {
      const n = this.toNorm(e.clientX, e.clientY);
      this.drag.moved = true;
      if (this.drag.kind === 'parcel' || this.drag.kind === 'preview') {
        this.drag.el.style.left = `${n[0] * 100}%`;
        this.drag.el.style.top = `${n[1] * 100}%`;
        this.drag.el.classList.add('dragging');
        this.h.onDragHint?.(n);
      } else if (this.drag.kind === 'corner') {
        this.calib.groups[this.drag.group].quad[this.drag.corner] = n;
        this.renderOverlay();
      } else if (this.drag.kind === 'quad') {
        const ddx = n[0] - this.drag.start[0], ddy = n[1] - this.drag.start[1];
        this.calib.groups[this.drag.group].quad = this.drag.orig.map(([x, y]) => [clamp01(x + ddx), clamp01(y + ddy)]);
        this.renderOverlay();
      }
      return;
    }
    if (this.tapCancelled && this.pointers.size === 1) {
      this.panning = true;
      this.tx += dx; this.ty += dy; this.clamp(); this.apply();
    }
  }

  onUp(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!p) return;
    const wasTap = !cancelled && !this.tapCancelled && performance.now() - p.t < 700 && this.pointers.size === 0;
    const drag = this.drag;
    this.drag = null;

    if (drag?.moved && !cancelled) {
      const n = this.toNorm(e.clientX, e.clientY);
      if (drag.kind === 'parcel') { drag.el.classList.remove('dragging'); this.h.onMove?.(drag.number, n); }
      else if (drag.kind === 'preview') { drag.el.classList.remove('dragging'); this.h.onPlace?.(n); }
      else if (drag.kind === 'corner' || drag.kind === 'quad') this.h.onCalibrate?.(this.calib);
      return;
    }
    if (drag && cancelled) { this.renderMarkers(); return; }
    if (!wasTap) return;

    // pri pointer capture je e.target celý viewport → použijeme pôvodný cieľ stlačenia
    const markerEl = p.target?.closest?.('.marker');
    if (this.mode === 'place') {
      if (this.insideStage(e.clientX, e.clientY)) this.h.onPlace?.(this.toNorm(e.clientX, e.clientY));
    } else if (this.mode === 'view') {
      if (markerEl?.dataset.numbers) this.h.onSelect?.(markerEl.dataset.numbers.split(','), markerEl.dataset.key);
    } else if (this.mode === 'calibrate') {
      const n = this.toNorm(e.clientX, e.clientY);
      const hit = Object.entries(this.calib.groups).find(([, g]) => pointInPoly(n, g.quad));
      if (hit) { this.activeGroup = hit[0]; this.h.onActiveGroup?.(hit[0]); this.renderOverlay(); }
    }
  }

  onWheel(e) {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    this.zoomAt(e.clientX, e.clientY, this.s * f);
  }

  // ---------------------------------------------------------------- vykresľovanie
  render() {
    this.renderSchematic();
    this.renderOverlay();
    this.renderMarkers();
  }

  zonesForDraw() { return this.calib || this.data.zones; }

  renderSchematic() {
    if (this.data.photoUrl) return;
    const z = this.zonesForDraw();
    if (!z) return;
    const W = SCHEMATIC_SIZE.width, H = SCHEMATIC_SIZE.height;
    const g = this.schematic;
    g.replaceChildren();
    g.append(svg('rect', { x: 0, y: 0, width: W, height: H, class: 'sch-floor' }));
    for (let x = 0; x <= W; x += 80) g.append(svg('line', { x1: x, y1: 0, x2: x, y2: H, class: 'sch-grid' }));
    for (let y = 0; y <= H; y += 80) g.append(svg('line', { x1: 0, y1: y, x2: W, y2: y, class: 'sch-grid' }));
    const poly = (q, cls) => svg('polygon', { points: q.map(([x, y]) => `${x * W},${y * H}`).join(' '), class: cls });
    for (const [k, grp] of Object.entries(z.groups)) {
      g.append(poly(grp.quad, `sch-block sch-${SHELF_GROUPS[k] ? 'shelf' : k}`));
    }
  }

  renderOverlay() {
    const z = this.zonesForDraw();
    const o = this.overlay;
    o.replaceChildren();
    if (!z) return;
    const W = this.baseW, H = this.baseH;
    const pts = (q) => q.map(([x, y]) => `${x * W},${y * H}`).join(' ');
    const counts = {};
    for (const p of this.data.parcels) {
      const k = p.location === 'shelf' ? p.sector : p.location;
      counts[k] = (counts[k] || 0) + 1;
    }
    const selSector = this.data.found?.location === 'shelf' ? this.data.found.sector : null;
    const selArea = this.data.found && this.data.found.location !== 'shelf' ? this.data.found.location : null;

    for (const [name, grp] of Object.entries(z.groups)) {
      if (SHELF_GROUPS[name]) continue;
      const c = centroid(grp.quad);
      o.append(svg('polygon', { points: pts(grp.quad), class: `zone zone-${name}${selArea === name ? ' is-found' : ''}` }));
      const label = svg('text', { x: c[0] * W, y: grp.quad[0][1] * H + 14, class: `zone-label zone-label-${name}`, 'text-anchor': 'middle' });
      label.textContent = AREA_LABELS[name];
      if (name !== 'allegro') o.append(label);
      else {
        const al = svg('text', { x: c[0] * W, y: c[1] * H, class: 'zone-label zone-label-allegro', 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
        al.textContent = 'Allegro';
        o.append(al);
      }
    }
    for (const s of allSectors(z)) {
      const c = centroid(s.poly);
      const has = counts[s.sector] || 0;
      o.append(svg('polygon', { points: pts(s.poly), class: `sector${has ? ' has' : ''}${selSector === s.sector ? ' is-found' : ''}` }));
      const t = svg('text', { x: c[0] * W, y: c[1] * H, class: 'sector-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      t.textContent = s.sector;
      o.append(t);
    }

    if (this.mode === 'calibrate' && this.calib) {
      for (const [name, grp] of Object.entries(this.calib.groups)) {
        const active = name === this.activeGroup;
        o.append(svg('polygon', { points: pts(grp.quad), class: `calib-quad${active ? ' active' : ''}`, 'data-drag': active ? 'quad' : null, 'data-group': name }));
        if (!active) continue;
        grp.quad.forEach(([x, y], i) => {
          o.append(svg('circle', { cx: x * W, cy: y * H, r: 11 / this.s, class: 'calib-handle', 'data-drag': 'corner', 'data-group': name, 'data-corner': i }));
        });
        const c = centroid(grp.quad);
        const tl = svg('text', { x: c[0] * W, y: c[1] * H, class: 'calib-name', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        tl.textContent = SHELF_GROUPS[name] ? `Polica ${name}` : AREA_LABELS[name];
        o.append(tl);
      }
    }
  }

  renderMarkers() {
    const m = this.markers;
    m.replaceChildren();
    const z = this.data.zones;
    if (!z || this.mode === 'calibrate') return;
    const groups = new Map();
    for (const p of this.data.parcels) {
      const key = p.location === 'shelf' ? `s:${p.sector}` : p.location === 'allegro' ? 'allegro' : `p:${p.tracking_number}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const sel = this.data.selected;
    const found = this.data.found?.tracking_number;
    for (const [key, list] of groups) {
      const p0 = list[0];
      const [x, y] = displayPoint(p0, z);
      const isSel = list.some((p) => p.tracking_number === sel);
      const isFound = list.some((p) => p.tracking_number === found);
      const single = list.length === 1;
      const draggable = this.mode === 'view' && single && isSel && (p0.location === 'table' || p0.location === 'front');
      const label = single ? p0.tracking_number.slice(-4) : String(list.length);
      const b = el('button', {
        class: `marker loc-${p0.location}${isSel ? ' selected' : ''}${isFound ? ' found' : ''}${single ? '' : ' cluster'}${list.some((p) => p._pending) ? ' pending' : ''}${single && p0.package_type === 'bag' ? ' bag' : ''}${draggable ? ' draggable' : ''}`,
        type: 'button',
        style: `left:${x * 100}%;top:${y * 100}%`,
        'data-numbers': list.map((p) => p.tracking_number).join(','),
        'data-key': key,
        'data-drag': draggable ? 'parcel' : null,
        'data-number': draggable ? p0.tracking_number : null,
        'aria-label': single ? `Zásielka ${p0.tracking_number}` : `${list.length} zásielky v ${p0.location === 'allegro' ? 'Allegro polici' : p0.sector}`,
        tabindex: this.mode === 'view' ? '0' : '-1',
      }, el('span', { class: 'marker-dot' }, el('span', { class: 'marker-text', text: label })));
      if (isFound) b.append(el('span', { class: 'marker-ring', 'aria-hidden': 'true' }));
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.h.onSelect?.(list.map((p) => p.tracking_number), key); } });
      m.append(b);
    }
    if (this.preview && this.mode === 'place') {
      const [x, y] = this.preview.point;
      m.append(el('div', {
        class: `marker preview loc-${this.preview.location}`, style: `left:${x * 100}%;top:${y * 100}%`,
        'data-drag': this.preview.location === 'table' || this.preview.location === 'front' ? 'preview' : null,
      }, el('span', { class: 'marker-dot' }, el('span', { class: 'marker-text', text: this.preview.label || '' }))));
    }
  }
}
