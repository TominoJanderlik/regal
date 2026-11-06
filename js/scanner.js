// Skenovanie čiarových a QR kódov fotoaparátom.
// 1) natívny BarcodeDetector (Chrome/Edge na Androide, macOS),
// 2) inak otvorená knižnica ZXing (vendor/, funguje aj v Safari na iPhone).
// Prijme sa iba text rozpoznaný ako číslo zásielky a prečítaný zhodne v 2 snímkach.
import { recognize } from './tracking.js';

const NATIVE_FORMATS = ['code_128', 'code_39', 'code_93', 'ean_13', 'itf', 'qr_code', 'data_matrix', 'pdf417', 'aztec', 'codabar'];
let nativeDetector = null;
/** Návratová hodnota skenera, keď používateľ zvolí ručné zadanie čísla. */
export const MANUAL = Symbol('manual');
let zxing = null;

export async function engineInfo() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      if (supported.includes('code_128')) return { engine: 'native', formats: supported };
    } catch { /* nie je podporované */ }
  }
  return { engine: 'zxing', formats: ['code_128', 'code_39', 'code_93', 'ean_13', 'itf', 'qr_code', 'data_matrix', 'pdf417'] };
}

function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/zxing-0.21.3.min.js', import.meta.url).href;
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => reject(new Error('Knižnicu na čítanie kódov sa nepodarilo načítať.'));
    document.head.append(s);
  });
}

async function getDecoder() {
  const info = await engineInfo();
  if (info.engine === 'native') {
    if (!nativeDetector) nativeDetector = new BarcodeDetector({ formats: NATIVE_FORMATS.filter((f) => info.formats.includes(f)) });
    return async (canvas) => (await nativeDetector.detect(canvas)).map((b) => ({
      text: b.rawValue, box: { x: b.boundingBox.x, y: b.boundingBox.y, w: b.boundingBox.width, h: b.boundingBox.height },
    }));
  }
  const Z = await loadZxing();
  if (!zxing) {
    const hints = new Map();
    const F = Z.BarcodeFormat;
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.ITF, F.QR_CODE, F.DATA_MATRIX, F.PDF_417]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zxing = new Z.MultiFormatReader();
    zxing.setHints(hints);
  }
  return async (canvas) => {
    try {
      const src = new Z.HTMLCanvasElementLuminanceSource(canvas);
      const res = zxing.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(src)));
      const pts = res.getResultPoints() || [];
      let box = null;
      if (pts.length) {
        const xs = pts.map((p) => p.getX()), ys = pts.map((p) => p.getY());
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        box = { x: x0, y: y0 - 10, w: Math.max(20, x1 - x0), h: Math.max(20, y1 - y0 + 20) };
      }
      return [{ text: res.getText(), box }];
    } catch { return []; } finally { zxing.reset(); }
  };
}

/**
 * Prečíta kódy z plátna. multi=true skúsi aj dlaždice (ZXing vie naraz iba jeden kód).
 * Vracia [{ text, box: {x,y,w,h} v pixeloch plátna }]
 */
export async function decodeCanvas(canvas, { multi = false } = {}) {
  const decode = await getDecoder();
  const found = await decode(canvas);
  if (!multi || (await engineInfo()).engine === 'native') return found;
  const seen = new Set(found.map((f) => f.text));
  const tile = document.createElement('canvas');
  const ctx = tile.getContext('2d', { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  const regions = [];
  for (const [cols, rows] of [[2, 2], [3, 2]]) {
    const tw = W / cols, th = H / rows;
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      regions.push([c * tw - tw * 0.15, r * th - th * 0.15, tw * 1.3, th * 1.3]);
    }
  }
  for (const [x, y, w, h] of regions) {
    const sx = Math.max(0, x), sy = Math.max(0, y), sw = Math.min(W - sx, w), sh = Math.min(H - sy, h);
    tile.width = Math.round(sw); tile.height = Math.round(sh);
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, tile.width, tile.height);
    for (const f of await decode(tile)) {
      if (seen.has(f.text)) continue;
      seen.add(f.text);
      found.push({ text: f.text, box: f.box ? { x: f.box.x + sx, y: f.box.y + sy, w: f.box.w, h: f.box.h } : { x: sx, y: sy, w: sw, h: sh } });
    }
  }
  return found;
}

export function cameraErrorMessage(err) {
  const name = err?.name || '';
  if (!window.isSecureContext) return 'Fotoaparát funguje iba cez zabezpečené pripojenie (https).';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Prístup k fotoaparátu je zakázaný. Android/Chrome: ťukni na ikonu vedľa adresy → Povolenia → Fotoaparát → Povoliť. iPhone: Nastavenia → Safari (alebo aplikácia na ploche) → Fotoaparát → Povoliť. Potom skús znova.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Zariadenie nemá dostupný fotoaparát.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Fotoaparát používa iná aplikácia. Zavri ju a skús znova.';
  return `Fotoaparát sa nepodarilo spustiť (${name || err?.message || 'neznáma chyba'}).`;
}

export async function cameraPermissionState() {
  try { return (await navigator.permissions.query({ name: 'camera' })).state; } catch { return 'unknown'; }
}

