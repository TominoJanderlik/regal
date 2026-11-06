// Sken pracoviska z videa – realistické MVP.
// Video sa spracúva LOKÁLNE v prehliadači a nikam sa nenahráva. Po zatvorení sa uvoľní z pamäte.
// Čo robí: vzorkuje snímky, číta čiarové/QR kódy, zlučuje ten istý kód naprieč snímkami
// do jedného kandidáta, ponúkne výber snímky ako fotky pracoviska a VŽDY čaká na potvrdenie.
// Čo nerobí: nevytvára presný 3D model (fotogrametria/LiDAR) – to otvorene uvádza.
import { decodeCanvas, engineInfo } from './scanner.js';
import { recognize, formatNumber } from './tracking.js';
import { locate } from './geometry.js';
import { LOCATIONS } from './config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

export async function capabilities() {
  const caps = [];
  const cam = Boolean(navigator.mediaDevices?.getUserMedia);
  caps.push({ name: 'Fotoaparát', ok: cam, text: cam ? 'dostupný' : 'nedostupný – video vyber zo súboru' });
  const eng = await engineInfo();
  caps.push({ name: 'Čítanie kódov', ok: true, text: eng.engine === 'native' ? 'vstavané v prehliadači (rýchle)' : 'knižnica ZXing (pomalšie, funguje všade)' });
  const v = document.createElement('video');
  const mp4 = v.canPlayType('video/mp4'), mov = v.canPlayType('video/quicktime'), webm = v.canPlayType('video/webm');
  caps.push({ name: 'Prehrávanie videa', ok: Boolean(mp4 || webm), text: [mp4 && 'MP4', mov && 'MOV', webm && 'WebM'].filter(Boolean).join(', ') || 'neznáme' });
  let xr = false;
  try { xr = Boolean(await navigator.xr?.isSessionSupported?.('immersive-ar')); } catch { xr = false; }
  caps.push({ name: 'WebXR AR', ok: xr, text: xr ? 'dostupné – v tomto MVP sa nepoužíva' : 'nedostupné' });
  caps.push({ name: 'Hĺbková kamera / LiDAR', ok: false, text: 'webové stránky k nej bežne nemajú prístup – nepredpokladá sa' });
  caps.push({ name: 'Výkon zariadenia', ok: true, text: `${navigator.hardwareConcurrency || '?'} jadier${navigator.deviceMemory ? `, ${navigator.deviceMemory} GB RAM` : ''}` });
  return caps;
}

function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve(); };
    const timer = setTimeout(done, 4000);
    video.addEventListener('seeked', done);
    video.currentTime = Math.min(t, Math.max(0, video.duration - 0.05));
  });
}

function canvasTo(canvas, max, quality = 0.75) {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', quality));
}

