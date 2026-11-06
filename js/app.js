import * as store from './store.js';
import * as auth from './auth.js';
import { MapView } from './map.js';
import { Scanner, cameraPermissionState } from './scanner.js';
import { VideoWorkshop } from './video.js';
import { parseImportFile } from './importer.js';
import { recognize, normalize, formatNumber, getCustomFormats, saveCustomFormats } from './tracking.js';
import { locate, defaultZones, displayPoint, AREA_LABELS } from './geometry.js';
import { getConfig, saveConfig, LOCATIONS, PACKAGE_TYPES, APP_VERSION, SHELF_GROUPS, DEFAULT_PHOTO } from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeFmt = new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

const state = {
  filter: 'all',
  query: '',
  selected: null,        // vybraná zásielka (číslo)
  found: null,           // zásielka zobrazená vo výsledku
  verify: null,          // { state, at }
  missing: null,         // číslo, ktoré sa nenašlo
  place: null,           // { label, resolve, preview, allowAllegro }
  calibGroup: 'A',
  searchSeq: 0,
};

let map, scanner, workshop, deferredInstall = null;

// ======================================================================= štart
async function start() {
  registerServiceWorker();
  // skutočná výška hlavičky (na mobile má dva riadky) → presné rozmery mapy
  const header = $('.top');
  new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', `${header.offsetHeight}px`)).observe(header);
  bindStatic();
  map = new MapView($('#map'), {
    onSelect: (numbers) => onMapSelect(numbers),
    onPlace: (pt) => onPlaceTap(pt),
    onMove: (number, pt) => onMarkerMoved(number, pt),
    onZoom: (s) => { $('#zoom-level').textContent = `${Math.round(s * 100)} %`; },
    onCalibrate: () => {},
    onActiveGroup: (g) => { state.calibGroup = g; renderCalibBar(); },
    onDragHint: () => {},
  });
  scanner = new Scanner($('#scanner-dialog'));
  workshop = new VideoWorkshop($('#video-dialog'), {
    store,
    getZones: () => store.getZones(),
    toast,
    requestPlacement: (label) => requestPlacement(label, { allowAllegro: true }),
  });

  await store.init();
  store.on('change', onDataChange);
  store.on('status', renderSync);
  store.on('notice', (n) => toast(n.text, n.kind === 'error' ? 'error' : ''));
  auth.onSessionChange(() => { renderSync(store.getStatus()); store.requestSync(0); });

  renderAll();
  renderSync(store.getStatus());

  if (!getConfig().supabaseUrl) openSetup();
  else if (!auth.getSession()) setTimeout(() => openLogin(), 300);
  store.syncNow({ full: true });

  // klávesové skratky: „/“ alebo Ctrl+K = hľadať
  document.addEventListener('keydown', (e) => {
    if ((e.key === '/' && !isTyping(e.target)) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault(); $('#q').focus(); $('#q').select();
    }
    if (e.key === 'Escape' && state.place && !document.querySelector('dialog[open]')) cancelPlacement();
  });
}

function isTyping(t) { return t && (t.closest('input, textarea, select, [contenteditable="true"]')); }

// ======================================================================= väzby
function bindStatic() {
  const q = $('#q');
  let pasted = false, debounce;
  q.addEventListener('paste', () => { pasted = true; });
  q.addEventListener('input', (e) => {
    clearTimeout(debounce);
    if (pasted || e.inputType === 'insertFromPaste' || e.inputType === 'insertReplacementText') {
      pasted = false;
      runSearch(q.value, { exactOnly: false });     // vloženie (Ctrl+V) hľadá okamžite
    } else {
      debounce = setTimeout(() => runSearch(q.value), 260);
    }
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(debounce); runSearch(q.value); }
    if (e.key === 'Escape') { q.value = ''; runSearch(''); }
  });
  q.addEventListener('search', () => { if (!q.value) runSearch(''); });

  // Ctrl+V kdekoľvek na stránke (mimo polí) → hľadanie
  document.addEventListener('paste', (e) => {
    if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
    const text = e.clipboardData?.getData('text');
    if (!text || !text.trim()) return;
    e.preventDefault();
    q.value = text.trim();
    runSearch(q.value);
  });

  $('#scan-search').addEventListener('click', async () => {
    const n = await scanner.scan('Naskenuj zásielku, ktorú hľadáš');
    if (n) { q.value = n; runSearch(n); }
  });
  $('#add-btn').addEventListener('click', () => openAdd());
  $('#menu-btn').addEventListener('click', () => openSettings());
  $('#sync-pill').addEventListener('click', onSyncPill);
  $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const z = b.dataset.zoom;
    if (z === 'in') map.zoomBy(1.5); else if (z === 'out') map.zoomBy(1 / 1.5); else map.fit();
  }));
  $('[data-open-photo]').addEventListener('click', () => pickPhoto());
  $('[data-edit-zones]').addEventListener('click', () => { if (state.place) cancelPlacement(); startCalibration(state.calibGroup === 'A' ? 'table' : state.calibGroup); });

  $$('.bottom-nav [data-nav]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.nav;
    if (a === 'search') { $('#q').focus({ preventScroll: false }); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (a === 'list') $('.side').scrollIntoView({ behavior: 'smooth' });
    if (a === 'scan-add') {
      const n = await scanner.scan('Naskenuj novú zásielku');
      if (n) openAdd(n);
    }
  }));

  // zatváranie dialógov
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog.sheet').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  bindAddForm();
  bindEditForm();
  bindPlaceBar();
  bindCalibBar();
  bindLogin();
  bindSetup();
  bindSettingsFiles();

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
  window.addEventListener('appinstalled', () => { deferredInstall = null; toast('Regál je nainštalovaný.'); });
}