/** Ovládač dialógu skenera (DOM je v index.html). */
export class Scanner {
  constructor(dialog) {
    this.d = dialog;
    this.video = dialog.querySelector('video');
    this.msg = dialog.querySelector('[data-scan-msg]');
    this.torchBtn = dialog.querySelector('[data-torch]');
    this.fileInput = dialog.querySelector('[data-scan-file]');
    this.canvas = document.createElement('canvas');
    dialog.querySelector('[data-close]').addEventListener('click', () => this.finish(null));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.finish(null); });
    this.torchBtn.addEventListener('click', () => this.toggleTorch());
    this.fileInput.addEventListener('change', () => this.fromFile());
    dialog.querySelector('[data-manual]')?.addEventListener('click', () => this.finish(MANUAL));
  }

  /** ignore: čísla, ktoré sa majú preskočiť (napr. práve uložená zásielka v sérii). */
  scan(title = 'Naskenuj čiarový kód zásielky', { ignore = [] } = {}) {
    if (this.resolve) this.finish(null);
    this.ignore = new Set(ignore);
    this.d.querySelector('[data-scan-title]').textContent = title;
    this.setMsg('Spúšťam fotoaparát…');
    this.d.showModal();
    return new Promise((resolve) => { this.resolve = resolve; this.start(); });
  }

  setMsg(text, kind = '') { this.msg.textContent = text; this.msg.dataset.kind = kind; }

  async start() {
    this.last = null;
    try {
      this.decode = await getDecoder();
    } catch (e) { this.setMsg(e.message, 'error'); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setMsg('Tento prehliadač nepovoľuje fotoaparát. Použi „Odfotiť štítok“ alebo číslo vlož ručne.', 'error');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e) {
      this.setMsg(cameraErrorMessage(e), 'error');
      return;
    }
    if (!this.resolve) { this.stop(); return; }
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    try { await this.video.play(); } catch { /* iOS niekedy vyžaduje gesto – video sa spustí po ťuknutí */ }
    const track = this.stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    this.torchBtn.hidden = !caps.torch;
    this.setMsg('Namier na čiarový kód alebo QR kód na štítku.');
    this.loop();
  }

  async loop() {
    if (!this.resolve || !this.stream) return;
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth) {
      // čítame iba stred obrazu (rámik) – rýchlejšie a menej omylov
      const cw = Math.round(v.videoWidth * 0.86), ch = Math.round(v.videoHeight * 0.56);
      const sx = (v.videoWidth - cw) / 2, sy = (v.videoHeight - ch) / 2;
      const scale = Math.min(1, 1280 / cw);
      this.canvas.width = Math.round(cw * scale); this.canvas.height = Math.round(ch * scale);
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, sx, sy, cw, ch, 0, 0, this.canvas.width, this.canvas.height);
      try {
        const results = await this.decode(this.canvas);
        for (const r of results) if (this.consider(r.text)) return;
      } catch { /* chybný snímok – pokračujeme */ }
    }
    this.raf = setTimeout(() => this.loop(), 120);
  }

  consider(text) {
    const rec = recognize(text, { strict: true });
    const now = performance.now();
    if (!rec.ok) {
      if (!this.lastReject || now - this.lastReject > 1500) {
        this.setMsg(`Ignorujem kód „${String(text).slice(0, 40)}“ – ${rec.reason.toLowerCase()}.`, 'warn');
        this.lastReject = now;
      }
      return false;
    }
    if (this.ignore?.has(rec.number)) {
      if (!this.lastIgnore || now - this.lastIgnore > 1500) {
        this.setMsg(`${rec.number} je už uložená – namier na ďalšiu zásielku.`, 'ok');
        this.lastIgnore = now;
      }
      return false;
    }
    if (this.last && this.last.number === rec.number && now - this.last.at < 1500) {
      navigator.vibrate?.(60);
      this.finish(rec.number);
      return true;
    }
    this.last = { number: rec.number, at: now };
    this.setMsg(`Čítam ${rec.number}…`, 'ok');
    return false;
  }

  async fromFile() {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    this.setMsg('Hľadám kód na fotke…');
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      this.canvas.width = Math.round(bmp.width * scale); this.canvas.height = Math.round(bmp.height * scale);
      this.canvas.getContext('2d').drawImage(bmp, 0, 0, this.canvas.width, this.canvas.height);
      const results = await decodeCanvas(this.canvas, { multi: true });
      const ok = results.map((r) => recognize(r.text, { strict: true })).filter((r) => r.ok);
      if (ok.length === 1) { this.finish(ok[0].number); return; }
      if (ok.length > 1) { this.setMsg(`Na fotke je viac čísel zásielok (${ok.map((r) => r.number).join(', ')}). Odfoť iba jeden štítok.`, 'warn'); return; }
      this.setMsg(results.length ? 'Na fotke je kód, ale nie je to číslo zásielky.' : 'Na fotke sa nenašiel čitateľný kód. Skús ostrejšiu fotku zbližša.', 'warn');
    } catch (e) {
      this.setMsg(`Fotku sa nepodarilo spracovať: ${e.message}`, 'error');
    }
  }

  async toggleTorch() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    this.torch = !this.torch;
    try { await track.applyConstraints({ advanced: [{ torch: this.torch }] }); } catch { this.torchBtn.hidden = true; }
    this.torchBtn.setAttribute('aria-pressed', String(this.torch));
  }

  stop() {
    clearTimeout(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.torch = false;
  }

  finish(value) {
    this.stop();
    if (this.d.open) this.d.close();
    const r = this.resolve;
    this.resolve = null;
    r?.(value);
  }
}
