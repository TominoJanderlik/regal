// Regál – service worker
// • HTML: najprv sieť (s časovým limitom), pri výpadku kópia z cache
// • JS/CSS/fonty: z cache AKTUÁLNEJ verzie; nová verzia = nový názov cache → staré súbory sa zmažú
// • API Supabase a iné domény sa NIKDY necachujú
// • nová verzia sa aktivuje po potvrdení používateľom (banner „Obnoviť teraz“) alebo po zavretí všetkých kariet
const VERSION = '1.0.4';
const CACHE = `regal-${VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/auth.js', 'js/config.js', 'js/geometry.js', 'js/idb.js',
  'js/importer.js', 'js/map.js', 'js/scanner.js', 'js/store.js', 'js/tracking.js', 'js/video.js',
  'vendor/zxing-0.21.3.min.js', 'img/pracovisko.jpg',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-ext-400-normal.woff2',
  'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-ext-500-normal.woff2',
  'fonts/barlow-latin-600-normal.woff2', 'fonts/barlow-latin-ext-600-normal.woff2',
  'fonts/barlow-latin-700-normal.woff2', 'fonts/barlow-latin-ext-700-normal.woff2',
  'fonts/barlow-semi-condensed-latin-600-normal.woff2', 'fonts/barlow-semi-condensed-latin-ext-600-normal.woff2',
  'fonts/barlow-semi-condensed-latin-700-normal.woff2', 'fonts/barlow-semi-condensed-latin-ext-700-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  // bez skipWaiting – prepnutie riadi aplikácia, aby sa nemiešali staré a nové súbory
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('regal-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Supabase, CDN → priamo do siete

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await Promise.race([fetch(req, { cache: 'no-store' }), timeout(4000)]);
        if (res.ok) (await caches.open(CACHE)).put('index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('index.html', { cacheName: CACHE })) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { cacheName: CACHE, ignoreSearch: true });
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