// ======================================================================= dáta → UI
function onDataChange(info) {
  // nájdená zásielka mohla zmiznúť (vydaná na inom zariadení) alebo sa zmeniť
  if (state.found) {
    const fresh = store.getParcel(state.found.tracking_number);
    if (!fresh && info.source !== 'verify') {
      if (info.released !== state.found.tracking_number) toast(`Zásielka ${state.found.tracking_number} už nie je v evidencii (vydaná inde).`);
      clearFound();
    } else if (fresh) state.found = fresh;
  }
  renderAll();
}

function renderAll() {
  renderFilters();
  renderList();
  const photo = store.getPhotoUrl() || DEFAULT_PHOTO || null;
  map.setData({
    parcels: store.allParcels(),
    zones: store.getZones(),
    photoUrl: photo,
    selected: state.selected,
    found: state.found,
  });
  $('#no-photo').hidden = Boolean(photo) || Boolean(state.found) || Boolean(state.place);
  renderResult();
}

function locText(p) {
  if (p.location === 'shelf') return `Polica ${p.sector}`;
  return LOCATIONS[p.location]?.label || p.location;
}

function renderFilters() {
  const c = store.counts();
  const items = [['all', 'Všetky', c.all], ['table', 'Stôl', c.table], ['front', 'Pred stolom', c.front], ['shelf', 'Police', c.shelf], ['allegro', 'Allegro', c.allegro]];
  $('#filters').innerHTML = items.map(([k, label, n]) =>
    `<button type="button" data-filter="${k}" aria-pressed="${state.filter === k}">${label} <b>${n || 0}</b></button>`).join('');
  $$('#filters button').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderFilters(); renderList(); }));
}

