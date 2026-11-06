// Normalizácia a rozpoznanie čísla zásielky.
// Skener prijme iba text, ktorý zodpovedá niektorému pravidlu (vrátane kontrolných súčtov),
// aby sa do evidencie nedostal náhodný text, EAN kód výrobku a pod.

const CUSTOM_KEY = 'regal.customFormats.v1';

const BUILT_IN_RULES = [
  // SK + 16 znakov – najčastejší formát v tvojej databáze (30 z 39 zásielok)
  { id: 'sk18', name: 'Kód zásielky SK…', re: /^SK\d[0-9A-Z]{15}$/ },
  { id: 'packeta', name: 'Packeta (Zásielkovňa)', re: /^Z\d{10}$/ },
  { id: 'upu', name: 'Pošta (medzinárodný formát)', re: /^[A-Z]{2}\d{9}[A-Z]{2}$/, check: upuCheck },
  { id: 'ups', name: 'UPS', re: /^1Z[0-9A-Z]{16}$/ },
  { id: 'dpd', name: 'DPD', re: /^\d{14}$/ },
  { id: 'gls', name: 'GLS', re: /^\d{11}$/ },
  { id: 'digits10', name: '10-miestne číslo (DHL, SPS…)', re: /^\d{10}$/ },
  { id: 'dhl-jjd', name: 'DHL (JJD/JVGL)', re: /^(JJD|JVGL)[0-9A-Z]{10,30}$/ },
];

export function getCustomFormats() {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    return Array.isArray(list) ? list.filter((f) => f && typeof f.pattern === 'string') : [];
  } catch { return []; }
}

export function saveCustomFormats(list) {
  for (const f of list) {
    // overíme, že regulárny výraz je platný
    new RegExp(`^(?:${f.pattern})$`);
  }
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

function rules() {
  const custom = getCustomFormats().map((f, i) => ({
    id: `custom-${i}`, name: f.name || 'Vlastný formát', re: new RegExp(`^(?:${f.pattern})$`), custom: true,
  }));
  return [...custom, ...BUILT_IN_RULES];
}

// UPU S10: 2 písmená + 8 číslic + kontrolná číslica + 2 písmená
function upuCheck(s) {
  const d = s.slice(2, 10).split('').map(Number);
  const w = [8, 6, 4, 2, 3, 5, 9, 7];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += d[i] * w[i];
  let c = 11 - (sum % 11);
  if (c === 10) c = 0; else if (c === 11) c = 5;
  return c === Number(s[10]);
}

// EAN-8 / UPC-A / EAN-13 s platným kontrolným súčtom = pravdepodobne kód výrobku, nie zásielky
export function isProductCode(s) {
  if (!/^\d+$/.test(s) || ![8, 12, 13].includes(s.length)) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

function fromUrl(text) {
  let url;
  try { url = new URL(text); } catch { return null; }
  const keys = ['tracking', 'trackingnumber', 'tracking_number', 'parcel', 'parcelnumber', 'parcel_number',
    'id', 'number', 'shipment', 'barcode', 'code', 'match', 'q', 'zasielka', 'cislo'];
  for (const [k, v] of url.searchParams) {
    if (keys.includes(k.toLowerCase()) && v) return v;
  }
  const seg = url.pathname.split('/').filter(Boolean).pop();
  return seg || null;
}

/** Bezpečná normalizácia: veľké písmená, bez medzier/pomlčiek/neviditeľných znakov. */
export function normalize(raw) {
  if (raw == null) return '';
  let s = String(raw).normalize('NFKC');
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, ' ').trim();
  if (/^https?:\/\//i.test(s)) {
    const v = fromUrl(s);
    if (v) s = decodeURIComponent(v);
  }
  // DPD 28-znakový čiarový kód: % + PSČ(7) + číslo(14) + služba(3) + krajina(3)
  const dpd = s.replace(/\s/g, '').match(/^%[0-9A-Z]{7}(\d{14})\d{6}$/i);
  if (dpd) return dpd[1];
  s = s.toUpperCase().replace(/[\s\-_.\/\\:#]/g, '');
  return s;
}

/**
 * Rozpozná číslo zásielky.
 * strict=true (skener): prijme iba známe formáty.
 * strict=false (ručné zadanie): neznámy, ale prijateľný tvar vráti s needsConfirm=true.
 */
export function recognize(raw, { strict = true } = {}) {
  const number = normalize(raw);
  if (!number) return { ok: false, number, reason: 'Prázdne číslo' };
  if (!/^[A-Z0-9]+$/.test(number)) {
    return { ok: false, number, reason: 'Číslo obsahuje nepovolené znaky' };
  }
  for (const r of rules()) {
    if (r.re.test(number) && (!r.check || r.check(number))) {
      return { ok: true, number, carrier: r.name, rule: r.id };
    }
  }
  if (isProductCode(number)) {
    if (strict) return { ok: false, number, reason: 'Toto je kód výrobku (EAN/UPC), nie číslo zásielky' };
    // ručne zadané číslo s tvarom EAN je možné, ale treba ho potvrdiť
    return { ok: true, number, carrier: null, needsConfirm: true };
  }
  if (strict) return { ok: false, number, reason: 'Nerozpoznaný formát čísla zásielky' };
  if (number.length < 5 || number.length > 40) {
    return { ok: false, number, reason: 'Číslo musí mať 5 až 40 znakov' };
  }
  const digitCount = (number.match(/\d/g) || []).length;
  if (digitCount < 4) return { ok: false, number, reason: 'Číslo zásielky musí obsahovať aspoň 4 číslice' };
  return { ok: true, number, carrier: null, needsConfirm: true };
}

export function formatNumber(n) {
  // čitateľnejšie zobrazenie dlhých čísel po skupinách
  if (!n) return '';
  if (/^SK\d[0-9A-Z]{15}$/.test(n)) return `${n.slice(0, 6)} ${n.slice(6, 12)} ${n.slice(12)}`;
  if (/^Z\d{10}$/.test(n)) return `Z ${n.slice(1, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 8)} ${n.slice(8, 11)} ${n.slice(11)}`;
  if (n.length <= 8) return n;
  return n.replace(/(.{4})(?=.)/g, '$1 ');
}
