// Regál – rozšírenie: okienko vpravo dole na stránke Balíkova.
// Keď sa na stránke objaví „Číslo zásielky“ (po zadaní PIN), vyhľadá ju v Regáli a ukáže, kde leží.
(() => {
  if (window.__regalPanel) return;          // skript môže byť vložený viackrát
  window.__regalPanel = true;

  // ---------------------------------------------------------------- rozpoznanie čísla (zhodné s aplikáciou)
  const RULES = [
    /^SK\d[0-9A-Z]{15}$/, /^Z\d{10}$/, /^[A-Z]{2}\d{9}[A-Z]{2}$/, /^1Z[0-9A-Z]{16}$/,
    /^\d{14}$/, /^\d{11}$/, /^\d{10}$/, /^(JJD|JVGL)[0-9A-Z]{10,30}$/,
  ];
  const normalize = (s) => String(s || '').normalize('NFKC').replace(/[\u200B-\u200F\uFEFF]/g, '').toUpperCase().replace(/[\s\-_.\/\\:#]/g, '');
  const isParcel = (n) => n.length >= 8 && n.length <= 40 && /^[A-Z0-9]+$/.test(n) && RULES.some((r) => r.test(n));
  const looseParcel = (n) => n.length >= 8 && n.length <= 40 && /^[A-Z0-9]+$/.test(n) && (n.match(/\d/g) || []).length >= 5;
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').trim();
  const LABEL = /^č[ií]slo\s+z[aá]sielky\s*:?$/i;

  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();

  /** Všetky výskyty platného čísla zásielky na stránke (text aj hodnoty políčok), s prvkom a polohou. */
  function scanNumbers() {
    const out = [];
    const skip = (el) => !el || el.closest?.('#regal-panel-host, script, style, noscript, template');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const raw = n.textContent;
      if (!raw || raw.length > 400 || !/\d/.test(raw)) continue;
      const el = n.parentElement;
      if (skip(el)) continue;
      const tokens = raw.split(/[\s,;|()]+/).map(normalize).filter(Boolean);
      const hit = tokens.find(isParcel) || (isParcel(normalize(raw)) ? normalize(raw) : null);
      if (hit) out.push({ number: hit, el });
    }
    for (const inp of document.querySelectorAll('input, textarea')) {
      if (skip(inp) || inp.type === 'password' || inp.type === 'hidden') continue;
      const v = normalize(inp.value);
      if (isParcel(v)) out.push({ number: v, el: inp });
    }
    return out;
  }

  function findLabels() {
    const labels = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let el = w.nextNode(); el && labels.length < 6; el = w.nextNode()) {
      if (el.closest('#regal-panel-host')) continue;
      if (LABEL.test(ownText(el)) || (el.childElementCount === 0 && LABEL.test(text(el)))) labels.push(el);
    }
    return labels;
  }

  function candidatesNear(label) {
    const out = [];
    const push = (s) => { if (s) out.push(s); };
    push(text(label.nextElementSibling));
    push(text(label.parentElement?.nextElementSibling));
    push(text(label.parentElement?.parentElement?.nextElementSibling));
    const row = label.closest('tr') || label.parentElement?.parentElement || label.parentElement;
    if (row) push(text(row).replace(text(label), ''));
    const input = row?.querySelector?.('input, textarea');
    if (input?.value) push(input.value);
    return out;
  }

  const cellText = (el) => {
    if (!el) return '';
    const vals = [...(el.querySelectorAll?.('input, textarea') || [])].map((i) => i.value).filter(Boolean);
    return [text(el), ...vals].join(' ');
  };
  const pick = (raw, loose) => {
    const tokens = String(raw || '').split(/[\s,;|]+/).map(normalize).filter(Boolean);
    return tokens.find(isParcel) || (loose && tokens.length === 1 && looseParcel(tokens[0]) ? tokens[0] : null);
  };
  const isLabelText = (s) => LABEL.test(String(s || '').replace(/\s+/g, ' ').trim());

  function findNumber() {
    // 0) tabuľka: bunka hneď za bunkou „Číslo zásielky“ (tak je to na stránke Balíkova)
    for (const row of document.querySelectorAll('tr, [role="row"]')) {
      const cells = [...row.querySelectorAll('th, td, [role="cell"], [role="gridcell"], [role="rowheader"]')];
      for (let i = 0; i < cells.length - 1; i++) {
        if (isLabelText(text(cells[i]))) { const n = pick(cellText(cells[i + 1]), true); if (n) return n; }
      }
    }
    const labels = findLabels();
    // 1) hodnota pri štítku „Číslo zásielky“ (v DOM vedľa neho)
    for (const label of labels) {
      for (const raw of candidatesNear(label)) {
        const tokens = raw.split(/[\s,;|]+/).map(normalize).filter(Boolean);
        const strict = tokens.find(isParcel);
        if (strict) return strict;
        if (tokens.length === 1 && looseParcel(tokens[0])) return tokens[0];
      }
    }
    // 1b) text stránky po riadkoch: riadok „Číslo zásielky …“ alebo riadok hneď za ním
    const lines = (document.body.innerText || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^č[ií]slo\s+z[aá]sielky\s*[:\-–]?\s*(.*)$/i);
      if (!m) continue;
      const same = pick(m[1], true);
      if (same) return same;
      for (const next of lines.slice(i + 1, i + 3)) {
        if (/^(meno|hodnota|vybra|centov|pozn[aá]mka|pr[ií]jemca|odosielate)/i.test(next)) break;
        const n = pick(next, true);
        if (n) return n;
      }
    }
    const all = scanNumbers();
    const unique = [...new Set(all.map((x) => x.number))];
    if (!unique.length) return null;
    // 2) číslo v tom istom riadku ako štítok (podľa polohy na obrazovke – nezávisí od štruktúry stránky)
    for (const label of labels) {
      const lr = label.getBoundingClientRect();
      if (!lr.height) continue;
      const cy = lr.top + lr.height / 2;
      const inRow = all.filter((x) => {
        const r = x.el.getBoundingClientRect();
        return r.height && Math.abs(r.top + r.height / 2 - cy) <= Math.max(14, lr.height) && r.left >= lr.left;
      });
      if (inRow.length) return inRow[0].number;
    }
    // 3) na stránke je práve jedno platné číslo zásielky
    return unique.length === 1 ? unique[0] : null;
  }

  // ---------------------------------------------------------------- okienko (Shadow DOM – štýly stránky ho neovplyvnia)
  const host = document.createElement('div');
  host.id = 'regal-panel-host';
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
    .card { width: 320px; background: #fff; color: #16203A; border-radius: 14px; box-shadow: 0 12px 34px -10px rgba(10,16,32,.45), 0 0 0 1px rgba(22,32,58,.12); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px; background: #16203A; color: #fff; cursor: pointer; user-select: none; }
    .head b { font-size: 13px; letter-spacing: .02em; }
    .head .num { flex: 1; font-size: 13px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head button { all: unset; cursor: pointer; width: 24px; height: 24px; text-align: center; line-height: 24px; border-radius: 6px; font-size: 16px; }
    .head button:hover { background: rgba(255,255,255,.15); }
    .logo { width: 18px; height: 18px; }
    .body { padding: 12px; display: grid; gap: 10px; }
    .place { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 10px; background: #FFC21A; color: #16203A;
      border: 5px solid transparent; background: linear-gradient(#FFC21A,#FFC21A) padding-box, repeating-linear-gradient(-45deg,#16203A 0 9px,#FFC21A 9px 18px) border-box; }
    .place.allegro { background: linear-gradient(#E6D7FF,#E6D7FF) padding-box, repeating-linear-gradient(-45deg,#7B3FCF 0 9px,#E6D7FF 9px 18px) border-box; }
    .big { font-size: 38px; font-weight: 800; line-height: .95; letter-spacing: -.01em; }
    .where { font-size: 14px; font-weight: 600; line-height: 1.2; }
    .meta { font-size: 13px; color: #4B5670; }
    .note { font-size: 13px; background: #EEF1F4; padding: 6px 8px; border-radius: 8px; }
    svg.map { width: 100%; height: auto; display: block; background: #F4F6F1; border-radius: 8px; }
    .msg { font-size: 14px; line-height: 1.4; }
    .msg.err { color: #C62F2F; } .msg.warn { color: #9A5B00; }
    .row { display: flex; gap: 8px; }
    .btn { all: unset; cursor: pointer; flex: 1; text-align: center; padding: 9px 10px; border-radius: 9px; font-size: 14px; font-weight: 600; border: 1.5px solid #C3CBD6; color: #16203A; }
    .btn:hover { border-color: #7B849A; }
    .btn.danger { background: #C62F2F; border-color: #C62F2F; color: #fff; }
    .btn.pulse { animation: pulse 1s ease-in-out 3; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(198,47,47,.3); } }
    .btn[disabled] { opacity: .5; pointer-events: none; }
    .mini .body { display: none; }
    .mini { width: auto; max-width: 320px; }
  </style>
  <div class="card" part="card">
    <div class="head" data-toggle title="Zbaliť / rozbaliť">
      <svg class="logo" viewBox="0 0 32 32"><rect x="3" y="4" width="26" height="24" rx="3" fill="none" stroke="#fff" stroke-width="2.6"/><path d="M3 13h26M3 21h26M16 4v24" stroke="#fff" stroke-width="2.6"/><rect x="18.5" y="14.8" width="8" height="4.6" rx="1" fill="#FFC21A"/></svg>
      <b>Regál</b><span class="num" data-num></span>
      <button data-close title="Skryť">✕</button>
    </div>
    <div class="body" data-body></div>
  </div>`;
  const card = root.querySelector('.card');
  const body = root.querySelector('[data-body]');
  const numEl = root.querySelector('[data-num]');
  let current = null;        // číslo, ktoré je práve zobrazené
  let state = null;          // výsledok vyhľadania
  let hiddenFor = null;      // používateľ okienko zavrel pre toto číslo

  root.querySelector('[data-toggle]').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return;
    card.classList.toggle('mini');
    sessionStorage.setItem('regal-mini', card.classList.contains('mini') ? '1' : '0');
  });
  root.querySelector('[data-close]').addEventListener('click', () => {
    if (!current) sessionStorage.setItem('regal-idle-hidden', '1');
    hiddenFor = current; host.remove();
  });
  const isTop = window.top === window;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (/^SK\d[0-9A-Z]{15}$/.test(n) ? `${n.slice(0, 6)} ${n.slice(6, 12)} ${n.slice(12)}` : n.replace(/(.{4})(?=.)/g, '$1 '));
  const send = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError?.message || 'Rozšírenie neodpovedá.' })); }
    catch (e) { resolve({ ok: false, error: 'Rozšírenie bolo aktualizované – obnov stránku (F5).' }); }
  });

  function show() { if (!host.isConnected) document.documentElement.append(host); }

  // ---------------------------------------------------------------- mini mapa
  const GROUPS = { A: 4, B: 4, C: 3, D: 4, E: 2, F: 2 };
  const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const qp = (q, u, v) => lerp(lerp(q[0], q[1], u), lerp(q[3], q[2], u), v);
  const centroid = (p) => [p.reduce((s, x) => s + x[0], 0) / p.length, p.reduce((s, x) => s + x[1], 0) / p.length];
  function sectors(z) {
    const out = [];
    for (const [name, n] of Object.entries(GROUPS)) {
      const g = z.groups?.[name]; if (!g?.quad) continue;
      for (let i = 0; i < n; i++) {
        const a = i / n, b = (i + 1) / n;
        let poly = g.dir === 'v' ? [qp(g.quad, 0, a), qp(g.quad, 1, a), qp(g.quad, 1, b), qp(g.quad, 0, b)]
          : [qp(g.quad, a, 0), qp(g.quad, b, 0), qp(g.quad, b, 1), qp(g.quad, a, 1)];
        if (g.tile) { const [cx, cy] = centroid(poly), [w, h] = g.tile; poly = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]; }
        else if (g.box) { const xs = poly.map((p) => p[0]); const y0 = (poly[0][1] + poly[1][1]) / 2, y1 = (poly[2][1] + poly[3][1]) / 2; poly = [[Math.min(...xs), y0], [Math.max(...xs), y0], [Math.max(...xs), y1], [Math.min(...xs), y1]]; }
        out.push({ sector: `${name}${g.reverse ? n - i : i + 1}`, poly });
      }
    }
    return out;
  }
  function miniMap(z, p) {
    if (!z?.groups) return '';
    const W = 320, H = 200, pts = (q) => q.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ');
    let s = '';
    const area = (k, fill, stroke, dash) => { const g = z.groups[k]; if (g?.quad) s += `<polygon points="${pts(g.quad)}" fill="${fill}" stroke="${stroke}" stroke-width="${p.location === k ? 3 : 1.5}" ${dash ? 'stroke-dasharray="4 3"' : ''}/>`; };
    area('table', p.location === 'table' ? '#FFE08A' : '#D8C1A0', p.location === 'table' ? '#16203A' : '#9C7A55');
    area('front', p.location === 'front' ? '#FFE08A' : '#E3E8E1', p.location === 'front' ? '#16203A' : '#8FA39A', true);
    area('allegro', p.location === 'allegro' ? '#FFC21A' : '#E6D7FF', '#7B3FCF');
    for (const sec of sectors(z)) {
      const on = p.location === 'shelf' && p.sector === sec.sector;
      const [cx, cy] = centroid(sec.poly);
      s += `<polygon points="${pts(sec.poly)}" fill="${on ? '#FFC21A' : '#D8C1A0'}" stroke="${on ? '#16203A' : '#9C7A55'}" stroke-width="${on ? 2.5 : 1}"/>`;
      s += `<text x="${cx * W}" y="${cy * H + 3.5}" font-size="10" font-weight="700" text-anchor="middle" fill="#4A3826">${sec.sector}</text>`;
    }
    if ((p.location === 'table' || p.location === 'front') && p.x != null) {
      s += `<circle cx="${p.x * W}" cy="${p.y * H}" r="7" fill="#FFC21A" stroke="#16203A" stroke-width="2.5"/>`;
    }
    return `<svg class="map" viewBox="0 0 ${W} ${H}" aria-label="Mapa uloženia">${s}</svg>`;
  }

  // ---------------------------------------------------------------- vykreslenie
  const LOC = { shelf: 'Polica, sektor', table: 'Pracovný stôl', front: 'Na zemi pred stolom', allegro: 'Fialová Allegro polica' };
  function render() {
    numEl.textContent = current ? fmt(current) : 'čakám na číslo zásielky';
    if (!current) {
      // nečinný stav: malý pruh = rozšírenie na stránke beží; dá sa aj ručne vyhľadať
      body.innerHTML = `<div class="msg">Po zadaní PIN v Balíkove sa tu ukáže, kde je zásielka uložená.</div>
        <form class="row" data-manual><input data-manual-input placeholder="Číslo zásielky" style="flex:2;min-width:0;padding:8px 10px;border:1.5px solid #C3CBD6;border-radius:9px;font-size:14px">
        <button class="btn" style="flex:1">Hľadať</button></form>`;
      root.querySelector('[data-manual]').addEventListener('submit', (e) => {
        e.preventDefault();
        const n = normalize(root.querySelector('[data-manual-input]').value);
        if (n.length >= 5) { card.classList.remove('mini'); lookup(n, true); }
      });
      return;
    }
    if (!state) { body.innerHTML = '<div class="msg">Hľadám v Regáli…</div>'; return; }
    if (!state.ok) {
      body.innerHTML = `<div class="msg ${state.auth ? 'warn' : 'err'}">${esc(state.error)}</div>
        ${state.auth ? '<div class="msg">Klikni na ikonu Regál vpravo hore v prehliadači a prihlás sa.</div>' : '<div class="row"><span class="btn" data-retry>Skúsiť znova</span></div>'}`;
      root.querySelector('[data-retry]')?.addEventListener('click', () => lookup(current, true));
      return;
    }
    const p = state.parcel;
    const openUrl = `${state.appUrl}?q=${encodeURIComponent(current)}`;
    if (state.released) {
      body.innerHTML = `<div class="msg">Zásielka je odstránená z Regálu.</div><div class="row"><span class="btn" data-undo>Späť</span></div>`;
      root.querySelector('[data-undo]').addEventListener('click', undoRelease);
      return;
    }
    if (!p) {
      body.innerHTML = `<div class="msg warn">Táto zásielka v Regáli nie je – nemá zaznamenané miesto.</div>
        <div class="row"><a class="btn" href="${esc(openUrl)}" target="_blank" rel="noopener">Otvoriť Regál</a></div>`;
      return;
    }
    const big = p.location === 'shelf' ? p.sector : p.location === 'allegro' ? 'Allegro' : p.location === 'table' ? 'Stôl' : 'Pred stolom';
    body.innerHTML = `
      <div class="place${p.location === 'allegro' ? ' allegro' : ''}"><span class="big">${esc(big)}</span><span class="where">${esc(LOC[p.location] || '')}</span></div>
      ${miniMap(state.zones, p)}
      <div class="meta">${p.package_type === 'bag' ? 'Sáčok' : 'Krabica'}${p.created_at ? ` · uložená ${new Date(p.created_at).toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
      <div class="row">
        <span class="btn danger" data-release title="Odstráni zásielku z Regálu (po vydaní zákazníkovi)">Vydaná – odstrániť</span>
        <a class="btn" href="${esc(openUrl)}" target="_blank" rel="noopener">Otvoriť v Regáli</a>
      </div>`;
    root.querySelector('[data-release]').addEventListener('click', releaseNow);
  }

  async function lookup(number, force = false) {
    if (!number) return;
    if (number === current && !force) return;
    current = number;
    state = null;
    if (hiddenFor === number) return;
    hiddenFor = null;
    card.classList.remove('mini');      // nájdená zásielka sa vždy ukáže rozbalená
    show(); render();
    const r = await send({ type: 'lookup', number });
    if (current !== number) return;     // medzitým sa zobrazila iná zásielka
    state = r;
    render();
  }

  async function releaseNow(e) {
    const btn = e.currentTarget;
    if (btn.hasAttribute('disabled')) return;
    btn.setAttribute('disabled', '');
    btn.textContent = 'Odstraňujem…';
    const backup = state.parcel;
    const r = await send({ type: 'release', number: current });
    if (!r.ok) { state = { ...state, ok: false, error: r.error }; render(); return; }
    state = { ...state, released: true, backup };
    render();
  }

  async function undoRelease() {
    const b = state.backup;
    const r = await send({ type: 'restore', parcel: b });
    if (!r.ok) { state = { ...state, ok: false, error: r.error }; render(); return; }
    state = { ...state, released: false, parcel: b };
    render();
  }

  // ---------------------------------------------------------------- sledovanie stránky
  let t = null;
  const check = () => { clearTimeout(t); t = setTimeout(() => { const n = findNumber(); if (n) lookup(n); }, 250); };
  new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });
  document.addEventListener('input', check, true);
  // hodnotu políčka môže stránka nastaviť skriptom bez udalosti → občas skontrolujeme aj tak
  let goneSince = 0;
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const n = findNumber();
    if (n) { goneSince = 0; lookup(n); return; }
    // číslo zo stránky zmizlo (napr. po potvrdení doručenia) → okienko späť do pruhu „čakám“
    if (current && !(state && (state.released || state.awaitRelease))) {
      goneSince ||= Date.now();
      if (Date.now() - goneSince > 1500) { current = null; state = null; goneSince = 0; card.classList.add('mini'); render(); }
    }
  }, 1200);
  let burst = null;
  const armBurst = () => {
    clearInterval(burst);
    let k = 0;
    burst = setInterval(() => { const n = findNumber(); if (n) lookup(n); if (++k > 40) clearInterval(burst); }, 300);
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button, input[type="submit"], [role="button"]');
    if (b && /zobrazi[tť]\s+inform[aá]cie/i.test(text(b) || b.value || '')) { hiddenFor = null; armBurst(); }
  }, true);
  check();
  // v hlavnom okne ukážeme malý pruh „Regál · čakám na číslo zásielky“ – je vidieť, že rozšírenie beží
  const relevant = () => /shipment-delivery|vydaj|delivery/i.test(location.pathname) || findLabels().length > 0;
  function showIdle() {
    if (!isTop || current || host.isConnected || sessionStorage.getItem('regal-idle-hidden') === '1') return;
    if (!relevant()) return;
    card.classList.add('mini'); show(); render();
  }
  setTimeout(showIdle, 600);
  setInterval(showIdle, 2000);   // aplikácia Balíkova mení stránky bez načítania (SPA)

  // okno rozšírenia sa môže opýtať, či tu skript beží a čo našiel
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'ping') {
      const labels = findLabels().length;
      // vložené rámy z iných adries (aplikácia Balíkova môže bežať v ráme)
      const frames = [...new Set([...document.querySelectorAll('iframe[src]')].map((f) => { try { return new URL(f.src, location.href).origin; } catch { return null; } })
        .filter((o) => o && /^https?:/.test(o) && o !== location.origin))];
      reply({ ok: true, top: isTop, number: current, labels, url: location.href, frames });
    }
  });

  // po „Potvrdenie doručenia“ v Balíkove pripomenieme odstránenie z Regálu
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button, a, input[type="button"], input[type="submit"]');
    if (!b || host.contains(b)) return;
    if (/potvrdenie\s+doru[cč]enia/i.test(text(b) || b.value || '')) {
      setTimeout(() => {
        const rel = root.querySelector('[data-release]');
        if (rel) {
          if (state) state.awaitRelease = true;   // okienko ostane, aj keď Balíkovo číslo zo stránky odstráni
          card.classList.remove('mini'); rel.classList.add('pulse'); rel.textContent = 'Vydaná? Odstrániť z Regálu';
        }
      }, 300);
    }
  }, true);
})();
