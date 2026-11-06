// Stabilné prihlásenie voči Supabase Auth (GoTrue) bez externej knižnice.
// • relácia sa ukladá do localStorage a prežije prepnutie karty aj reštart
// • token sa obnovuje vopred (2 min pred vypršaním) a vždy pri návrate na stránku
// • súbežné požiadavky čakajú na JEDNU obnovu (v karte aj naprieč kartami – Web Locks)
// • výpadok siete reláciu nikdy nezmaže; odhlási iba server, ktorý refresh token odmietne
import { getConfig, REQUEST_TIMEOUT_MS } from './config.js';

const SESSION_KEY = 'regal.session.v1';
const REFRESH_MARGIN_S = 120;      // obnov 2 minúty pred koncom
const MIN_VALID_FOR_REQUEST_S = 30;

export class AuthError extends Error {
  constructor(message, kind = 'auth', status = 0) { super(message); this.kind = kind; this.status = status; }
}

const listeners = new Set();
let session = readStored();
let refreshPromise = null;
let timer = null;
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('regal-auth') : null;

function now() { return Math.floor(Date.now() / 1000); }

function readStored() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.access_token && s.refresh_token ? s : null;
  } catch { return null; }
}

function persist(s, { broadcast = true } = {}) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
  if (broadcast && channel) channel.postMessage({ type: 'session', at: Date.now() });
  schedule();
  for (const fn of listeners) { try { fn(s); } catch (e) { console.error(e); } }
}

function adoptStored() {
  const s = readStored();
  const changed = (s?.access_token || null) !== (session?.access_token || null);
  session = s;
  if (changed) {
    schedule();
    for (const fn of listeners) { try { fn(s); } catch (e) { console.error(e); } }
  }
}

function toSession(data) {
  const expiresAt = data.expires_at || (now() + (data.expires_in || 3600));
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    user: data.user ? { id: data.user.id, email: data.user.email } : session?.user || null,
  };
}

async function authFetch(path, body) {
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  if (!supabaseUrl) throw new AuthError('Chýba nastavenie Supabase.', 'config');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${supabaseUrl}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (e) {
    throw new AuthError(e.name === 'AbortError' ? 'Server neodpovedal včas.' : 'Bez pripojenia k serveru.', e.name === 'AbortError' ? 'timeout' : 'network');
  } finally { clearTimeout(t); }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const msg = data.error_description || data.msg || data.message || data.error || `Chyba ${res.status}`;
    const code = data.error_code || data.code || data.error || '';
    const kind = res.status >= 500 || res.status === 429 || res.status === 408 ? 'server' : 'rejected';
    const err = new AuthError(translate(msg, code), kind, res.status);
    err.code = String(code);
    throw err;
  }
  return data;
}

function translate(msg, code) {
  const m = `${msg} ${code}`.toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid_credentials')) return 'Nesprávny e-mail alebo heslo.';
  if (m.includes('email not confirmed') || m.includes('email_not_confirmed')) return 'E-mail ešte nie je potvrdený – otvor odkaz z e-mailu.';
  if (m.includes('already registered') || m.includes('user_already_exists')) return 'Účet s týmto e-mailom už existuje – prihlás sa.';
  if (m.includes('password') && m.includes('6')) return 'Heslo musí mať aspoň 6 znakov.';
  if (m.includes('rate limit') || m.includes('over_email_send_rate_limit')) return 'Príliš veľa pokusov. Skús to o chvíľu.';
  return msg;
}

export function getSession() { return session; }
export function getUser() { return session?.user || null; }
export function onSessionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function signIn(email, password) {
  const data = await authFetch('token?grant_type=password', { email, password });
  persist(toSession(data));
  return session;
}

export async function signUp(email, password) {
  const data = await authFetch('signup', { email, password });
  if (data.access_token) { persist(toSession(data)); return { session, needsConfirmation: false }; }
  return { session: null, needsConfirmation: true };
}

