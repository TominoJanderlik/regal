// Import zásielok zo súboru (napr. „Export“ zo starej aplikácie). Formát starého exportu
// nepoznáme presne, preto sa polia mapujú podľa bežných názvov a pred uložením sa zobrazí náhľad.
import { recognize } from './tracking.js';
import { SECTORS } from './config.js';

const pick = (o, names) => {
  const keys = Object.keys(o);
  for (const n of names) {
    const k = keys.find((key) => key.toLowerCase().replace(/[\s_-]/g, '') === n);
    if (k !== undefined && o[k] !== '' && o[k] != null) return o[k];
  }
  return undefined;
};

function strip(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }

function mapLocation(v) {
  const s = strip(v ?? '');
  if (!s) return null;
  if (s.includes('allegro') || s.includes('fial')) return 'allegro';
  if (s.includes('pred')) return 'front';
  if (s.includes('stol') || s === 'table' || s === 'desk') return 'table';
  if (s.includes('polic') || s.includes('shelf') || s.includes('roh')) return 'shelf';
  if (s === 'front' || s === 'floor') return 'front';
  return null;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!isFinite(n)) return null;
  return n > 1 && n <= 100 ? n / 100 : n;   // percentá → 0..1
}

function parseCsv(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}

function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['parcels', 'zasielky', 'items', 'data', 'packages', 'baliky', 'records']) {
      if (Array.isArray(data[k])) return data[k];
    }
    const vals = Object.entries(data).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
    if (vals.length) return vals.map(([k, v]) => ({ tracking_number: k, ...v }));
  }
  return [];
}

/** Vráti { ok: [...parcelInput], problems: [{row, reason}] } */
export async function parseImportFile(file) {
  const text = await file.text();
  let items;
  if (/\.csv$/i.test(file.name) || (!text.trim().startsWith('{') && !text.trim().startsWith('['))) items = parseCsv(text);
  else items = extractArray(JSON.parse(text));
  const ok = [], problems = [];
  const seen = new Set();
  items.forEach((o, i) => {
    if (!o || typeof o !== 'object') { problems.push({ row: i + 1, reason: 'Neplatný riadok' }); return; }
    const rawNum = pick(o, ['trackingnumber', 'number', 'cislo', 'ciszasielky', 'cislozasielky', 'code', 'barcode', 'parcel', 'parcelnumber', 'shipment', 'kod']);
    const rec = recognize(rawNum, { strict: false });
    if (!rec.ok) { problems.push({ row: i + 1, reason: `Číslo „${rawNum ?? ''}“: ${rec.reason}` }); return; }
    if (seen.has(rec.number)) { problems.push({ row: i + 1, reason: `${rec.number} je v súbore viackrát – použitý prvý výskyt` }); return; }
    const allegroRaw = pick(o, ['isallegro', 'allegro']);
    const isAllegro = allegroRaw === true || ['true', '1', 'ano', 'áno', 'yes'].includes(strip(allegroRaw ?? ''));
    let sector = pick(o, ['sector', 'sektor', 'slot', 'shelf', 'polica']);
    sector = sector ? String(sector).toUpperCase().replace(/\s/g, '') : null;
    let location = isAllegro ? 'allegro' : mapLocation(pick(o, ['location', 'place', 'miesto', 'umiestnenie', 'loc', 'where', 'area', 'zone', 'zona']));
    if (!location && sector && SECTORS.includes(sector)) location = 'shelf';
    const x = num(pick(o, ['x', 'posx', 'left', 'px'])), y = num(pick(o, ['y', 'posy', 'top', 'py']));
    if (!location) { problems.push({ row: i + 1, reason: `${rec.number}: chýba alebo je neznáme umiestnenie` }); return; }
    if (location === 'shelf' && !SECTORS.includes(sector)) { problems.push({ row: i + 1, reason: `${rec.number}: neplatný sektor „${sector ?? ''}“` }); return; }
    if ((location === 'table' || location === 'front') && (x == null || y == null || x < 0 || x > 1 || y < 0 || y > 1)) {
      problems.push({ row: i + 1, reason: `${rec.number}: chýbajú súradnice bodu na stole/pred stolom` }); return;
    }
    const pkg = strip(pick(o, ['packagetype', 'package', 'type', 'obal', 'packaging', 'typobalu']) ?? '');
    seen.add(rec.number);
    ok.push({
      tracking_number: rec.number,
      location,
      sector: location === 'shelf' ? sector : null,
      x: location === 'table' || location === 'front' ? x : null,
      y: location === 'table' || location === 'front' ? y : null,
      package_type: pkg.includes('sac') || pkg === 'bag' ? 'bag' : 'box',
      note: String(pick(o, ['note', 'poznamka', 'comment', 'notes']) ?? '').slice(0, 500),
    });
  });
  return { ok, problems, total: items.length };
}