function renderList() {
  let list = store.allParcels();
  if (state.filter !== 'all') list = list.filter((p) => p.location === state.filter);
  const q = normalize(state.query);
  if (q && q.length >= 3 && !store.getParcel(q)) list = list.filter((p) => p.tracking_number.includes(q));
  const ul = $('#list');
  if (!list.length) {
    const any = store.allParcels().length;
    ul.innerHTML = `<li class="empty">${any ? 'V tomto filtri nie je žiadna zásielka.' : 'Zatiaľ tu nie je žiadna zásielka.'}
      ${any ? '' : '<br><button type="button" class="btn primary" data-empty-add>Pridať prvú zásielku</button>'}</li>`;
    $('[data-empty-add]', ul)?.addEventListener('click', () => openAdd());
    return;
  }
  ul.innerHTML = list.slice(0, 500).map((p) => `
    <li><button type="button" class="prow" data-n="${esc(p.tracking_number)}" aria-current="${state.selected === p.tracking_number}">
      <span class="bar loc-${p.location}"></span>
      <span class="num">${esc(formatNumber(p.tracking_number))}</span>
      <span class="tag">${p.location === 'shelf' ? esc(p.sector) : ''}</span>
      <span class="where">${esc(locText(p))} · ${PACKAGE_TYPES[p.package_type]?.label || 'Krabica'}${p._pending ? ' · <span class="pend">čaká na odoslanie</span>' : ''}</span>
    </button></li>`).join('');
  $$('.prow', ul).forEach((b) => b.addEventListener('click', () => {
    const p = store.getParcel(b.dataset.n);
    if (p) { showFound(p); if (matchMedia('(max-width: 899px)').matches) $('.map-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }));
}

// ======================================================================= hľadanie
async function runSearch(raw, opts = {}) {
  const seq = ++state.searchSeq;
  state.query = raw;
  const n = normalize(raw);
  state.missing = null;
  if (!n) { clearFound(); renderList(); return; }
  const local = store.getParcel(n);
  if (local) {
    showFound(local, { verify: true });
    return;
  }
  clearFound(false);
  renderList();
  if (n.length < 5) { renderResult(); return; }
  // lokálne nie je → overíme v databáze (cache môže byť neaktuálna)
  state.missing = { number: n, checking: true };
  renderResult();
  const res = await store.verifyParcel(n);
  if (seq !== state.searchSeq) return;
  if (res.parcel && res.state !== 'missing') { state.missing = null; showFound(res.parcel, { verify: false, verifyState: res.state }); return; }
  state.missing = { number: n, checking: false, offline: res.state === 'offline' || res.state === 'unverified' };
  renderResult();
}

function showFound(p, { verify = true, verifyState = null, focus = true } = {}) {
  state.found = p;
  state.selected = p.tracking_number;
  state.missing = null;
  state.verify = verifyState ? { state: verifyState, at: Date.now() } : { state: 'checking' };
  renderAll();
  if (focus) {
    // na mobile karta výsledku prekrýva spodok mapy → zásielku centrujeme do viditeľnej časti nad ňou
    // na počítači je karta vpravo hore → zásielku centrujeme do voľnej časti vľavo od nej
    const card = $('#result');
    const mobile = matchMedia('(max-width: 899px)').matches;
    const padBottom = mobile && !card.hidden ? card.offsetHeight + 12 : 0;
    const padRight = !mobile && !card.hidden ? card.offsetWidth + 24 : 0;
    map.focusOn(displayPoint(p, store.getZones()), p.location === 'shelf' || p.location === 'allegro' ? 2.2 : 2.8, { padBottom, padRight });
  }
  if (verify) {
    const seq = state.searchSeq;
    store.verifyParcel(p.tracking_number).then((res) => {
      if (state.found?.tracking_number !== p.tracking_number || seq !== state.searchSeq) return;
      if (res.state === 'missing') {
        state.found = null; state.selected = null;
        state.missing = { number: p.tracking_number, checking: false, wasLocal: true };
        renderAll();
        return;
      }
      state.verify = { state: res.state, at: Date.now() };
      if (res.parcel) state.found = res.parcel;
      renderAll();
    });
  }
}

function clearFound(render = true) {
  map.padBottom = 0;
  map.padRight = 0;
  state.found = null; state.selected = null; state.verify = null;
  if (render) renderAll();
}

function renderResult() {
  const box = $('#result');
  if (state.place) { box.hidden = true; return; }
  const p = state.found;
  if (!p && !state.missing) { box.hidden = true; return; }
  box.hidden = false;

  if (!p) {
    const m = state.missing;
    const partial = store.allParcels().filter((x) => x.tracking_number.includes(m.number) || m.number.includes(x.tracking_number.slice(-6))).slice(0, 4);
    box.innerHTML = `
      <button type="button" class="icon-btn result-close" data-res-close aria-label="Zavrieť">✕</button>
      <div class="res-empty">
        <p class="res-number">${esc(formatNumber(m.number))}</p>
        <p>${m.checking ? 'Overujem v databáze…' : m.wasLocal ? 'Zásielka v databáze už nie je – pravdepodobne bola vydaná na inom zariadení.' : m.offline ? 'Lokálne sa nenašla a databázu sa teraz nedá overiť (offline alebo neprihlásený).' : 'Táto zásielka nie je v evidencii.'}</p>
        ${partial.length ? `<p class="muted">Podobné čísla:</p><div class="suggest">${partial.map((x) => `<button type="button" class="btn small" data-pick="${esc(x.tracking_number)}">${esc(formatNumber(x.tracking_number))}</button>`).join('')}</div>` : ''}
        ${m.checking ? '' : `<div class="actions"><button type="button" class="btn primary" data-add-this>Pridať túto zásielku</button></div>`}
      </div>`;
    $('[data-res-close]', box).addEventListener('click', () => { state.missing = null; renderResult(); });
    $$('[data-pick]', box).forEach((b) => b.addEventListener('click', () => { $('#q').value = b.dataset.pick; runSearch(b.dataset.pick); }));
    $('[data-add-this]', box)?.addEventListener('click', () => openAdd(m.number));
    return;
  }

  const v = state.verify || { state: 'checking' };
  const verifyText = {
    checking: 'Overujem v databáze…',
    verified: `Overené v databáze ${timeFmt.format(new Date(v.at || Date.now()))}`,
    pending: 'Uložené v tomto zariadení, čaká na odoslanie',
    offline: 'Bez spojenia – údaj z poslednej synchronizácie',
    unverified: 'Neoverené – prihlás sa pre synchronizáciu',
  }[v.state] || '';
  const carrier = recognize(p.tracking_number, { strict: true }).carrier;
  const big = p.location === 'shelf' ? p.sector : p.location === 'allegro' ? 'Allegro' : p.location === 'table' ? 'Stôl' : 'Pred stolom';
  const where = p.location === 'shelf' ? 'Polica, sektor' : p.location === 'allegro' ? 'Fialová polica' : p.location === 'table' ? 'Pracovný stôl' : 'Na zemi';
  const movable = p.location === 'table' || p.location === 'front';
  box.innerHTML = `
    <button type="button" class="icon-btn result-close" data-res-close aria-label="Zavrieť">✕</button>
    <div class="res-head">
      <div class="res-number">${esc(formatNumber(p.tracking_number))}</div>
      ${carrier ? `<div class="res-carrier">${esc(carrier)}</div>` : ''}
    </div>
    <div class="res-place${p.location === 'allegro' ? ' allegro' : ''}">
      <span class="big">${esc(big)}</span><span class="where">${esc(where)}</span>
    </div>
    <div class="res-meta">
      <span class="chip">${PACKAGE_TYPES[p.package_type]?.label || 'Krabica'}</span>
      ${p.is_allegro ? '<span class="chip allegro">Allegro</span>' : ''}
      ${p.created_at ? `<span class="chip">Pridaná ${esc(dateFmt.format(new Date(p.created_at)))}</span>` : ''}
    </div>
    ${p.note ? `<p class="res-note">${esc(p.note)}</p>` : ''}
    <div class="res-state" data-state="${v.state}" role="status">${esc(verifyText)}</div>
    <div class="res-actions">
      <button type="button" class="btn danger release-btn" data-release>Vydaj zásielku</button>
      <button type="button" class="btn" data-move>Presunúť</button>
      <button type="button" class="btn" data-edit>Upraviť</button>
    </div>
    ${movable ? '<p class="res-hint">Bod na mape môžeš aj priamo potiahnuť na nové miesto.</p>' : ''}`;
  $('[data-res-close]', box).addEventListener('click', () => clearFound());
  $('[data-release]', box).addEventListener('click', (e) => release(p.tracking_number, e.currentTarget));
  $('[data-move]', box).addEventListener('click', () => movePrompt(p));
  $('[data-edit]', box).addEventListener('click', () => openEdit(p));
}

// ======================================================================= vydanie
async function release(number, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Vydávam…';
  const removed = await store.releaseParcel(number);
  if (!removed) return;
  clearFound();
  $('#q').value = '';
  state.query = '';
  renderList();
  toast(`Vydané: ${formatNumber(number)}`, '', {
    label: 'Späť',
    fn: async () => {
      const { _pending, _verified_at, server_updated_at, ...rest } = removed;
      const restored = await store.saveParcel(rest);
      showFound(restored, { verify: false, verifyState: 'pending', focus: false });
    },
  });
}

// ======================================================================= mapa: výber / presun
function onMapSelect(numbers) {
  if (numbers.length === 1) {
    const p = store.getParcel(numbers[0]);
    if (p) showFound(p, { focus: false });
    return;
  }
  const d = $('#cluster-dialog');
  const list = numbers.map((n) => store.getParcel(n)).filter(Boolean);
  const first = list[0];
  $('#cluster-title').textContent = first?.location === 'allegro' ? `Allegro polica (${list.length})` : `Sektor ${first?.sector} (${list.length})`;
  const ul = $('[data-cluster-list]', d);
  ul.innerHTML = list.map((p) => `<li><button type="button" class="prow" data-n="${esc(p.tracking_number)}"><span class="bar loc-${p.location}"></span><span class="num">${esc(formatNumber(p.tracking_number))}</span><span class="tag"></span><span class="where">${PACKAGE_TYPES[p.package_type]?.label}${p.note ? ` · ${esc(p.note)}` : ''}</span></button></li>`).join('');
  $$('.prow', ul).forEach((b) => b.addEventListener('click', () => { d.close(); showFound(store.getParcel(b.dataset.n), { focus: false }); }));
  d.showModal();
}

async function onMarkerMoved(number, pt) {
  const p = store.getParcel(number);
  if (!p) return;
  const loc = locate(pt, store.getZones());
  if (!loc) { toast('Toto miesto nie je v žiadnej zóne – poloha sa nezmenila.', 'error'); renderAll(); return; }
  if (loc.location === 'allegro') { toast('Na Allegro policu patria iba Allegro zásielky. Zapni Allegro v úprave zásielky.', 'error'); renderAll(); return; }
  const before = { location: p.location, sector: p.sector, x: p.x, y: p.y };
  const saved = await store.saveParcel({ ...p, location: loc.location, sector: loc.sector, x: loc.point[0], y: loc.point[1] });
  state.found = saved;
  renderAll();
  toast(`Presunuté: ${locText(saved)}`, '', {
    label: 'Späť',
    fn: async () => { const back = await store.saveParcel({ ...store.getParcel(number), ...before }); state.found = back; renderAll(); },
  });
}

async function movePrompt(p) {
  if (p.location === 'allegro') { openEdit(p); toast('Allegro zásielka je vždy na Allegro polici. Ak to nie je Allegro, vypni ho v úprave.'); return; }
  const loc = await requestPlacement(p.tracking_number, { allowAllegro: false });
  if (!loc) return;
  const saved = await store.saveParcel({ ...store.getParcel(p.tracking_number), location: loc.location, sector: loc.sector, x: loc.x, y: loc.y });
  showFound(saved, { verify: false, verifyState: 'pending', focus: false });
  toast(`Presunuté: ${locText(saved)}`);
}

// ======================================================================= výber miesta na mape
function requestPlacement(label, { allowAllegro = false } = {}) {
  if (state.place) state.place.resolve(null);
  return new Promise((resolve) => {
    state.place = { label, resolve, preview: null, allowAllegro };
    map.setMode('place');
    $('#place-bar').hidden = false;
    $('#place-bar').dataset.kind = '';
    $('[data-place-text]').innerHTML = `Ťukni na miesto zásielky <b>${esc(formatNumber(label))}</b> – na policu, stôl alebo pred stôl.`;
    $('[data-place-confirm]').disabled = true;
    renderAll();
    map.fit();      // celé pracovisko na očiach – výber miesta jedným ťuknutím
    $('.map-viewport').focus({ preventScroll: true });
  });
}

function onPlaceTap(pt) {
  if (!state.place) return;
  const loc = locate(pt, store.getZones());
  const bar = $('#place-bar');
  if (!loc) {
    bar.dataset.kind = 'warn';
    $('[data-place-text]').textContent = 'Toto miesto nie je v žiadnej zóne. Ťukni na policu, stôl alebo priestor pred stolom.';
    return;
  }
  if (loc.location === 'allegro' && !state.place.allowAllegro) {
    bar.dataset.kind = 'warn';
    $('[data-place-text]').textContent = 'Allegro polica je iba pre Allegro zásielky – zapni prepínač Allegro vo formulári.';
    return;
  }
  bar.dataset.kind = '';
  const label = loc.location === 'shelf' ? loc.sector : loc.location === 'allegro' ? 'Allegro' : AREA_LABELS[loc.location];
  state.place.preview = { location: loc.location, sector: loc.sector, point: loc.point, label };
  map.setPreview(state.place.preview);
  const drag = loc.location === 'table' || loc.location === 'front';
  $('[data-place-text]').innerHTML = `Miesto: <b>${esc(loc.location === 'shelf' ? `Polica ${loc.sector}` : LOCATIONS[loc.location].label)}</b>${drag ? ' · bod môžeš doladiť potiahnutím' : ''}`;
  $('[data-place-confirm]').disabled = false;
}

function finishPlacement(result) {
  const pl = state.place;
  state.place = null;
  map.setMode('view');
  $('#place-bar').hidden = true;
  renderAll();
  pl?.resolve(result);
}
function cancelPlacement() { finishPlacement(null); }

function bindPlaceBar() {
  $('[data-place-cancel]').addEventListener('click', cancelPlacement);
  $('[data-place-confirm]').addEventListener('click', () => {
    const pv = state.place?.preview;
    if (!pv) return;
    finishPlacement({ location: pv.location, sector: pv.sector, x: pv.point[0], y: pv.point[1] });
  });
}

// ======================================================================= pridanie
let addNeedsConfirm = null;
function openAdd(prefill = '') {
  const d = $('#add-dialog');
  const f = $('#add-form');
  f.reset();                         // „Krabica“ je predvolene zaškrtnutá
  f.number.value = prefill ? normalize(prefill) : '';
  addNeedsConfirm = null;
  setMsg($('[data-number-msg]'), '');
  updateAddSubmit();
  d.showModal();
  if (prefill) validateAddNumber();
  setTimeout(() => (prefill ? f.package_type[0] : f.number).focus({ preventScroll: true }), 50);
}

function setMsg(el, text, kind = '') { el.textContent = text; el.dataset.kind = kind; }

function validateAddNumber() {
  const f = $('#add-form');
  const raw = f.number.value;
  if (!raw.trim()) { setMsg($('[data-number-msg]'), ''); return null; }
  const rec = recognize(raw, { strict: false });
  if (!rec.ok) { setMsg($('[data-number-msg]'), rec.reason, 'error'); return null; }
  const ex = store.getParcel(rec.number);
  if (ex) setMsg($('[data-number-msg]'), `Už je v evidencii (${locText(ex)}). Uložením ju presunieš.`, 'warn');
  else if (rec.needsConfirm) setMsg($('[data-number-msg]'), 'Neznámy formát čísla – skontroluj ho. Pri uložení ho potvrdíš.', 'warn');
  else setMsg($('[data-number-msg]'), rec.carrier ? `Rozpoznané: ${rec.carrier}` : '', 'ok');
  return rec;
}

function updateAddSubmit() {
  const f = $('#add-form');
  $('[data-add-submit]').textContent = f.allegro.checked ? 'Uložiť na Allegro policu' : 'Vybrať miesto na mape';
}

function bindAddForm() {
  const f = $('#add-form');
  f.number.addEventListener('input', () => { addNeedsConfirm = null; validateAddNumber(); });
  f.number.addEventListener('paste', () => setTimeout(validateAddNumber, 0));
  f.allegro.addEventListener('change', updateAddSubmit);
  $('[data-scan-add]').addEventListener('click', async () => {
    const d = $('#add-dialog');
    d.close();
    const n = await scanner.scan('Naskenuj novú zásielku');
    d.showModal();
    if (n) { f.number.value = n; validateAddNumber(); f.package_type[0].focus({ preventScroll: true }); }
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rec = validateAddNumber();
    if (!rec) { f.number.focus(); if (!f.number.value.trim()) setMsg($('[data-number-msg]'), 'Zadaj alebo naskenuj číslo zásielky.', 'error'); return; }
    if (rec.needsConfirm && addNeedsConfirm !== rec.number) {
      addNeedsConfirm = rec.number;
      setMsg($('[data-number-msg]'), `Číslo ${rec.number} nemá známy formát. Ak je správne, stlač tlačidlo ešte raz.`, 'warn');
      return;
    }
    const data = {
      tracking_number: rec.number,
      package_type: f.package_type.value || 'box',   // predvolená hodnota sa uloží vždy
      note: f.note.value,
    };
    $('#add-dialog').close();
    if (f.allegro.checked) {
      const saved = await store.saveParcel({ ...data, location: 'allegro', sector: null, x: null, y: null });
      afterSave(saved);
      return;
    }
    const loc = await requestPlacement(rec.number, { allowAllegro: false });
    if (!loc) { toast('Pridanie zrušené – zásielka nebola uložená.'); return; }
    const saved = await store.saveParcel({ ...data, ...loc });
    afterSave(saved);
  });
}

function afterSave(saved) {
  // bez skoku stránky: iba označíme zásielku na mape a ukážeme kartu
  showFound(saved, { verify: false, verifyState: 'pending', focus: false });
  toast(`Uložené: ${formatNumber(saved.tracking_number)} · ${locText(saved)}`, '', { label: 'Pridať ďalšiu', fn: () => openAdd() });
}

// ======================================================================= úprava
function openEdit(p) {
  const f = $('#edit-form');
  f.dataset.n = p.tracking_number;
  f.number.value = p.tracking_number;
  f.package_type.value = p.package_type || 'box';
  f.allegro.checked = p.location === 'allegro';
  f.note.value = p.note || '';
  setMsg($('[data-edit-msg]'), '');
  $('#edit-dialog').showModal();
}

function bindEditForm() {
  const f = $('#edit-form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const old = store.getParcel(f.dataset.n);
    if (!old) { $('#edit-dialog').close(); return; }
    const rec = recognize(f.number.value, { strict: false });
    if (!rec.ok) { setMsg($('[data-edit-msg]'), rec.reason, 'error'); return; }
    if (rec.number !== old.tracking_number && store.getParcel(rec.number)) {
      setMsg($('[data-edit-msg]'), 'Zásielka s týmto číslom už existuje.', 'error'); return;
    }
    $('#edit-dialog').close();
    let patch = { package_type: f.package_type.value || 'box', note: f.note.value };
    if (f.allegro.checked && old.location !== 'allegro') patch = { ...patch, location: 'allegro', sector: null, x: null, y: null };
    if (!f.allegro.checked && old.location === 'allegro') {
      const loc = await requestPlacement(rec.number, { allowAllegro: false });
      if (!loc) { toast('Zmena zrušená.'); return; }
      patch = { ...patch, ...loc };
    }
    let saved;
    if (rec.number !== old.tracking_number) {
      // oprava čísla = nový záznam + starý sa odstráni
      const { id, _pending, _verified_at, server_updated_at, created_at, ...rest } = old;
      saved = await store.saveParcel({ ...rest, ...patch, tracking_number: rec.number });
      await store.releaseParcel(old.tracking_number);
    } else {
      saved = await store.saveParcel({ ...old, ...patch });
    }
    showFound(saved, { verify: false, verifyState: 'pending', focus: false });
    toast('Zmeny sú uložené.');
  });
}

// ======================================================================= synchronizácia – stav
function renderSync(st) {
  const pill = $('#sync-pill');
  pill.dataset.state = st.state;
  const pending = st.pending ? ` · ${st.pending} čaká` : '';
  const text = {
    idle: 'Pripravené',
    ok: `Synchronizované ${st.lastSync ? timeFmt.format(new Date(st.lastSync)) : ''}${pending}`,
    syncing: 'Synchronizujem…',
    offline: `Offline${pending}`,
    error: `Chyba synchronizácie${pending}`,
    signed_out: 'Prihlásiť sa',
    no_config: 'Nastaviť pripojenie',
  }[st.state] || '';
  $('.txt', pill).textContent = text;
  $('.txt-short', pill).textContent = {
    ok: st.lastSync ? timeFmt.format(new Date(st.lastSync)) : 'OK', syncing: '…', offline: 'Offline', error: 'Chyba',
    signed_out: 'Prihlásiť', no_config: 'Nastaviť', idle: '',
  }[st.state] + (st.pending && st.state !== 'signed_out' ? ` · ${st.pending}` : '');
  pill.title = st.message || text;
  if (st.failed?.length) pill.title += ` · ${st.failed.length} zmien sa nepodarilo uložiť`;
}

function onSyncPill() {
  const st = store.getStatus();
  if (st.state === 'no_config') return openSetup();
  if (st.state === 'signed_out') return openLogin();
  if (st.state === 'error' || st.state === 'offline') { toast(st.message || 'Skúšam znova…'); store.syncNow(); return; }
  openSettings();
}

// ======================================================================= prihlásenie a pripojenie
function openLogin() {
  if (!getConfig().supabaseUrl) return openSetup();
  setMsg($('[data-login-msg]'), '');
  const d = $('#login-dialog');
  if (!d.open) d.showModal();
}

function bindLogin() {
  const f = $('#login-form');
  const go = async (mode) => {
    const email = f.email.value.trim(), password = f.password.value;
    if (!email || password.length < 6) { setMsg($('[data-login-msg]'), 'Zadaj e-mail a heslo (aspoň 6 znakov).', 'error'); return; }
    setMsg($('[data-login-msg]'), mode === 'in' ? 'Prihlasujem…' : 'Vytváram účet…');
    try {
      if (mode === 'in') await auth.signIn(email, password);
      else {
        const r = await auth.signUp(email, password);
        if (r.needsConfirmation) { setMsg($('[data-login-msg]'), 'Účet je vytvorený. Potvrď ho odkazom z e-mailu a potom sa prihlás.', 'ok'); return; }
      }
      $('#login-dialog').close();
      f.reset();
      toast('Prihlásené. Synchronizujem zásielky.');
      store.syncNow({ full: true });
    } catch (e) { setMsg($('[data-login-msg]'), e.message, 'error'); }
  };
  f.addEventListener('submit', (e) => { e.preventDefault(); go('in'); });
  $('[data-signup]').addEventListener('click', () => go('up'));
}

function openSetup() {
  const f = $('#setup-form');
  const c = getConfig();
  f.url.value = c.supabaseUrl; f.key.value = c.supabaseAnonKey;
  setMsg($('[data-setup-msg]'), '');
  $('#setup-dialog').showModal();
}

function bindSetup() {
  $('#setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      saveConfig({ supabaseUrl: f.url.value, supabaseAnonKey: f.key.value });
      $('#setup-dialog').close();
      toast('Pripojenie je uložené.');
      if (!auth.getSession()) openLogin(); else store.syncNow({ full: true });
    } catch (err) { setMsg($('[data-setup-msg]'), err.message, 'error'); }
  });
}

// ======================================================================= nastavenia
async function openSettings() {
  const d = $('#settings-dialog');
  const box = $('[data-settings]', d);
  const st = store.getStatus();
  const user = auth.getUser();
  const fmts = getCustomFormats();
  const cam = await cameraPermissionState();
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  box.innerHTML = `
    <section class="set-sec">
      <h3>Účet</h3>
      ${user ? `<p>Prihlásený ako <b>${esc(user.email)}</b>.</p>
        <div class="set-row"><button type="button" class="btn" data-s="logout">Odhlásiť sa</button></div>`
      : `<p>Nie si prihlásený – zásielky sa ukladajú iba v tomto zariadení a odošlú sa po prihlásení.</p>
        <div class="set-row"><button type="button" class="btn primary" data-s="login">Prihlásiť sa</button></div>`}
    </section>
    <section class="set-sec">
      <h3>Synchronizácia</h3>
      <p>${esc(st.message || (st.lastSync ? `Naposledy ${timeFmt.format(new Date(st.lastSync))}.` : 'Ešte neprebehla.'))}
      ${st.pending ? ` Čakajúce zmeny: <b>${st.pending}</b>.` : ''}</p>
      ${st.failed?.length ? `<p class="warn-text">Tieto zmeny server odmietol:</p><ul class="failed">${st.failed.map((o) => `<li><span><b>${esc(o.number || o.type)}</b> – ${esc(o.error || '')}</span><button type="button" class="btn small ghost" data-discard="${o.seq}">Zahodiť</button></li>`).join('')}</ul>
        <div class="set-row"><button type="button" class="btn small" data-s="retry-failed">Skúsiť znova</button></div>` : ''}
      <div class="set-row"><button type="button" class="btn" data-s="sync">Synchronizovať teraz</button></div>
    </section>
    <section class="set-sec">
      <h3>Pracovisko a mapa</h3>
      <p>Nahraj fotku miesta s policami a stolom a potom nastav zóny a sektory tak, aby sedeli s fotkou.</p>
      <div class="set-row">
        <button type="button" class="btn" data-s="photo">${store.getPhotoUrl() ? 'Vymeniť fotku pracoviska' : 'Nahrať fotku pracoviska'}</button>
        <button type="button" class="btn" data-s="calibrate">Upraviť zóny a sektory</button>
        <button type="button" class="btn" data-s="video">Sken pracoviska z videa</button>
      </div>
    </section>
    <section class="set-sec">
      <h3>Import a záloha</h3>
      <p>Súbor z tlačidla „Export“ starej aplikácie (JSON alebo CSV) sa pred uložením zobrazí v náhľade.</p>
      <div class="set-row">
        <button type="button" class="btn" data-s="import">Import zo súboru</button>
        <button type="button" class="btn" data-s="export">Stiahnuť zálohu (JSON)</button>
      </div>
    </section>
    <section class="set-sec">
      <h3>Formáty čísel zásielok</h3>
      <p>Skener prijíma Packeta, poštové (napr. RR123456789SK), DPD, GLS, UPS a 10-miestne čísla. Ak tvoj dopravca používa iný tvar (napr. Balíkovo), pridaj ho ako regulárny výraz – napríklad <code>BK\\d{9}</code>.</p>
      <ul class="fmt-list">${fmts.map((f, i) => `<li><span><b>${esc(f.name)}</b> <code>${esc(f.pattern)}</code></span><button type="button" class="btn small ghost" data-fmt-del="${i}">Odstrániť</button></li>`).join('') || '<li class="muted">Žiadne vlastné formáty.</li>'}</ul>
      <div class="fmt-add">
        <input data-fmt-name placeholder="Názov (napr. Balíkovo)" aria-label="Názov formátu">
        <input data-fmt-pattern placeholder="Vzor, napr. BK\\d{9}" aria-label="Regulárny výraz">
        <button type="button" class="btn small" data-s="fmt-add">Pridať</button>
      </div>
    </section>
    <section class="set-sec">
      <h3>Aplikácia a fotoaparát</h3>
      <p>Fotoaparát: ${cam === 'granted' ? 'povolený' : cam === 'denied' ? '<b>zakázaný</b> – povoľ ho v nastaveniach prehliadača' : 'povolenie sa vypýta pri prvom skenovaní'}.
      ${standalone ? ' Aplikácia beží nainštalovaná.' : ''}</p>
      <div class="set-row">
        ${!standalone && (deferredInstall || isIos) ? '<button type="button" class="btn primary" data-s="install">Nainštalovať na plochu</button>' : ''}
        <button type="button" class="btn" data-s="update">Skontrolovať aktualizáciu</button>
        <button type="button" class="btn" data-s="setup">Pripojenie k databáze</button>
        <button type="button" class="btn ghost" data-s="wipe">Vymazať dáta v tomto zariadení</button>
      </div>
      <p class="version">Regál ${APP_VERSION}${getConfig().supabaseUrl ? ` · ${esc(new URL(getConfig().supabaseUrl).host)}` : ''}</p>
    </section>`;

  box.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.discard) { await store.discardFailed(Number(b.dataset.discard)); openSettings(); return; }
    if (b.dataset.fmtDel !== undefined) {
      const list = getCustomFormats(); list.splice(Number(b.dataset.fmtDel), 1); saveCustomFormats(list); openSettings(); return;
    }
    const a = b.dataset.s;
    if (a === 'logout') { await auth.signOut(); d.close(); toast('Odhlásené. Neodoslané zmeny zostávajú v zariadení.'); renderSync(store.getStatus()); }
    if (a === 'login') { d.close(); openLogin(); }
    if (a === 'sync') { await store.syncNow({ full: true }); openSettings(); }
    if (a === 'retry-failed') { await store.retryFailed(); openSettings(); }
    if (a === 'photo') { pickPhoto(); }
    if (a === 'calibrate') { d.close(); startCalibration(); }
    if (a === 'video') { d.close(); workshop.open(); }
    if (a === 'import') $('[data-import-file]').click();
    if (a === 'export') exportBackup();
    if (a === 'fmt-add') {
      const name = $('[data-fmt-name]', box).value.trim(), pattern = $('[data-fmt-pattern]', box).value.trim();
      if (!pattern) return;
      try { saveCustomFormats([...getCustomFormats(), { name: name || 'Vlastný formát', pattern }]); openSettings(); }
      catch { toast('Vzor nie je platný regulárny výraz.', 'error'); }
    }
    if (a === 'install') {
      if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; }
      else $('#ios-dialog').showModal();
    }
    if (a === 'update') checkForUpdate(true);
    if (a === 'setup') { d.close(); openSetup(); }
    if (a === 'wipe') {
      const pend = store.getStatus().pending;
      if (confirm(`Vymazať zásielky, fotku a frontu zmien v TOMTO zariadení?${pend ? ` POZOR: ${pend} zmien ešte nebolo odoslaných a stratia sa.` : ''} Databáza sa nezmení.`)) {
        await store.wipeLocalData(); d.close(); toast('Lokálne dáta sú vymazané.'); store.syncNow({ full: true });
      }
    }
  };
  if (!d.open) d.showModal();
}

