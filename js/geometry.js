// Geometria mapy. Všetky súradnice sú v rozsahu 0..1 voči fotke (alebo schéme),
// preto nezávisia od veľkosti obrazovky ani od zoomu.
import { SHELF_GROUPS } from './config.js';

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export const SCHEMATIC_SIZE = { width: 1600, height: 1000 };

export function defaultZones() {
  return {
    version: 1,
    groups: {
      A: { quad: rect(0.04, 0.06, 0.36, 0.16), dir: 'h', reverse: false },
      B: { quad: rect(0.04, 0.18, 0.36, 0.28), dir: 'h', reverse: false },
      C: { quad: rect(0.04, 0.30, 0.36, 0.40), dir: 'h', reverse: false },
      D: { quad: rect(0.40, 0.06, 0.72, 0.16), dir: 'h', reverse: false },
      E: { quad: rect(0.40, 0.18, 0.72, 0.28), dir: 'h', reverse: false },
      F: { quad: rect(0.40, 0.30, 0.72, 0.40), dir: 'h', reverse: false },
      allegro: { quad: rect(0.76, 0.06, 0.96, 0.40) },
      table: { quad: rect(0.12, 0.50, 0.70, 0.72) },
      front: { quad: rect(0.04, 0.76, 0.96, 0.96) },
    },
  };
}

export const AREA_LABELS = { allegro: 'Allegro polica', table: 'Pracovný stôl', front: 'Pred stolom' };

function lerp(a, b, u) { return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]; }

/** Bilineárny bod v štvoruholníku (u zľava doprava, v zhora nadol). */
export function quadPoint(q, u, v) {
  const top = lerp(q[0], q[1], u);
  const bottom = lerp(q[3], q[2], u);
  return lerp(top, bottom, v);
}

/** Rozdelí skupinu políc na sektory (A1…A4) – funguje aj pre perspektívne skosenú policu. */
export function groupSectors(name, g) {
  const n = SHELF_GROUPS[name];
  if (!n || !g?.quad) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = i / n, b = (i + 1) / n;
    const poly = g.dir === 'v'
      ? [quadPoint(g.quad, 0, a), quadPoint(g.quad, 1, a), quadPoint(g.quad, 1, b), quadPoint(g.quad, 0, b)]
      : [quadPoint(g.quad, a, 0), quadPoint(g.quad, b, 0), quadPoint(g.quad, b, 1), quadPoint(g.quad, a, 1)];
    const idx = g.reverse ? n - i : i + 1;
    out.push({ sector: `${name}${idx}`, group: name, poly: g.tile ? tileRect(poly, g.tile) : g.box ? bboxRect(poly) : poly });
  }
  return out;
}

/** Rovnako veľký štvorec (dlaždica) v strede sektora. tile = [šírka, výška] v súradniciach 0..1. */
export function tileRect(poly, [w, h]) {
  const [cx, cy] = centroid(poly);
  return [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
}

/** Najmenší vodorovný obdĺžnik okolo mnohouholníka (pre úhľadné „dlaždice“ sektorov). */
export function bboxRect(poly) {
  // šírka podľa krajov, výška podľa priemeru hornej a dolnej hrany → rovnako vysoké dlaždice bez prekrývania
  const xs = poly.map((p) => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = (poly[0][1] + poly[1][1]) / 2, y1 = (poly[2][1] + poly[3][1]) / 2;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** Je mnohouholník vodorovný obdĺžnik? (kreslí sa potom ako zaoblený obdĺžnik) */
export function isAxisRect(poly) {
  if (poly.length !== 4) return false;
  const e = 1e-6;
  return Math.abs(poly[0][1] - poly[1][1]) < e && Math.abs(poly[2][1] - poly[3][1]) < e &&
    Math.abs(poly[0][0] - poly[3][0]) < e && Math.abs(poly[1][0] - poly[2][0]) < e;
}

export function allSectors(zones) {
  return Object.keys(SHELF_GROUPS).flatMap((k) => groupSectors(k, zones.groups[k]));
}

export function pointInPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(poly) {
  // ťažisko štvoruholníka = priemer vrcholov stačí pre konvexné tvary sektorov
  const s = poly.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [s[0] / poly.length, s[1] / poly.length];
}

/**
 * Kam patrí bod? Police majú prednosť (sektor + bod v strede sektora),
 * potom Allegro, stôl a priestor pred stolom (presný bod).
 */
export function locate(pt, zones) {
  for (const s of allSectors(zones)) {
    if (pointInPoly(pt, s.poly)) return { location: 'shelf', sector: s.sector, point: centroid(s.poly) };
  }
  const near = nearestTile(pt, zones);
  if (near) return { location: 'shelf', sector: near.sector, point: centroid(near.poly) };
  const g = zones.groups;
  if (g.allegro && pointInPoly(pt, g.allegro.quad)) return { location: 'allegro', sector: null, point: centroid(g.allegro.quad) };
  if (g.table && pointInPoly(pt, g.table.quad)) return { location: 'table', sector: null, point: pt };
  if (g.front && pointInPoly(pt, g.front.quad)) return { location: 'front', sector: null, point: pt };
  return null;
}

/** Pri dlaždiciach: najbližší sektor, ak je ťuknutie do 35 % veľkosti dlaždice od jej okraja. */
function nearestTile(pt, zones) {
  let best = null, bestD = Infinity;
  for (const s of allSectors(zones)) {
    const tile = zones.groups[s.group]?.tile;
    if (!tile) continue;
    const [cx, cy] = centroid(s.poly);
    const dx = Math.abs(pt[0] - cx) / tile[0], dy = Math.abs(pt[1] - cy) / tile[1];
    if (dx <= 0.85 && dy <= 0.85) {
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = s; }
    }
  }
  return best;
}

export function sectorCenter(zones, sector) {
  const s = allSectors(zones).find((z) => z.sector === sector);
  return s ? centroid(s.poly) : null;
}

export function allegroCenter(zones) {
  return zones.groups.allegro ? centroid(zones.groups.allegro.quad) : [0.86, 0.23];
}

/** Bod, kde sa zásielka zobrazí na mape. Polica/Allegro → stred zóny, stôl/pred stolom → uložený bod. */
export function displayPoint(p, zones) {
  if (p.location === 'allegro') return allegroCenter(zones);
  if (p.location === 'shelf') return sectorCenter(zones, p.sector) || [p.x ?? 0.5, p.y ?? 0.5];
  return [p.x ?? 0.5, p.y ?? 0.5];
}

export function clamp01(v) { return Math.min(1, Math.max(0, v)); }