export async function signOut() {
  const s = session;
  persist(null);
  if (s) {
    // best effort – zrušenie refresh tokenu na serveri; chyba siete nevadí
    const { supabaseUrl, supabaseAnonKey } = getConfig();
    fetch(`${supabaseUrl}/auth/v1/logout`, {
      method: 'POST', headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => {});
  }
}

function isRefreshTokenDead(err) {
  if (err.kind !== 'rejected') return false;
  const c = `${err.code} ${err.message}`.toLowerCase();
  return err.status === 400 || err.status === 401 || c.includes('refresh_token');
}

async function doRefresh(staleAccessToken) {
  // Iná karta mohla medzitým token obnoviť – použijeme ho a refresh token nepálime zbytočne.
  const stored = readStored();
  if (!stored) { persist(null, { broadcast: false }); throw new AuthError('Relácia skončila. Prihlás sa znova.', 'signed_out'); }
  if (stored.access_token !== staleAccessToken && stored.expires_at - now() > REFRESH_MARGIN_S) {
    session = stored; schedule(); return stored;
  }
  try {
    const data = await authFetch('token?grant_type=refresh_token', { refresh_token: stored.refresh_token });
    persist(toSession(data));
    return session;
  } catch (err) {
    if (isRefreshTokenDead(err)) {
      // Možný súboj kariet: ak medzitým iná karta uložila nový refresh token, použijeme ho.
      const again = readStored();
      if (again && again.refresh_token !== stored.refresh_token) { session = again; schedule(); return again; }
      persist(null);
      throw new AuthError('Prihlásenie vypršalo. Prihlás sa znova – neodoslané zmeny zostávajú uložené.', 'signed_out', err.status);
    }
    // sieť / server: relácia zostáva, skúsime neskôr
    schedule(30);
    throw err;
  }
}

/** Obnoví token. Všetky súbežné volania zdieľajú jednu obnovu. */
export function refreshSession(failedToken) {
  // Požiadavka s tokenom, ktorý medzitým iná požiadavka/karta už obnovila → stačí nový token.
  adoptStored();
  if (failedToken && session && session.access_token !== failedToken && session.expires_at - now() > MIN_VALID_FOR_REQUEST_S) {
    return Promise.resolve(session);
  }
  if (refreshPromise) return refreshPromise;
  const stale = failedToken || session?.access_token;
  const run = () => doRefresh(stale);
  refreshPromise = (navigator.locks?.request
    ? navigator.locks.request('regal-auth-refresh', run)
    : run()
  ).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/** Platný access token pre požiadavku (obnoví ho, ak je blízko vypršania). */
export async function getAccessToken() {
  if (!session) adoptStored();
  if (!session) return null;
  if (session.expires_at - now() > MIN_VALID_FOR_REQUEST_S) return session.access_token;
  try {
    const s = await refreshSession();
    return s.access_token;
  } catch (err) {
    if (err.kind === 'signed_out') throw err;
    // sieť nefunguje: ak je token ešte platný, použijeme ho, inak požiadavka zlyhá ako sieťová chyba
    if (session && session.expires_at > now()) return session.access_token;
    throw err;
  }
}

function schedule(delaySeconds) {
  clearTimeout(timer);
  if (!session) return;
  const inS = delaySeconds ?? Math.max(5, session.expires_at - now() - REFRESH_MARGIN_S);
  timer = setTimeout(() => { refreshIfNeeded(); }, Math.min(inS, 3600) * 1000);
}

/** Volá sa pri návrate na stránku, obnovení siete a periodicky. */
export async function refreshIfNeeded() {
  adoptStored();
  if (!session) return;
  if (session.expires_at - now() <= REFRESH_MARGIN_S) {
    try { await refreshSession(); } catch { /* chyba siete – skúsime znova pri ďalšej príležitosti */ }
  } else {
    schedule();
  }
}

// Ďalšie karty: nová relácia alebo odhlásenie
window.addEventListener('storage', (e) => { if (e.key === SESSION_KEY) adoptStored(); });
channel?.addEventListener('message', () => adoptStored());
// Prehliadač na pozadí brzdí časovače – pri návrate token hneď skontrolujeme.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshIfNeeded(); });
window.addEventListener('focus', () => refreshIfNeeded());
window.addEventListener('online', () => refreshIfNeeded());
window.addEventListener('pageshow', () => refreshIfNeeded());
schedule();