function pickPhoto() {
  if (!auth.getSession()) { toast('Na nahratie fotky sa prihlás – fotka sa synchronizuje medzi zariadeniami.', 'error'); openLogin(); return; }
  $('[data-photo-file]').click();
}

function bindSettingsFiles() {
  $('[data-photo-file]').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const s = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      await store.setWorkspacePhoto(blob, c.width, c.height);
      $('#settings-dialog').close();
      toast('Fotka je uložená. Teraz nastav zóny, aby sedeli s fotkou.');
      startCalibration();
    } catch (err) { toast(`Fotku sa nepodarilo spracovať: ${err.message}`, 'error'); }
  });

  $('[data-import-file]').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const d = $('#import-dialog');
    const body = $('[data-import-body]', d);
    try {
      const res = await parseImportFile(file);
      const conflicts = res.ok.filter((p) => store.getParcel(p.tracking_number)).length;
      body.innerHTML = `
        <div class="imp-sum"><div><b>${res.ok.length}</b>pripravených</div><div><b>${conflicts}</b>už v evidencii (prepíšu sa)</div><div><b>${res.problems.length}</b>preskočených</div></div>
        ${res.problems.length ? `<p class="muted">Preskočené riadky:</p><ol class="imp-problems">${res.problems.slice(0, 200).map((p) => `<li>riadok ${p.row}: ${esc(p.reason)}</li>`).join('')}</ol>` : ''}
        <p class="hint">Zásielky z importu sa zaradia na synchronizáciu rovnako ako ručne pridané.</p>
        <div class="actions"><button type="button" class="btn primary wide" data-imp-go ${res.ok.length ? '' : 'disabled'}>Importovať ${res.ok.length} zásielok</button></div>`;
      $('[data-imp-go]', body).addEventListener('click', async (ev) => {
        ev.currentTarget.disabled = true;
        for (const p of res.ok) await store.saveParcel(p);
        d.close(); $('#settings-dialog').close();
        toast(`Importované: ${res.ok.length}`);
      });
    } catch (err) {
      body.innerHTML = `<p class="error-text">Súbor sa nepodarilo prečítať: ${esc(err.message)}</p>`;
    }
    d.showModal();
  });
}