export class VideoWorkshop {
  /**
   * @param {HTMLDialogElement} dialog
   * @param {object} deps  { store, requestPlacement(number) → Promise<loc|null>, toast(text), getZones() }
   */
  constructor(dialog, deps) {
    this.d = dialog;
    this.deps = deps;
    this.body = dialog.querySelector('[data-video-body]');
    dialog.querySelector('[data-close]').addEventListener('click', () => this.close());
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close(); });
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('change', (e) => this.onChange(e));
    this.body.addEventListener('input', (e) => this.onInput(e));
  }

  async open() {
    this.reset();
    this.d.showModal();
    await this.renderIntro();
  }

  reset() {
    this.cancelled = true;
    for (const u of this.urls || []) URL.revokeObjectURL(u);
    this.urls = [];
    this.videoUrl = null;
    this.videoEl = null;
    this.cands = new Map();
    this.keyframes = [];
    this.refFrame = null;
    this.ignored = 0;
  }

  close() {
    this.reset();             // video sa po spracovaní neuchováva
    if (this.d.open) this.d.close();
  }

  url(blob) { const u = URL.createObjectURL(blob); this.urls.push(u); return u; }

  async renderIntro() {
    const caps = await capabilities();
    this.body.innerHTML = `
      <p class="lead">Nahraj video pracoviska. Kamerou pomaly prejdi police, stôl a priestor pred stolom tak, aby boli štítky čitateľné. Video sa spracuje iba v tomto zariadení.</p>
      <ul class="caps">${caps.map((c) => `<li class="${c.ok ? 'ok' : 'no'}"><b>${esc(c.name)}</b><span>${esc(c.text)}</span></li>`).join('')}</ul>
      <div class="note-box">
        <p><b>Čo z videa vznikne:</b> zoznam prečítaných čísel zásielok (každé číslo raz, aj keď je vidieť vo viacerých snímkach), výrezy štítkov a návrh snímky na fotku pracoviska.</p>
        <p><b>Čo nevznikne:</b> presný 3D model. Z bežného videa ho prehliadač spoľahlivo nevytvorí bez platenej služby alebo hĺbkovej kamery. Polohu preto potvrdíš na mape.</p>
      </div>
      <label class="field">
        <span>Video pracoviska</span>
        <input type="file" accept="video/*" capture="environment" data-video-file>
      </label>
      <label class="field inline">
        <span>Snímok za sekundu</span>
        <select data-fps><option value="1">1 – rýchle</option><option value="2" selected>2 – odporúčané</option><option value="4">4 – dôkladné, pomalé</option></select>
      </label>
      <div class="actions"><button class="btn primary" data-act="process" disabled>Spracovať video</button></div>`;
  }

  onChange(e) {
    if (e.target.matches('[data-video-file]')) {
      this.file = e.target.files?.[0] || null;
      this.body.querySelector('[data-act="process"]').disabled = !this.file;
    }
    if (e.target.matches('[data-cand-confirm]')) {
      const c = this.cands.get(e.target.dataset.id);
      if (c) c.confirmed = e.target.checked;
      this.updateSaveButton();
    }
    if (e.target.matches('[data-cand-allegro]')) {
      const c = this.cands.get(e.target.dataset.id);
      if (c) { c.allegro = e.target.checked; this.renderCand(c); }
    }
  }

  onInput(e) {
    if (e.target.matches('[data-cand-number]')) {
      const c = this.cands.get(e.target.dataset.id);
      if (!c) return;
      const rec = recognize(e.target.value, { strict: false });
      c.number = rec.ok ? rec.number : '';
      c.numberError = rec.ok ? (rec.needsConfirm ? 'Neznámy formát – skontroluj' : '') : rec.reason;
      c.confirmed = false;
      const box = e.target.closest('.cand');
      box.querySelector('[data-cand-confirm]').checked = false;
      box.querySelector('.cand-err').textContent = c.numberError || '';
      this.updateSaveButton();
    }
  }

  async onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'process') this.process(Number(this.body.querySelector('[data-fps]').value) || 2);
    if (act === 'cancel') { this.cancelled = true; }
    if (act === 'pick-ref') this.selectRef(Number(b.dataset.i));
    if (act === 'use-photo') this.useAsPhoto();
    if (act === 'place') this.place(b.dataset.id);
    if (act === 'save') this.saveConfirmed();
    if (act === 'manual') this.addManual();
    if (act === 'ocr') this.ocr(b.dataset.id);
    if (act === 'remove') { this.cands.delete(b.dataset.id); b.closest('.cand').remove(); this.updateSaveButton(); }
    if (act === 'restart') { this.reset(); this.renderIntro(); }
  }

  async process(fps) {
    this.cancelled = false;
    this.videoUrl = this.url(this.file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = this.videoUrl;
    this.videoEl = v;
    this.body.innerHTML = `
      <p class="lead">Spracúvam video v tomto zariadení…</p>
      <div class="progress"><div class="bar" data-bar></div></div>
      <p class="muted" data-prog>Načítavam video</p>
      <div class="actions"><button class="btn" data-act="cancel">Zastaviť</button></div>`;
    const bar = this.body.querySelector('[data-bar]');
    const prog = this.body.querySelector('[data-prog]');
    try {
      await new Promise((res, rej) => {
        v.onloadedmetadata = res;
        v.onerror = () => rej(new Error('Tento formát videa prehliadač nevie otvoriť. Skús MP4 (H.264).'));
        setTimeout(() => rej(new Error('Video sa nepodarilo načítať včas.')), 20000);
      });
      // iOS niekedy vydá prvý snímok až po krátkom prehratí
      try { await v.play(); v.pause(); } catch { /* nevadí */ }
      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('Video nemá platnú dĺžku.');
      const maxDur = Math.min(dur, 300);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const step = 1 / fps;
      let lastKey = -10, frames = 0;
      const t0 = performance.now();
      for (let t = 0; t < maxDur && !this.cancelled; t += step) {
        await seek(v, t);
        const s = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * s); canvas.height = Math.round(v.videoHeight * s);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        frames++;
        if (t - lastKey >= 1.5 && this.keyframes.length < 60) {
          lastKey = t;
          this.keyframes.push({ t, url: this.url(await canvasTo(canvas, 480, 0.7)) });
        }
        const results = await decodeCanvas(canvas, { multi: true });
        for (const r of results) {
          const rec = recognize(r.text, { strict: true });
          if (!rec.ok) { this.ignored++; continue; }
          const box = r.box ? { x: r.box.x / canvas.width, y: r.box.y / canvas.height, w: r.box.w / canvas.width, h: r.box.h / canvas.height } : null;
          const area = box ? box.w * box.h : 0;
          const c = this.cands.get(rec.number) || { id: rec.number, number: rec.number, carrier: rec.carrier, source: 'code', frames: 0, best: null };
          c.frames++;
          if (!c.best || area > c.best.area) c.best = { t, box, area };
          this.cands.set(rec.number, c);
        }
        bar.style.width = `${Math.round((t / maxDur) * 100)}%`;
        const el = Math.round((performance.now() - t0) / 1000);
        prog.textContent = `Snímka ${frames} · čas ${t.toFixed(1)} / ${maxDur.toFixed(0)} s · nájdené čísla: ${this.cands.size} · ${el} s`;
      }
      // výrezy štítkov z najlepšej snímky každého kandidáta
      for (const c of this.cands.values()) {
        await seek(v, c.best.t);
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        c.crop = this.url(await this.crop(canvas, c.best.box));
      }
      if (!this.keyframes.length) throw new Error('Z videa sa nepodarilo získať žiadnu snímku.');
      this.renderReview(dur > maxDur);
    } catch (err) {
      this.body.innerHTML = `<p class="error-text">${esc(err.message)}</p><div class="actions"><button class="btn" data-act="restart">Skúsiť iné video</button></div>`;
    }
  }

  async crop(canvas, box) {
    const W = canvas.width, H = canvas.height;
    let x = 0, y = 0, w = W, h = H;
    if (box) {
      const cx = (box.x + box.w / 2) * W, cy = (box.y + box.h / 2) * H;
      w = Math.max(box.w * W * 2.2, 220); h = Math.max(box.h * H * 3, 160);
      x = Math.max(0, cx - w / 2); y = Math.max(0, cy - h / 2);
      w = Math.min(W - x, w); h = Math.min(H - y, h);
    }
    const c = document.createElement('canvas');
    const s = Math.min(1, 520 / w);
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  }

  renderReview(truncated) {
    const n = this.cands.size;
    this.body.innerHTML = `
      <section class="v-section">
        <h3>Fotka pracoviska</h3>
        <p class="muted">Vyber snímku, na ktorej je vidieť police, stôl aj priestor pred stolom. Môžeš ju použiť ako fotku mapy (potom skontroluj zóny).</p>
        <div class="frames">${this.keyframes.map((k, i) => `<button class="frame${this.refFrame === i ? ' active' : ''}" data-act="pick-ref" data-i="${i}" aria-label="Snímka v čase ${k.t.toFixed(1)} s"><img src="${k.url}" alt=""><span>${k.t.toFixed(1)} s</span></button>`).join('')}</div>
        <div class="actions"><button class="btn" data-act="use-photo" ${this.refFrame == null ? 'disabled' : ''}>Použiť vybranú snímku ako fotku pracoviska</button></div>
      </section>
      <section class="v-section">
        <h3>Nájdené zásielky (${n})</h3>
        ${truncated ? '<p class="muted">Spracovaných bolo prvých 5 minút videa.</p>' : ''}
        <p class="muted">${n ? 'Každé číslo je uvedené raz, aj keď bolo vidieť vo viacerých snímkach. Nič sa neuloží, kým záznam nepotvrdíš.' : 'Vo videu sa nenašiel žiadny čitateľný kód zásielky. Skús video bližšie k štítkom, s lepším svetlom a pomalším pohybom.'}
        ${this.ignored ? ` Ignorované kódy, ktoré nie sú číslom zásielky: ${this.ignored}.` : ''}</p>
        <div class="cands" data-cands></div>
        <div class="actions split">
          <button class="btn" data-act="manual">Pridať balík s nečitateľným kódom</button>
          <button class="btn primary" data-act="save" disabled>Uložiť potvrdené</button>
        </div>
      </section>`;
    for (const c of this.cands.values()) this.renderCand(c);
    this.updateSaveButton();
  }

  renderCand(c) {
    const list = this.body.querySelector('[data-cands]');
    let box = list.querySelector(`[data-cand="${CSS.escape(c.id)}"]`);
    if (!box) { box = document.createElement('article'); box.className = 'cand'; box.dataset.cand = c.id; list.append(box); }
    const existing = c.number ? this.deps.store.getParcel(c.number) : null;
    const loc = c.allegro ? { location: 'allegro' } : c.loc;
    const locText = loc ? (loc.location === 'shelf' ? `Polica ${loc.sector}` : LOCATIONS[loc.location].label) : 'Poloha zatiaľ nie je určená';
    const sourceText = c.source === 'code' ? `Kód prečítaný v ${c.frames} ${c.frames === 1 ? 'snímke' : c.frames < 5 ? 'snímkach' : 'snímkach'}${c.carrier ? ` · ${c.carrier}` : ''}`
      : c.source === 'ocr' ? 'Prečítané z textu (OCR) – môže obsahovať chyby, skontroluj číslo' : 'Zadané ručne';
    box.classList.toggle('uncertain', c.source !== 'code');
    box.innerHTML = `
      ${c.crop ? `<img class="cand-img" src="${c.crop}" alt="Výrez štítku">` : '<div class="cand-img empty">bez výrezu</div>'}
      <div class="cand-main">
        <label class="field"><span>Číslo zásielky</span>
          <input class="mono" data-cand-number data-id="${esc(c.id)}" value="${esc(c.number || '')}" autocomplete="off" spellcheck="false"></label>
        <p class="cand-err">${esc(c.numberError || '')}</p>
        <p class="muted">${esc(sourceText)}</p>
        ${existing ? `<p class="warn-text">Už je v evidencii: ${esc(existing.location === 'shelf' ? `Polica ${existing.sector}` : LOCATIONS[existing.location].label)}. Uložením sa poloha prepíše.</p>` : ''}
        <p class="cand-loc${loc ? '' : ' missing'}">${esc(locText)}${c.locSuggested && !c.allegro ? ' · návrh z videa, skontroluj' : ''}</p>
        <div class="cand-actions">
          <label class="check"><input type="checkbox" data-cand-allegro data-id="${esc(c.id)}" ${c.allegro ? 'checked' : ''}> Allegro</label>
          ${c.allegro ? '' : `<button class="btn small" data-act="place" data-id="${esc(c.id)}">${loc ? 'Zmeniť polohu' : 'Označiť na mape'}</button>`}
          ${c.frameUrl ? `<button class="btn small" data-act="ocr" data-id="${esc(c.id)}">Prečítať text (OCR)</button>` : ''}
          <button class="btn small ghost" data-act="remove" data-id="${esc(c.id)}">Vyradiť</button>
        </div>
        <label class="check confirm"><input type="checkbox" data-cand-confirm data-id="${esc(c.id)}" ${c.confirmed ? 'checked' : ''} ${c.number && (loc) ? '' : 'disabled'}> Potvrdzujem číslo aj polohu</label>
      </div>`;
  }

  updateSaveButton() {
    const btn = this.body.querySelector('[data-act="save"]');
    if (!btn) return;
    const n = [...this.cands.values()].filter((c) => c.confirmed && c.number && (c.allegro || c.loc)).length;
    btn.disabled = n === 0;
    btn.textContent = n ? `Uložiť potvrdené (${n})` : 'Uložiť potvrdené';
  }

  async selectRef(i) {
    this.refFrame = i;
    this.body.querySelectorAll('.frame').forEach((f, j) => f.classList.toggle('active', j === i));
    this.body.querySelector('[data-act="use-photo"]').disabled = false;
  }

  async useAsPhoto() {
    const k = this.keyframes[this.refFrame];
    if (!k || !this.videoEl) return;
    const v = this.videoEl;
    await seek(v, k.t);
    const s = Math.min(1, 2048 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    try {
      await this.deps.store.setWorkspacePhoto(blob, c.width, c.height);
      this.photoT = k.t;
      // kandidáti viditeľní priamo na tejto snímke dostanú NÁVRH polohy (nie potvrdenie)
      const zones = this.deps.getZones();
      for (const cand of this.cands.values()) {
        if (cand.best?.box && Math.abs(cand.best.t - k.t) < 0.01 && !cand.loc) {
          const pt = [cand.best.box.x + cand.best.box.w / 2, cand.best.box.y + cand.best.box.h / 2];
          const l = locate(pt, zones);
          if (l && l.location !== 'allegro') { cand.loc = { ...l, x: l.point[0], y: l.point[1] }; cand.locSuggested = true; this.renderCand(cand); }
        }
      }
      this.deps.toast('Fotka pracoviska je uložená. Skontroluj zóny v Nastaveniach → Upraviť zóny.');
    } catch (e) { this.deps.toast(e.message, 'error'); }
  }

  async place(id) {
    const c = this.cands.get(id);
    if (!c) return;
    this.d.close();
    const loc = await this.deps.requestPlacement(c.number || 'zásielka z videa');
    this.d.showModal();
    if (loc && loc.location !== 'allegro') { c.loc = loc; c.locSuggested = false; c.confirmed = false; }
    else if (loc?.location === 'allegro') { c.allegro = true; }
    this.renderCand(c);
    this.updateSaveButton();
  }

  async addManual() {
    const id = `manual-${Date.now()}`;
    let frameUrl = null;
    if (this.refFrame != null) frameUrl = this.keyframes[this.refFrame].url;
    const c = { id, number: '', source: 'manual', frames: 0, crop: frameUrl, frameUrl, frameT: this.refFrame != null ? this.keyframes[this.refFrame].t : null };
    this.cands.set(id, c);
    this.renderCand(c);
    this.body.querySelector(`[data-cand="${CSS.escape(id)}"] input`)?.focus();
  }

  async ocr(id) {
    const c = this.cands.get(id);
    if (!c || c.frameT == null) return;
    if (!window.Tesseract) {
      const ok = confirm('Čítanie textu (OCR) potrebuje stiahnuť otvorenú knižnicu Tesseract.js (cca 5–10 MB) z CDN jsDelivr. Obrázok sa NEodosiela – číta sa v zariadení. Pokračovať?');
      if (!ok) return;
      try {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = TESSERACT_URL; s.onload = res; s.onerror = () => rej(new Error('OCR knižnicu sa nepodarilo stiahnuť.')); document.head.append(s); });
      } catch (e) { this.deps.toast(e.message, 'error'); return; }
    }
    const v = this.videoEl;
    await seek(v, c.frameT);
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    this.deps.toast('Čítam text na snímke…');
    try {
      const worker = await window.Tesseract.createWorker('eng');
      await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' });
      const { data } = await worker.recognize(canvas);
      await worker.terminate();
      const tokens = data.text.split(/\s+/).map((tk) => recognize(tk, { strict: true })).filter((r) => r.ok);
      if (tokens.length) {
        c.number = tokens[0].number; c.source = 'ocr'; c.numberError = tokens.length > 1 ? `Na snímke je viac kandidátov: ${tokens.map((x) => formatNumber(x.number)).join(', ')}` : '';
      } else {
        c.numberError = 'OCR nenašlo číslo zásielky – zadaj ho ručne.';
      }
      c.confirmed = false;
      this.renderCand(c);
    } catch (e) { this.deps.toast(`OCR zlyhalo: ${e.message}`, 'error'); }
  }

  async saveConfirmed() {
    const list = [...this.cands.values()].filter((c) => c.confirmed && c.number && (c.allegro || c.loc));
    let saved = 0;
    for (const c of list) {
      const input = c.allegro
        ? { tracking_number: c.number, location: 'allegro', x: null, y: null, sector: null }
        : { tracking_number: c.number, location: c.loc.location, sector: c.loc.sector || null, x: c.loc.x, y: c.loc.y };
      const existing = this.deps.store.getParcel(c.number);
      await this.deps.store.saveParcel({ package_type: existing?.package_type || 'box', note: existing?.note || '', ...input });
      this.cands.delete(c.id);
      this.body.querySelector(`[data-cand="${CSS.escape(c.id)}"]`)?.remove();
      saved++;
    }
    this.updateSaveButton();
    this.deps.toast(`Uložené zásielky: ${saved}`);
  }
}
