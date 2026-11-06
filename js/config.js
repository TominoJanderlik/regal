// Regál – konfigurácia
// ---------------------------------------------------------------
// Supabase URL a anon (publishable) kľúč môžeš vyplniť tu, alebo ich
// aplikácia pri prvom spustení vypýta a uloží v prehliadači.
// Anon kľúč je verejný – bezpečnosť zabezpečujú pravidlá RLS v databáze.
// NIKDY sem nevkladaj service_role kľúč.
// ---------------------------------------------------------------

export const APP_VERSION = '1.0.9';

const BUILT_IN = {
  supabaseUrl: 'https://pudvswjifctcskujrzlr.supabase.co',          // projekt balik-evidencia-zasielok
  supabaseAnonKey: 'sb_publishable_1uf5XK4NkDNF1OussTFXGA_pZQFwYkg',  // verejný publishable kľúč
};

const CONFIG_KEY = 'regal.config.v1';

export function getConfig() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); } catch { stored = {}; }
  // ručne zmenené pripojenie (Menu → Pripojenie k databáze) má prednosť pred vstavaným
  const useStored = Boolean(stored.supabaseUrl && stored.supabaseAnonKey);
  const supabaseUrl = ((useStored ? stored.supabaseUrl : BUILT_IN.supabaseUrl) || '').replace(/\/+$/, '');
  const supabaseAnonKey = (useStored ? stored.supabaseAnonKey : BUILT_IN.supabaseAnonKey) || '';
  return { supabaseUrl, supabaseAnonKey, builtIn: Boolean(BUILT_IN.supabaseUrl) };
}

export function saveConfig({ supabaseUrl, supabaseAnonKey }) {
  const url = String(supabaseUrl || '').trim().replace(/\/+$/, '');
  const key = String(supabaseAnonKey || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) {
    throw new Error('Adresa musí vyzerať ako https://xxxx.supabase.co');
  }
  if (key.length < 20) throw new Error('Kľúč je príliš krátky – skopíruj anon / publishable key.');
  if (looksLikeServiceRole(key)) {
    throw new Error('Toto je tajný service_role kľúč. Do aplikácie patrí iba anon / publishable kľúč.');
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }));
}

function looksLikeServiceRole(key) {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'service_role';
  } catch { return false; }
}

export const LOCATIONS = {
  table:   { label: 'Na stole',        short: 'Stôl' },
  front:   { label: 'Pred stolom',     short: 'Pred stolom' },
  shelf:   { label: 'Na polici',       short: 'Police' },
  allegro: { label: 'Allegro polica',  short: 'Allegro' },
};

export const PACKAGE_TYPES = {
  box: { label: 'Krabica' },
  bag: { label: 'Sáčok' },
};

// Skupiny sektorov na policiach (počet sektorov v skupine) – zhodné s pôvodnou aplikáciou.
export const SHELF_GROUPS = { A: 4, B: 4, C: 3, D: 4, E: 2, F: 2 };
export const SECTORS = Object.entries(SHELF_GROUPS)
  .flatMap(([g, n]) => Array.from({ length: n }, (_, i) => `${g}${i + 1}`));

// Fotka pracoviska dodaná s aplikáciou (police + stôl zhora + Allegro). Zóny k nej sú uložené v databáze.
// Ak používateľ nahrá vlastnú fotku, má prednosť.
// Mapa je schéma ako v pôvodnej aplikácii; fotka sa zobrazí iba ak ju používateľ nahrá (Menu).
export const DEFAULT_PHOTO = null;

export const REQUEST_TIMEOUT_MS = 15000;
export const SYNC_INTERVAL_MS = 25000;
export const FULL_RECONCILE_MS = 15 * 60 * 1000;