async function exportBackup() {
  const data = await store.exportJson();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `regal-zaloha-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ======================================================================= kalibrácia zón
function startCalibration(active = 'A') {
  if (state.place) cancelPlacement();
  clearFound(false);
  state.calibGroup = active;
  map.setMode('calibrate', { zones: store.getZones(), active });
  $('#calib-bar').hidden = false;
  $('#no-photo').hidden = true;
  $('#result').hidden = true;
  map.fit();
  renderCalibBar();
}

function renderCalibBar() {
  const names = ['table', 'front', 'allegro', ...Object.keys(SHELF_GROUPS)];
  const label = (n) => SHELF_GROUPS[n] ? n : n === 'table' ? 'Stôl' : n === 'front' ? 'Pred stolom' : 'Allegro';
  $('[data-calib-groups]').innerHTML = names.map((n) => `<button type="button" data-g="${n}" aria-pressed="${state.calibGroup === n}">${label(n)}</button>`).join('');
  $$('[data-calib-groups] button').forEach((b) => b.addEventListener('click', () => { state.calibGroup = b.dataset.g; map.setActiveGroup(b.dataset.g); renderCalibBar(); }));
  const isShelf = Boolean(SHELF_GROUPS[state.calibGroup]);
  $('#calib-bar .ab-text').innerHTML = isShelf
    ? `<b>Polica ${state.calibGroup}</b> · potiahni rohy na kraje police, celú policu posunieš potiahnutím jej stredu.`
    : `<b>${{ table: 'Stôl', front: 'Pred stolom', allegro: 'Allegro' }[state.calibGroup]}</b> · potiahni stred na presun, rohy a biele úchyty na okrajoch zónu natiahnu.`;
  const g = map.getCalibration()?.groups[state.calibGroup];
  const dirBtn = $('[data-calib-dir]'), revBtn = $('[data-calib-reverse]');
  dirBtn.hidden = revBtn.hidden = !isShelf;
  if (isShelf && g) {
    dirBtn.textContent = g.dir === 'v' ? 'Sektory pod sebou' : 'Sektory vedľa seba';
    const n = SHELF_GROUPS[state.calibGroup];
    revBtn.textContent = g.reverse ? `Poradie ${n}→1` : `Poradie 1→${n}`;
  }
}

function bindCalibBar() {
  $('[data-calib-dir]').addEventListener('click', () => {
    const z = map.getCalibration(); const g = z.groups[state.calibGroup];
    g.dir = g.dir === 'v' ? 'h' : 'v'; map.render(); renderCalibBar();
  });
  $('[data-calib-reverse]').addEventListener('click', () => {
    const z = map.getCalibration(); const g = z.groups[state.calibGroup];
    g.reverse = !g.reverse; map.render(); renderCalibBar();
  });
  $('[data-calib-reset]').addEventListener('click', () => {
    if (!confirm('Vrátiť všetky zóny na predvolené rozloženie?')) return;
    map.setMode('calibrate', { zones: defaultZones(), active: state.calibGroup });
    renderCalibBar();
  });
  $('[data-calib-cancel]').addEventListener('click', endCalibration);
  $('[data-calib-save]').addEventListener('click', async () => {
    const before = store.getZones();
    const after = map.getCalibration();
    await store.setWorkspaceZones(after);
    // zásielky na stole a pred stolom sa posunú spolu so zónou (rovnaká relatívna poloha)
    let moved = 0;
    for (const p of store.allParcels()) {
      if (p.location !== 'table' && p.location !== 'front') continue;
      const a = bbox(before.groups[p.location].quad), b = bbox(after.groups[p.location].quad);
      if (a.join() === b.join() || p.x == null) continue;
      const u = Math.min(1, Math.max(0, (p.x - a[0]) / (a[2] - a[0] || 1)));
      const v = Math.min(1, Math.max(0, (p.y - a[1]) / (a[3] - a[1] || 1)));
      await store.saveParcel({ ...p, x: b[0] + u * (b[2] - b[0]), y: b[1] + v * (b[3] - b[1]) });
      moved++;
    }
    endCalibration();
    toast(moved ? `Zóny sú uložené. Zásielky na stole a pred stolom (${moved}) sa posunuli so zónou.` : 'Zóny sú uložené.');
  });
}

function bbox(q) {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function endCalibration() {
  map.setMode('view');
  $('#calib-bar').hidden = true;
  renderAll();
}

// ======================================================================= hlášky
function toast(text, kind = '', action = null) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast';
  if (kind) t.dataset.kind = kind;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = text;
  t.append(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); action.fn(); });
    t.append(b);
  }
  box.append(t);
  const max = matchMedia('(max-width: 899px)').matches ? 1 : 3;   // na mobile iba posledná hláška – nezakrýva mapu
  while (box.children.length > max) box.firstChild.remove();
  setTimeout(() => t.remove(), action ? 7000 : 4500);
}

// ======================================================================= PWA a aktualizácie
let swReg = null, reloading = false, lastUpdateCheck = 0;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (new URLSearchParams(location.search).has('nosw')) {
    // núdzové vypnutie service workera: ?nosw
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    caches?.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
    return;
  }
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    swReg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(w);
      });
    });
  }).catch((e) => console.warn('SW', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(false); });
}

async function checkForUpdate(manual) {
  if (!swReg) { if (manual) toast('Aktualizácie nie sú dostupné (service worker nebeží).'); return; }
  if (!manual && Date.now() - lastUpdateCheck < 10 * 60 * 1000) return;
  lastUpdateCheck = Date.now();
  try {
    await swReg.update();
    if (manual && !swReg.waiting && !swReg.installing) toast(`Máš najnovšiu verziu (${APP_VERSION}).`);
  } catch { if (manual) toast('Aktualizáciu sa nepodarilo overiť – skús neskôr.', 'error'); }
}

function showUpdateBanner(worker) {
  const b = $('#banner');
  b.hidden = false;
  b.innerHTML = '<span>Je pripravená nová verzia aplikácie.</span><button type="button" class="btn small">Obnoviť teraz</button>';
  $('button', b).addEventListener('click', () => worker.postMessage({ type: 'SKIP_WAITING' }));
}

start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<p class="banner">Aplikáciu sa nepodarilo spustiť: ${esc(e.message)}</p>`);
});
