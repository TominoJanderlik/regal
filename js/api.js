// Požiadavky na Supabase (PostgREST, RPC, Storage) s časovým limitom,
// obmedzeným opakovaním a jednou obnovou relácie pri chybe 401.
import { getConfig, REQUEST_TIMEOUT_MS } from './config.js';
import { getAccessToken, refreshSession, AuthError } from './auth.js';

export class ApiError extends Error {
  constructor(message, { kind = 'http', status = 0, code = '', details = null } = {}) {
    super(message);
    this.kind = kind;       // network | timeout | auth | http | config | schema
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get transient() { return ['network', 'timeout'].includes(this.kind) || this.status >= 500 || this.status === 429 || this.status === 408; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt, retryAfter) {
  if (retryAfter) return Math.min(10000, retryAfter * 1000);
  return Math.min(8000, 600 * 2 ** attempt) + Math.random() * 300;
}

/**
 * @param {string} path  napr. '/rest/v1/regal_parcels?select=*'
 * @param {object} opt   method, body (objekt/Blob), headers, timeout, retries, responseType ('json'|'blob'|'none')
 */
export async function request(path, opt = {}) {
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  if (!supabaseUrl || !supabaseAnonKey) throw new ApiError('Aplikácia nemá nastavené pripojenie k Supabase.', { kind: 'config' });
  const { method = 'GET', body, headers = {}, timeout = REQUEST_TIMEOUT_MS, retries = 2, responseType = 'json' } = opt;
  if (!navigator.onLine) throw new ApiError('Zariadenie je offline.', { kind: 'network' });

  let retried401 = false;
  for (let attempt = 0; ; attempt++) {
    let token;
    try {
      token = await getAccessToken();
    } catch (e) {
      if (e instanceof AuthError && e.kind === 'signed_out') throw new ApiError(e.message, { kind: 'auth', status: 401 });
      if (attempt < retries) { await sleep(backoff(attempt)); continue; }
      throw new ApiError(e.message || 'Bez pripojenia.', { kind: e.kind === 'timeout' ? 'timeout' : 'network' });
    }
    if (!token) throw new ApiError('Nie si prihlásený.', { kind: 'auth', status: 401 });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const h = { apikey: supabaseAnonKey, Authorization: `Bearer ${token}`, ...headers };
    let payload = body;
    if (body !== undefined && !(body instanceof Blob) && typeof body !== 'string') {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(`${supabaseUrl}${path}`, { method, headers: h, body: payload, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      clearTimeout(timer);
      const kind = e.name === 'AbortError' ? 'timeout' : 'network';
      if (attempt < retries) { await sleep(backoff(attempt)); continue; }
      throw new ApiError(kind === 'timeout' ? 'Server neodpovedal včas.' : 'Bez pripojenia k serveru.', { kind });
    }
    clearTimeout(timer);

    if (res.status === 401 && !retried401) {
      retried401 = true;
      try { await refreshSession(token); } catch (e) {
        if (e instanceof AuthError && e.kind === 'signed_out') throw new ApiError(e.message, { kind: 'auth', status: 401 });
        throw new ApiError('Reláciu sa nepodarilo obnoviť – skontroluj pripojenie.', { kind: 'network' });
      }
      attempt--; // 401 sa nepočíta do sieťových pokusov
      continue;
    }

    if (res.ok) {
      if (responseType === 'none' || res.status === 204) return null;
      if (responseType === 'blob') return res.blob();
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    const err = toApiError(res.status, data);
    if (err.transient && attempt < retries) {
      await sleep(backoff(attempt, Number(res.headers.get('Retry-After')) || 0));
      continue;
    }
    throw err;
  }
}

function toApiError(status, data) {
  const code = data.code || data.error || '';
  let message = data.message || data.msg || data.error_description || `Chyba servera ${status}`;
  let kind = status === 401 ? 'auth' : 'http';
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883' ||
      /could not find the (function|table)/i.test(message)) {
    kind = 'schema';
    message = 'Databáza ešte nie je pripravená – v Supabase spusti supabase/02_migracia.sql.';
  } else if (code === '23514') {
    message = 'Server odmietol neplatné údaje (kontrola v databáze).';
  } else if (status === 403 || code === '42501') {
    message = 'Na túto akciu nemáš oprávnenie (pravidlá prístupu v databáze).';
  }
  return new ApiError(message, { kind, status, code, details: data });
}

export const rest = {
  select: (table, query) => request(`/rest/v1/${table}?${query}`),
  rpc: (fn, args, opt = {}) => request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args, ...opt }),
  upsert: (table, row, onConflict) => request(`/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST', body: row, headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  }),
};

export const storage = {
  upload: (bucket, path, blob) => request(`/storage/v1/object/${bucket}/${path}`, {
    method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true', 'cache-control': '31536000' },
    timeout: 60000, retries: 1,
  }),
  download: (bucket, path) => request(`/storage/v1/object/authenticated/${bucket}/${path}`, { responseType: 'blob', timeout: 45000 }),
  remove: (bucket, paths) => request(`/storage/v1/object/${bucket}`, { method: 'DELETE', body: { prefixes: paths }, responseType: 'none' }),
};
